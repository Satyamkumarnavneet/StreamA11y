"""Analyze StreamA11y results for the seeded fixtures, the generated corpus, and the repair study.
Recomputes summary.json and CSV tables into a separate output directory.
Run from the repository root: python3 analysis/analyze.py --out results/recomputed
"""
import argparse, json, math
from pathlib import Path
import pandas as pd
from scipy.stats import fisher_exact, binomtest

ROOT = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--results-dir',type=Path,default=ROOT/'results')
parser.add_argument('--out',type=Path,default=ROOT/'results/recomputed')
args=parser.parse_args(); RESULTS=args.results_dir.resolve(); OUT=args.out.resolve(); OUT.mkdir(parents=True,exist_ok=True)
FAM = ['silent-start', 'silent-terminal', 'announcement-overload', 'focus-lost', 'stop-unreachable',
       'partial-lost', 'stale-leak', 'busy-stuck']
GEN = {'haiku-4-5': '4.5', 'opus-4-5': '4.5', 'haiku-5-5': '5.5', 'sonnet-5-5': '5.5', 'opus-5-5': '5.5'}


def wilson(k, n, z=1.96):
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def load(folder, parse_id):
    rows = []
    for f in sorted((RESULTS / folder.removeprefix('results/')).glob('*.json')):
        d = json.loads(f.read_text())
        a = d['assessment']
        focus = a['checks'].get('focus-lost', {'fail': False, 'details': []})
        reasons = sorted({x.get('reason') for x in focus['details']}) if focus['fail'] else []
        row = dict(id=f.stem, compatible=a['compatible'], failures=a['failures'], functional=a['functional'],
                   A=a['metrics'].get('A'), axe_wcag=a['axe']['wcag'], axe_all=a['axe']['all'],
                   focus_reasons=reasons, notes=a['incompatibleNotes'])
        row.update(parse_id(f.stem))
        for k in FAM:
            row[k] = k in a['failures']
        # Sensitivity: an engine that keeps focus on a disabled button (Firefox-like) would not report
        # focus loss caused only by self-disabling controls.
        row['focus-lost-lenient'] = bool(focus['fail']) and any(r != 'disabled' for r in reasons)
        lenient = [k for k in a['failures'] if k != 'focus-lost'] + (['focus-lost'] if row['focus-lost-lenient'] else [])
        row['any'] = len(a['failures']) > 0
        row['any_lenient'] = len(lenient) > 0
        row['n_fail'] = len(a['failures'])
        row['axe_wcag_clean'] = len(a['axe']['wcag']) == 0
        rows.append(row)
    return pd.DataFrame(rows)


def corpus_id(s):
    m, c, smp = s.split('__')
    return dict(model=m, cond=c, sample=smp, gen=GEN[m])


def rate(sub, col):
    k, n = int(sub[col].sum()), len(sub)
    return {'k': k, 'n': n, 'p': round(k / n, 4) if n else None, 'ci95': wilson(k, n)}


def fisher_tab(ga, gb, col):
    t = [[int(ga[col].sum()), len(ga) - int(ga[col].sum())], [int(gb[col].sum()), len(gb) - int(gb[col].sum())]]
    o, p = fisher_exact(t)
    return {'table': t, 'odds_ratio': None if not math.isfinite(float(o)) else round(float(o), 3), 'p': float(f'{p:.3g}')}


summary = {}

# ---------- Seeded fixtures (oracle validation) ----------
fx = load('results/variants', lambda s: dict(variant=s))
expected = {'reference': [], 'token-live': ['announcement-overload'], 'no-start-status': ['silent-start'],
            'no-terminal-status': ['silent-terminal'], 'focus-drop': ['focus-lost'], 'focus-steal': ['focus-lost'],
            'discard-partial': ['partial-lost'], 'stale-leak': ['stale-leak'], 'busy-stuck': ['busy-stuck'],
            'stop-unreachable': ['stop-unreachable'], 'unlabeled-input': []}
fx_rows = []
for _, r in fx.iterrows():
    exp = expected[r.variant]
    fx_rows.append(dict(variant=r.variant, expected=exp, observed=r.failures, exact=sorted(exp) == sorted(r.failures),
                        axe_wcag=r.axe_wcag, A=r.A))
summary['fixtures'] = {'n': len(fx_rows), 'exact_matches': sum(x['exact'] for x in fx_rows), 'rows': fx_rows,
                       'lifecycle_faults_flagged_by_axe': sum(1 for x in fx_rows if x['expected'] and x['axe_wcag'])}

# ---------- Generated corpus ----------
df = load('results/corpus', corpus_id)
man = json.loads((ROOT / 'corpus/generation_manifest.json').read_text())
summary['corpus_generation'] = {
    'requested': len(man['records']), 'ok': sum(r['status'] == 'ok' for r in man['records']),
    'output_tokens_median': float(pd.Series([r['output_tokens'] for r in man['records']]).median()),
    'html_chars_median': float(pd.Series([r['html_chars'] for r in man['records']]).median()),
    'models': sorted({r['model_requested'] for r in man['records']}),
    'excluded_model': 'claude-sonnet-4-5-20250929 (API returned a safety-filter refusal on both pilot attempts; no output)'}
incompatible = df[~df.compatible]
summary['corpus_incompatible'] = [{'id': r.id, 'notes': sorted(set(r.notes))} for _, r in incompatible.iterrows()]
ok = df[df.compatible].copy()
summary['corpus_n_assessed'] = len(ok)
summary['functional'] = {
    'regenerate_broken': int(ok.functional.apply(lambda L: 'regenerate-broken' in L).sum()),
    'stop_broken': int(ok.functional.apply(lambda L: 'stop-broken' in L).sum()),
    'any_functional': int((ok.functional.apply(len) > 0).sum()),
    'regenerate_broken_ids': ok[ok.functional.apply(lambda L: 'regenerate-broken' in L)].id.tolist(),
    'send_never_enabled_excluded': len(incompatible)}

cols = FAM + ['any', 'any_lenient', 'focus-lost-lenient', 'axe_wcag_clean']
summary['overall'] = {c: rate(ok, c) for c in cols}
summary['by_condition'] = {cond: {c: rate(g, c) for c in cols} for cond, g in ok.groupby('cond')}
summary['by_model'] = {m: {c: rate(g, c) for c in cols} for m, g in ok.groupby('model')}
summary['by_generation'] = {gname: {c: rate(g, c) for c in cols} for gname, g in ok.groupby('gen')}
summary['by_model_condition'] = {f'{m}|{c}': {k: rate(g, k) for k in ['any', 'any_lenient', 'focus-lost', 'announcement-overload', 'stale-leak', 'silent-start', 'silent-terminal']}
                                 for (m, c), g in ok.groupby(['model', 'cond'])}
summary['by_generation_condition'] = {f'{gn}|{c}': {k: rate(g, k) for k in ['any', 'any_lenient']} for (gn, c), g in ok.groupby(['gen', 'cond'])}

# Concealment: final-state WCAG audit passes yet a lifecycle check fails.
clean = ok[ok.axe_wcag_clean]
summary['concealment'] = {'axe_wcag_clean': len(clean), 'of': len(ok),
                          'clean_with_lifecycle_failure': rate(clean, 'any'),
                          'clean_with_lifecycle_failure_lenient': rate(clean, 'any_lenient')}
summary['axe_rules_seen'] = pd.Series([x for L in ok.axe_all for x in L], dtype=object).value_counts().to_dict()

summary['tests'] = {}
for a, b in [('C0_plain', 'C1_accessible'), ('C1_accessible', 'C2_lifecycle'), ('C0_plain', 'C2_lifecycle')]:
    for col in ['any', 'any_lenient', 'focus-lost', 'announcement-overload', 'stale-leak', 'silent-start', 'silent-terminal']:
        summary['tests'][f'{a}_vs_{b}_{col}'] = fisher_tab(ok[ok.cond == a], ok[ok.cond == b], col)
for col in ['any', 'any_lenient']:
    summary['tests'][f'gen45_vs_gen55_{col}'] = fisher_tab(ok[ok.gen == '4.5'], ok[ok.gen == '5.5'], col)
    summary['tests'][f'gen45_vs_gen55_C1C2_{col}'] = fisher_tab(ok[(ok.gen == '4.5') & (ok.cond != 'C0_plain')], ok[(ok.gen == '5.5') & (ok.cond != 'C0_plain')], col)

def newcombe(k1, n1, k2, n2):
    """Risk difference p1 - p2 with Newcombe's hybrid score 95% interval (Wilson-based)."""
    l1, u1 = wilson(k1, n1); l2, u2 = wilson(k2, n2)
    p1, p2 = k1 / n1, k2 / n2
    d = p1 - p2
    lo = d - math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)
    hi = d + math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2)
    return {'diff': round(d, 4), 'ci95': [round(lo, 4), round(hi, 4)]}


def diff_for(ga, gb, col):
    return {'a': [int(ga[col].sum()), len(ga)], 'b': [int(gb[col].sum()), len(gb)], **newcombe(int(ga[col].sum()), len(ga), int(gb[col].sum()), len(gb))}


c0, c1, c2 = (ok[ok.cond == c] for c in ['C0_plain', 'C1_accessible', 'C2_lifecycle'])
g45, g55 = ok[(ok.gen == '4.5') & (ok.cond != 'C0_plain')], ok[(ok.gen == '5.5') & (ok.cond != 'C0_plain')]
summary['differences'] = {'plain_minus_accessible_any': diff_for(c0, c1, 'any'), 'accessible_minus_lifecycle_any': diff_for(c1, c2, 'any'),
                          'accessible_minus_lifecycle_overload': diff_for(c1, c2, 'announcement-overload'),
                          'gen45_minus_gen55_accessible_prompts_any': diff_for(g45, g55, 'any'),
                          'plain_minus_accessible_any_lenient': diff_for(c0, c1, 'any_lenient')}
# What the conservative count excludes: interfaces whose ONLY failure is focus loss caused by a disabled control
only_disabled = ok[ok['any'] & ~ok['any_lenient']]
summary['conservative'] = {'strict': int(ok['any'].sum()), 'conservative': int(ok['any_lenient'].sum()), 'excluded_only_disabled_focus': len(only_disabled),
                           'focus_loss_strict': int(ok['focus-lost'].sum()), 'focus_loss_conservative': int(ok['focus-lost-lenient'].sum())}
assert summary['conservative']['strict'] - summary['conservative']['conservative'] == len(only_disabled)

# Focus-loss mechanisms (number of implementations showing each reason)
summary['focus_reasons_impl_counts'] = pd.Series([r for L in ok[ok['focus-lost']].focus_reasons for r in L], dtype=object).value_counts().to_dict()
summary['A'] = {'n_with_content_announcements': int((ok.A > 0).sum()),
                'max': round(float(ok.A.max()), 3),
                'median_over2': round(float(ok.A[ok.A > 2].median()), 3) if (ok.A > 2).any() else None,
                'over2_by_cond': {c: int((g.A > 2).sum()) for c, g in ok.groupby('cond')},
                'threshold_sensitivity': {str(t): int((ok.A > t).sum()) for t in [1.0, 1.5, 2.0, 3.0, 5.0]}}
av = ok.A.dropna()
summary['A']['values'] = {'n_zero': int((av == 0).sum()), 'n_between_0_and_2': int(((av > 0) & (av <= 2)).sum()), 'min_over2': round(float(av[av > 2].min()), 3), 'max_at_most2': round(float(av[av <= 2].max()), 3), 'n_over2': int((av > 2).sum()),
                       'n_exactly_1': int((av.round(6) == 1.0).sum())}
summary['n_fail_distribution'] = {str(k): int(v) for k, v in ok.n_fail.value_counts().sort_index().items()}
ok.drop(columns=['notes']).to_csv(OUT / 'corpus_table.csv', index=False)

# ---------- Repair study ----------
rp_dir = RESULTS / 'repaired'
if rp_dir.exists() and any(rp_dir.glob('*.json')):
    def rid(s):
        src, fb = s.rsplit('__', 1)
        m, c, smp = src.split('__')
        return dict(source=src, feedback=fb, model=m, cond=c, gen=GEN[m])
    rp = load('results/repaired', rid)
    base = ok.set_index('id')
    rp = rp[rp.source.isin(base.index)].copy()
    rp['before_n'] = rp.source.map(lambda s: int(base.loc[s, 'n_fail']))
    rp['new_families'] = [len(set(r.failures) - set(base.loc[r.source, 'failures'])) for _, r in rp.iterrows()]
    rp['broke_function'] = [len(set(r.functional) - set(base.loc[r.source, 'functional'])) > 0 for _, r in rp.iterrows()]
    out = {}
    for fb, g in rp.groupby('feedback'):
        gc = g[g.compatible]
        out[fb] = {'n': len(g), 'compatible': len(gc), 'still_any': rate(gc, 'any'), 'still_any_lenient': rate(gc, 'any_lenient'),
                   'fixed_all': int((~gc['any']).sum()), 'families_before_total': int(gc.before_n.sum()),
                   'families_after_total': int(gc.n_fail.sum()),
                   'introduced_new_family': int((gc.new_families > 0).sum()), 'axe_wcag_regressions': int((~gc.axe_wcag_clean).sum()),
                   'broke_function': int(gc.broke_function.sum()), 'functional_after': int((gc.functional.apply(len) > 0).sum()),
                   'per_family_after': {k: int(gc[k].sum()) for k in FAM},
                   'by_gen': {gn: rate(gg, 'any') for gn, gg in gc.groupby('gen')}}
    pv = rp[rp.compatible].pivot_table(index='source', columns='feedback', values='any', aggfunc='first').dropna()
    if {'generic', 'streama11y'} <= set(pv.columns):
        b = int(((pv.generic == True) & (pv.streama11y == False)).sum())
        c = int(((pv.generic == False) & (pv.streama11y == True)).sum())
        out['paired'] = {'pairs': len(pv), 'fixed_only_by_streama11y': b, 'fixed_only_by_generic': c,
                         'both_fixed': int(((pv.generic == False) & (pv.streama11y == False)).sum()),
                         'neither_fixed': int(((pv.generic == True) & (pv.streama11y == True)).sum()),
                         'mcnemar_exact_p': float(f'{binomtest(b, b + c, 0.5).pvalue:.3g}') if b + c else None}
    from scipy.stats import wilcoxon
    nf = rp[rp.compatible].pivot_table(index='source', columns='feedback', values='n_fail', aggfunc='first').dropna()
    w = wilcoxon(nf.generic, nf.streama11y, zero_method='wilcox')
    out['paired_families'] = {'pairs': len(nf), 'generic_total': int(nf.generic.sum()), 'streama11y_total': int(nf.streama11y.sum()),
                              'streama11y_fewer': int((nf.streama11y < nf.generic).sum()), 'generic_fewer': int((nf.generic < nf.streama11y).sum()),
                              'ties': int((nf.generic == nf.streama11y).sum()), 'wilcoxon_p': float(f'{w.pvalue:.3g}')}
    out['families_by_gen'] = {gn: {fb: int(gg[gg.feedback == fb].n_fail.sum()) for fb in ['generic', 'streama11y']} | {'before': int(gg[gg.feedback == 'generic'].before_n.sum())}
                              for gn, gg in rp[rp.compatible].groupby('gen')}
    out['incompatible'] = [{'id': r.id, 'notes': sorted(set(r.notes))[:2]} for _, r in rp[~rp.compatible].iterrows()]
    summary['repair'] = out
    rp.drop(columns=['notes']).to_csv(OUT / 'repair_table.csv', index=False)

(OUT / 'summary.json').write_text(json.dumps(summary, indent=1, default=str, allow_nan=False))
print(json.dumps({k: summary[k] for k in ['corpus_n_assessed', 'functional', 'concealment', 'focus_reasons_impl_counts', 'n_fail_distribution', 'corpus_incompatible']}, indent=1, default=str, allow_nan=False))
print('fixtures exact', summary['fixtures']['exact_matches'], '/', summary['fixtures']['n'], 'axe flagged lifecycle faults:', summary['fixtures']['lifecycle_faults_flagged_by_axe'])
for c, v in summary['by_condition'].items():
    print(c, {k: (v[k]['k'], v[k]['n']) for k in ['any', 'any_lenient', 'focus-lost', 'announcement-overload', 'stale-leak', 'silent-start', 'silent-terminal', 'partial-lost']})
for g, v in summary['by_generation_condition'].items():
    print(g, {k: (v[k]['k'], v[k]['n']) for k in ['any', 'any_lenient']})
print({k: v['p'] for k, v in summary['tests'].items()})
print(summary['A'])
if 'repair' in summary:
    print(json.dumps(summary['repair'], indent=1, default=str, allow_nan=False)[:3000])
