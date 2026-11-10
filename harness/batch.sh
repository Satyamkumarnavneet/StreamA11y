#!/usr/bin/env bash
# Re-run protocol-compatible HTML files with four concurrent jsdom processes.
set -euo pipefail
if [[ $# -ne 2 ]]; then echo 'Usage: bash harness/batch.sh INPUT_DIR OUTPUT_DIR' >&2; exit 2; fi
IN="$1"; OUT="$2"
mkdir -p "$OUT"
find "$IN" -maxdepth 1 -type f -name '*.html' -print0 | xargs -0 -P 4 -I{} perl -e 'alarm 300; exec @ARGV' node harness/run.js '{}' --out="$OUT" > "$OUT/_console.jsonl" 2> "$OUT/_stderr.txt"
python3 - "$IN" "$OUT" <<'PY'
from pathlib import Path
import sys
expected={p.stem for p in Path(sys.argv[1]).glob('*.html')}
observed={p.stem for p in Path(sys.argv[2]).glob('*.json') if not p.name.startswith('_')}
if not expected or observed!=expected:raise SystemExit('Incomplete or unexpected result IDs')
print(f'Completed {len(observed)} result files; inspect execution and contract outcomes separately.')
PY
