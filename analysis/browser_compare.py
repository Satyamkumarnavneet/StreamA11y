"""Compare real-browser StreamA11y results with the jsdom results.
Usage (from lifecycle/):  python analysis/browser_compare.py results/browser results/corpus
Reads <browser_dir>/<engine>/*.json (written by harness/browser.js) and <jsdom_dir>/*.json.
Writes results/browser_summary.json and prints a table. Nothing here is a screen reader measurement.
"""
import argparse, json
from pathlib import Path

FAM = ['silent-start', 'silent-terminal', 'announcement-overload', 'focus-lost', 'stop-unreachable', 'partial-lost', 'stale-leak', 'busy-stuck']
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('browser_dir',type=Path);parser.add_argument('jsdom_dir',type=Path)
parser.add_argument('--out',type=Path,default=Path('results/recomputed/browser_summary.json'))
args=parser.parse_args();bdir,jdir=args.browser_dir,args.jsdom_dir
out = {}
for edir in sorted(p for p in bdir.iterdir() if p.is_dir()):
    rows = []
    for f in sorted(edir.glob('*.json')):
        j = jdir / f.name
        if not j.exists():
            continue
        b = json.loads(f.read_text()); a = json.loads(j.read_text())
        ab, aj = b['assessment'], a['assessment']
        engine_lost = any(x.get('engineLost') for r in b['runs'].values() for x in r.get('focusLog', []))
        rule_lost = 'focus-lost' in ab['failures']
        rows.append(dict(file=f.stem, compatible_browser=ab['compatible'], compatible_jsdom=aj['compatible'],
                         fail_b=ab['failures'], fail_j=aj['failures'], same=ab['failures'] == aj['failures'],
                         A_b=ab['metrics'].get('A'), A_j=aj['metrics'].get('A'),
                         engine_lost=engine_lost, rule_lost=rule_lost, jsdom_lost=('focus-lost' in aj['failures']),
                         axe_b=ab['axe']['wcag'], axe_j=aj['axe']['wcag']))
    n = len(rows)
    both = [r for r in rows if r['compatible_browser'] and r['compatible_jsdom']]
    per = {}
    for k in FAM:
        tp = sum(1 for r in both if k in r['fail_b'] and k in r['fail_j'])
        fn = sum(1 for r in both if k in r['fail_j'] and k not in r['fail_b'])
        fp = sum(1 for r in both if k in r['fail_b'] and k not in r['fail_j'])
        per[k] = dict(both=tp, only_jsdom=fn, only_browser=fp)
    out[edir.name] = dict(n=n, compared=len(both), identical_failure_sets=sum(r['same'] for r in both),
                          browser_any=sum(1 for r in both if r['fail_b']), jsdom_any=sum(1 for r in both if r['fail_j']),
                          focus_engine_raw_lost=sum(r['engine_lost'] for r in both), focus_rule_lost=sum(r['rule_lost'] for r in both),
                          focus_jsdom_lost=sum(r['jsdom_lost'] for r in both), per_check=per,
                          disagreements=[dict(file=r['file'], browser=r['fail_b'], jsdom=r['fail_j']) for r in both if not r['same']][:50])
args.out.parent.mkdir(parents=True,exist_ok=True)
args.out.write_text(json.dumps(out, indent=1))
for e, v in out.items():
    print(f"{e}: {v['compared']}/{v['n']} compared; identical failure sets {v['identical_failure_sets']}; any-failure browser {v['browser_any']} vs jsdom {v['jsdom_any']}; "
          f"focus lost: engine raw {v['focus_engine_raw_lost']}, rule-applied {v['focus_rule_lost']}, jsdom {v['focus_jsdom_lost']}")
    for k, d in v['per_check'].items():
        if d['only_jsdom'] or d['only_browser']:
            print('   ', k, d)
