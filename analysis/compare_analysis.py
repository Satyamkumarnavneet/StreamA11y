"""Compare recomputed summary/tables with released reference artifacts."""
from pathlib import Path
import argparse,csv,json,math
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);args=p.parse_args()
def equal(a,b,where='root'):
 if isinstance(a,dict):
  assert isinstance(b,dict) and a.keys()==b.keys(),where
  for k in a:equal(a[k],b[k],where+'.'+k)
 elif isinstance(a,list):
  assert isinstance(b,list) and len(a)==len(b),where
  for i,(x,y) in enumerate(zip(a,b)):equal(x,y,where+'['+str(i)+']')
 elif type(a) in [int,float] and type(b) in [int,float]:assert math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-12),(where,a,b)
 else:assert a==b,(where,a,b)
equal(json.loads((ROOT/'results/summary.json').read_text()),json.loads((args.directory/'summary.json').read_text()))
for name in ['corpus_table.csv','repair_table.csv']:
 with (ROOT/'results'/name).open() as f:baseline=list(csv.DictReader(f))
 with (args.directory/name).open() as f:actual=list(csv.DictReader(f))
 equal(baseline,actual,name)
print('Recomputed summary and both CSV tables match released values.')
