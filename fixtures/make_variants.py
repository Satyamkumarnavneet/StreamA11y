"""Build the reference chat UI and single-fault variants from fixtures/template.html."""
from pathlib import Path
root = Path(__file__).parent
t = (root / 'template.html').read_text()
STOP = '<button id="stop" type="button" aria-disabled="true">Stop</button>'
faults = ['none', 'token-live', 'no-start-status', 'no-terminal-status', 'focus-drop', 'focus-steal',
          'discard-partial', 'stale-leak', 'busy-stuck', 'stop-unreachable', 'unlabeled-input']
out = root / 'variants'; out.mkdir(exist_ok=True)
for f in faults:
    h = t.replace('__FAULT__', f).replace('__STATUS_ROLE__', 'role="status"').replace('__LABEL_ATTR__', '')
    h = h.replace('__STOP_CONTROL__', '<div id="stop" class="btn" aria-disabled="true">Stop</div>' if f == 'stop-unreachable' else STOP)
    if f == 'unlabeled-input':
        h = h.replace('<label for="prompt" >Message</label>', '<span>Message</span>')
        assert '<span>Message</span>' in h
    name = 'reference' if f == 'none' else f
    (out / f'{name}.html').write_text(h)
print(len(faults), 'files')
