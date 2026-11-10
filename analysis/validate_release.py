"""Validate the public benchmark inventory, data links and stored result consistency.
Python standard library only; does not run browsers or authenticate collection origins.
"""
from pathlib import Path,PurePosixPath
from collections import Counter
import hashlib,json,math,re
ROOT=Path(__file__).resolve().parents[1]
ENGINES=['chromium','firefox','webkit'];SCENARIOS={'complete','stop','regenerate','race','error'}
def load(path):return json.loads(path.read_text(),parse_constant=lambda value:(_ for _ in ()).throw(ValueError('Non-standard JSON constant '+value)))
def check(test,message):
 if not test:raise ValueError(message)
def hashes():
 manifest=ROOT/'SHA256SUMS';check(manifest.exists(),'Missing SHA256SUMS')
 for line in manifest.read_text().splitlines():
  digest,name=line.split('  ',1);rel=PurePosixPath(name)
  check(not rel.is_absolute() and '..' not in rel.parts,'Unsafe manifest path')
  check(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest,'Hash mismatch: '+name)
 return len(manifest.read_text().splitlines())
def records(folder,ids):
 paths={p.stem:p for p in folder.glob('*.json') if not p.name.startswith('_')};check(set(paths)==set(ids),'Unexpected IDs in '+str(folder.relative_to(ROOT)))
 rows={k:load(p) for k,p in paths.items()}
 for ident,r in rows.items():
  check(set(r['runs'])==SCENARIOS,'Scenario coverage: '+ident)
  check(isinstance(r['assessment']['failures'],list),'Missing failure list')
 return rows

def main():
 count=hashes()
 # Reject accidental publication of draft/build artifacts, environments and credentials.
 for p in ROOT.rglob('*'):
  rel=p.relative_to(ROOT)
  if any(part in {'.git','node_modules','.venv','__pycache__'} for part in rel.parts) or rel.parts[:2]==('results','recomputed'):continue
  if p.is_file():
   check(p.suffix.lower() not in {'.tex','.bib','.pdf','.aux','.log','.fls','.fdb_latexmk'},'Unexpected build/document artifact: '+str(rel))
   check(p.name not in {'.env','.DS_Store'} and not p.name.endswith('.private.txt'),'Unexpected private file')
   if p.suffix=='.json':load(p)
 generated=load(ROOT/'corpus/generation_manifest.json')['records'];repaired=load(ROOT/'corpus/repair_manifest.json')['records']
 check(len(generated)==90 and len(repaired)==60,'Unexpected corpus counts')
 ids={r['id'] for r in generated};repairids={r['id'] for r in repaired};check(len(ids)==90 and len(repairids)==60,'Duplicate identifiers')
 grid=Counter((r['model_requested'],r['condition']) for r in generated)
 check(len(grid)==15 and set(grid.values())=={6},'Model/condition grid differs')
 for name,rows in [('generated',generated),('repaired',repaired)]:
  folder=ROOT/'corpus'/name
  check({p.stem for p in folder.glob('*.html')}=={r['id'] for r in rows},'HTML coverage '+name)
  check({p.name.removesuffix('.raw.txt') for p in folder.glob('*.raw.txt')}=={r['id'] for r in rows},'Reply-text coverage '+name)
  for r in rows:check(hashlib.sha256((folder/(r['id']+'.html')).read_bytes()).hexdigest()==r['sha256'],'Source hash '+r['id'])
 check(Counter(r['feedback'] for r in repaired)=={'generic':30,'streama11y':30},'Repair conditions')
 check(len({r['source'] for r in repaired})==30 and all(r['source'] in ids for r in repaired),'Repair pair source linkage')
 base=records(ROOT/'results/corpus',ids);rerun=records(ROOT/'results/corpus_rerun',ids);repair=records(ROOT/'results/repaired',repairids)
 fixtureids={p.stem for p in (ROOT/'fixtures/variants').glob('*.html')};check(len(fixtureids)==11,'Fixture count');fixtures=records(ROOT/'results/variants',fixtureids)
 compatible={i for i,r in base.items() if r['assessment']['compatible']};check(len(compatible)==89,'Compatibility denominator')
 check(ids-compatible=={'opus-4-5__C1_accessible__s0'},'Compatibility exclusion')
 check(all(base[i]['assessment']==rerun[i]['assessment'] for i in ids),'Rerun assessment mismatch')
 summary=load(ROOT/'results/summary.json');check(summary['overall']['any']['n']==89,'Summary denominator')
 check(summary['overall']['any']['k']==sum(bool(base[i]['assessment']['failures']) for i in compatible)==53,'Summary failure count')
 check(summary['fixtures']['n']==summary['fixtures']['exact_matches']==11,'Fixture summary')
 contrast_counts={};total=90+90+60+11
 for engine in ENGINES:
  for group,expected,reference in [('browser',ids,base),('browser-fixtures',fixtureids,fixtures),('browser-repaired',repairids,repair),('browser-contrast',ids,base)]:
   rows=records(ROOT/'results'/group/engine,expected);total+=len(rows)
   for ident,r in rows.items():
    check(r.get('engine')==engine,'Engine mismatch')
    check(r['assessment']['failures']==reference[ident]['assessment']['failures'],'Browser/jsdom failure disagreement')
    check(r['assessment']['metrics'].get('A')==reference[ident]['assessment']['metrics'].get('A'),'Browser/jsdom proxy disagreement')
   if group=='browser-contrast':
    per={ident:{v['id'] for run in rows[ident]['runs'].values() for v in (run.get('axeWithContrast') or []) if any(t.startswith('wcag') for t in v.get('tags',[]))} for ident in compatible}
    check(all(not rules or rules=={'color-contrast'} for rules in per.values()),'Unexpected WCAG contrast rule')
    contrast_counts[engine]=sum(bool(v) for v in per.values());check(contrast_counts[engine]==47,'Contrast count')
 check(total==1004,'Stored assessment inventory')
 check(load(ROOT/'package.json')['license']=='MIT','Package/license inconsistency')
 print(json.dumps({'status':'passed','checksummed_files':count,'generated_interfaces':90,'analyzed_interfaces':89,'repairs':60,'fixtures':11,'stored_assessments':total,'contrast_findings_per_engine':contrast_counts,'browser_experiments_rerun':0,'AT_captures':0,'scope':'Inventory/hash/schema/relationship/stored-log consistency only; use replay:assessments and analyze for recomputation'},indent=2))
if __name__=='__main__':main()
