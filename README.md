# StreamA11y

StreamA11y tests accessibility-related behavior across streamed chat responses: generation, interruption, regeneration, late callbacks, and errors. It contains eight executable lifecycle checks, a scripted streaming API, five scenarios, eleven seeded calibration pages, and a corpus of generated and repaired interfaces.

The harness supports **protocol-compatible, self-contained HTML chat pages** using the supplied `ChatSDK.streamChat` API and required control IDs. It records modeled live-region submissions, DOM focus, and transcript state. It does not record screen-reader speech or establish WCAG conformance.

## Dataset at a glance

- **90 generated interfaces:** five recorded Claude model IDs × three prompt conditions × six samples, using one shared task brief. HTML files and raw returned text are included.
- **89 analyzed interfaces:** one output cannot start generation and is retained as incompatible.
- **60 repair outputs:** the same 30 Plain interfaces repaired under generic feedback and StreamA11y feedback.
- **11 fixtures:** a reference, nine lifecycle-fault variants spanning eight check families (focus loss has two: `focus-drop` and `focus-steal`), and one static missing-label variant.
- **Five scenarios:** completion, Stop after four chunks, completed regeneration, Stop/Regenerate with a late old chunk, and a network error after four chunks.

In the included results, 53 of 89 compatible originals fail at least one strict lifecycle check. A separate contrast-enabled audit flags color contrast in 47 of 89. Chromium, Firefox, and WebKit agree on the recorded lifecycle failure sets; this does not establish agreement among assistive technologies. See the [benchmark card](BENCHMARK_CARD.md) for definitions, exclusions, and provenance.

## Contents

| Path | Contents |
|---|---|
| `spec/prompts.json` | Exact shared brief and Plain, Accessible, and Lifecycle prompt conditions |
| `harness/` | jsdom and browser drivers, streaming API, live-region model, focus/transcript checks, and batch runner |
| `fixtures/` | Reference, mutation generator, and eleven calibration pages |
| `corpus/generated/` | Ninety generated HTML files and raw returned text |
| `corpus/repaired/` | Sixty repair HTML files and raw returned text |
| `corpus/generation_manifest.json` | Requested/returned model IDs, condition, sample, tokens, and HTML hashes |
| `corpus/repair_prompts.json`, `corpus/repair_manifest.json` | Exact repair feedback and output metadata |
| `results/` | Included reference logs, summaries, comparison tables, and repeatability results |
| `analysis/` | Integrity validation, assessment replay, statistical aggregation, and browser comparison |

Raw returned text is not a complete provider request/response JSON archive. The manifests do not record every historical API error body or capture-time harness hash. Current release hashes establish the packaged state, not which code was running at an earlier time.

## Validate and replay the included data

Use Node.js 20 or later and Python 3.12. No model API account is needed to evaluate the stored corpus.

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
npm test
npm run replay:assessments
npm run analyze
```

`npm test` validates the release with Python's standard library. Assessment replay recomputes checks from stored traces; it does not execute the interfaces again. Analysis recomputes statistics from the included logs and writes to `results/recomputed/`.

## Run the interfaces again

The following commands execute the UI code under test. New results are written under `results/recomputed/`, separate from the included reference logs.

```sh
npm run fixtures
npm run jsdom:fixtures
npm run jsdom:corpus
npm run jsdom:repairs
```

For real-browser runs, install Playwright's browser binaries on a host that permits browser processes:

```sh
npx playwright install chromium firefox webkit
npm run browser:fixtures
npm run browser:corpus
npm run browser:repairs
npm run browser:contrast
python3 analysis/browser_compare.py results/recomputed/browser results/recomputed/corpus --out results/recomputed/browser_summary.json
```

Browser runs are resumable: existing output files are skipped unless `--force` is passed to `harness/browser.js`. Use an empty output folder or `--force` when you intend a fresh run. Dependencies, browsers, operating system, and timing can affect a rerun; preserve the resulting run metadata.

The recorded environment used Playwright 1.65.0, Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2, and macOS. Exact npm dependencies are recorded in the lockfile. Running a different installed browser build is a new configuration.

## Reading the audit results

The baseline `assessment.axe` field **excludes color contrast**. In contrast-enabled logs, additional results are stored in `runs[scenario].axeWithContrast`; they are not merged into `assessment.axe`. Among compatible originals, baseline WCAG-tagged findings are empty, while the contrast-enabled run flags color contrast in 47 of 89 in each engine. Best-practice findings are separate. Repairs were not contrast-checked.

Lifecycle findings are configured diagnostics. The candidate-volume cutoff is not a validated human-overload threshold, DOM focus is not an AT virtual cursor, and the transcript view is derived from the DOM. The strict and lenient focus analyses, functional failures, incompatible outputs, and missing observations must remain distinguishable.

## Scope and license

This corpus covers one task brief, one provider, standalone HTML, and fixed scripted content. It does not establish behavior in arbitrary deployed products, framework apps, other operating systems, real screen readers, or user tasks. Seeded fixtures calibrate authored checks; they are not independent expert labels.

The repository is distributed under the [MIT License](LICENSE). Dependencies retain their respective licenses. Re-generating or repairing interfaces requires separately configured provider access and is not performed by the evaluation commands above.
