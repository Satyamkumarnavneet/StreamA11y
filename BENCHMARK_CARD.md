# StreamA11y benchmark card

## Purpose

StreamA11y makes selected accessibility-related expectations testable during streamed chat responses. It supports regression testing and inspection of lifecycle traces. It does not certify an interface as accessible, measure actual AT speech, or estimate barriers across all conversational products.

## Supported interfaces and protocol

The current harness loads self-contained HTML with inline CSS and vanilla JavaScript. The page must provide `#prompt`, `#send`, `#stop`, and `#regenerate`, and call the injected `window.ChatSDK.streamChat(messages, {onToken, onDone, onError})`. Its handle exposes `abort()`. The protocol explicitly permits one in-flight token callback after abort; completion/error callbacks do not follow abort.

This is a controlled compatibility contract, not support for any chat interface. Arbitrary frameworks, real network transports, deployed services, and general selector adapters are outside the recorded evaluation.

## Composition and units

| Component | Included count |
|---|---:|
| Shared task briefs | 1 |
| Recorded model identifiers, one provider | 5 |
| Prompt conditions | 3 |
| Returned samples per model/condition | 6 |
| Generated HTML outputs | 90 |
| Compatible originals in contract analysis | 89 |
| Repair outputs | 60 |
| Paired repair baselines | 30 |
| Seeded calibration pages | 11 |
| Lifecycle failure-check families | 8 |
| Scripted scenarios per interface | 5 |

An implementation is the unit for corpus rates. Scenarios and browser engines are repeated measurements within it. Repairs are linked to their original implementation. Do not pool the 60 repairs, scenario runs, or browser repeats as independent generated baselines. The three conditions—Plain, Accessible, Lifecycle—share the same functional brief; Lifecycle explicitly names duties assessed by the harness.

## Collection and provenance

The generation manifest records November 9, 2026 and these requested/returned model IDs:

| Recorded identifier | Returned outputs |
|---|---:|
| `claude-haiku-4-5-20251001` | 18 |
| `claude-opus-4-5-20251101` | 18 |
| `claude-haiku-5-5` | 18 |
| `claude-sonnet-5-5` | 18 |
| `claude-opus-5-5` | 18 |

Sampling used provider defaults, no thinking parameter, and a 24,000-token output cap. Repairs used the source implementation's model, provider defaults, and a 28,000-token cap. The identifiers and metadata are reported as recorded; alias availability and defaults may change.

The successful-output manifest contains 38 first-attempt records and 52 `attempt=2` records. Its note reports that those retries followed usage-limit API errors with no returned output; no returned output was resampled. An excluded Sonnet 4.5 configuration is reported to have refused two pilot requests. Supporting raw request/error bodies for those pilot refusals are not included. Raw `.raw.txt` files contain returned model text, not full provider JSON. Aggregate generation timestamps do not specify a timezone, and capture-time harness hashes are not recorded; current checksums must not be presented as historical execution provenance.

## Checks and interpretation

| Check | Operational expectation |
|---|---|
| Silent start | A non-echo modeled submission occurs between activation and the first answer's terminal event; regeneration start is also checked |
| Silent terminal | A modeled submission occurs after an applicable completion, stop, or error event |
| Candidate-volume cutoff | The full-answer scenario's content-submission ratio A does not exceed 2 |
| Focus loss | At recorded checkpoints, focus is not lost to the body/unfocusable content or moved into the transcript |
| Unreachable Stop | During streaming, Stop is present, modeled as tabbable, and named |
| Lost partial answer | The recorded accepted prefix remains in the harness's DOM-derived transcript view after stop/error |
| Stale chunk leak | Marker content from a stopped stream does not appear in the final transcript view or subsequent modeled submissions |
| Stuck busy state | No recorded `aria-busy="true"` remains at termination |

The live-region interpreter applies selected `aria-live`, implicit live-role, atomic, relevant, hidden, and busy rules to DOM updates. Its output is **modeled live-region submission text**, not captured platform accessibility events or speech.

A counts lengths of lowercased ASCII words matching the fixed answer vocabulary, not every character in the DOM. The vocabulary keeps words longer than three letters from the scripted answers/late chunk; the denominator is the corresponding content-word length of the first answer. This largely separates ordinary status words from answer content, but it is a fixture-specific heuristic, not semantic status classification or a language-independent metric. A is measured only in the full-answer scenario; the cutoff is an engineering diagnostic, not a calibrated cognitive-load limit.

Strict focus checks use DOM focus and the harness's HTML focus-fixup policy. Browser capture also retains the engine's raw focus-loss observation and waits two animation frames after actions. The lenient analysis ignores loss caused only by disabling a control: strict any-failure count is 53/89; lenient any-failure count is 32/89; lenient focus findings remain in 8/89. These are policy variants, not alternative participant judgments. Controls are activated programmatically through focus/click; Stop naming/tabbability checks do not establish complete keyboard or AT navigation.


## Files and terms

The repository's [MIT License](LICENSE) is retained; third-party dependencies keep their own terms. No author review, independent validation, or additional capture is claimed merely because files are present in the release.
