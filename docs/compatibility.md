# Compatibility and verification

## V1 implementation — 2026-10-09

The user requested the whole extension after reviewing the Phase 0 blockers. Implementation has proceeded through the V1 feature and packaging phases, while retaining the native-only design and the observed Edge failure. This is not a claim that the original Chrome-and-Edge acceptance gate has passed.

The production selection surface is a visible extension tab shared with the popup UI. It can obtain user activation for new models and remains usable when the popup is closed. The production manifest has no offscreen permission or testing-only browser switches. An in-page overlay is not part of this build.

### Production browser checks

Tested the same production build in Chrome 155.0.8059.40 and Edge 154.0.4258.62 on the Mac described below. Earlier automated checks ran while the browser desktop was at the macOS login screen, so they drove extension documents through browser debugging. Later user-provided screenshots confirmed the actual toolbar popup's selection-prefill flow in both browsers, with automatic translation in Chrome and an activation prompt followed by a model-start failure in Edge. Native context-menu/keyboard interaction still needs manual verification.

| Check | Chrome | Edge |
| --- | --- | --- |
| Production manifest loads; installation warnings | Pass; none | Pass; none |
| Production popup document, actual detection and translation | English → Chinese and Chinese → English pass | Detection passes; translation service crashes |
| Additional source languages → Chinese | Japanese, French, German, Spanish, Korean samples pass | Not claimed; native engine remains blocked |
| Settings persist primary/secondary/rate and update open documents | Pass | Pass |
| Saved English/Japanese settings reroute English → Japanese; transient Traditional Chinese target leaves settings unchanged | Pass with native output | Routing logic tested; native inference blocked |
| Same-language settings rejected | Pass | Pass |
| Short text requires confirmation and focuses source selector | Pass | Pass |
| Source override changes target direction | Pass | Direction changes; native model still fails |
| Production selection document consumes a tab-bound session handoff once | Pass; translated with popup closed | Pass; shows activation/model error |
| Handoff text removed from session storage and token removed from URL | Pass | Pass |
| Source Listen/Stop controls | Local speech starts; stop returns to Listen and isSpeaking=false | Same |
| Translation Listen/Stop controls | Local speech starts/stops | No native result available; speech engine tested separately in Phase 0 |
| Visible controls have accessible names | Browser accessibility tree checked | Browser accessibility tree checked |
| Application resource requests outside extension origin | None observed | None observed |
| Actual toolbar popup with page selection (user screenshots) | Prefill, detection, automatic English → Chinese result | Prefill and detection; retry passes activation but model cannot start |
| Native context-menu click | Pending | Pending |

The selection test inserted synthetic sample text into the real session handoff and exercised the production receiver and native translation. It did not invoke the OS context menu. Context-menu and keyboard event coordination are separately covered by integration tests with browser API doubles. This distinction matters for the remaining acceptance checks.

Controlled browser API replacements verified unavailable-pair UI, a 25% model download indicator, download-failure UI, cancellation, and a stale result arriving after its replacement. A result containing an HTML image tag appeared literally and created no image element. Copy behavior was checked with a clipboard double; the system clipboard still needs a manual click test. Replacements existed only in the isolated test document and were removed by reloading it.

Chrome reported no extension runtime errors. Edge recorded the browser warning `The translation service crashed.`, consistent with the Phase 0 runtime failure. The UI catches the rejected native call and suggests retry/update/restart; it never substitutes another translation service.

### Popup selection and model setup checks — 2026-10-09

The popup captures the active page's selection immediately, waits for saved preferences, and automatically translates once. Controlled browser API checks in both Chrome and Edge covered saved-language routing, empty/restricted/denied selection access, oversized input, delayed preference loading, and a selection response arriving after typing, clearing, or closing. Late responses did not overwrite user edits or start another translation. The serialized production selection reader preserved paragraphs and selected textarea/input text in real browser DOM checks; password selections, including masked characters, were ignored.

A controlled activation failure verified that **Try again** reuses confirmed detection for unchanged text and retries translator creation directly. The model setup guide is available in popup and selection documents and opens on model setup errors. Browser checks covered keyboard expansion, visible focus, narrow layout, automatic expansion on an activation error, and collapse after a successful retry. These guide/retry checks used native API replacements, not real downloads.

In the actual Edge popup, the user's retry changed the activation error to a model-start error. A separate native probe confirmed active user activation at `Translator.create()`, followed by `NotSupportedError`. The isolated Edge profile already contained the registered English–Chinese language pack `2026.4.6.1` and Edge LLM Runtime `2026.10.2.1`. Model files being present did not make the runtime usable; the pair still reported `downloadable`. This does not establish the root cause, and a repeated download is not a verified fix. No exact model-download request URL was captured.

### Voice settings and previews — 2026-10-09

Primary and secondary voice selectors list only compatible local voices, with an Automatic option. New tests preceded preferred-voice selection and persistence changes. They cover voice identity (name, language, and engine), script matching, removed/online voice fallback, speech routing, old settings, and malformed voice preferences without discarding valid language/rate settings.

Controlled checks in both browsers verified independent choices, previews using unsaved voice/rate settings, preview replacement and Stop, per-language samples, language-change reset, save/reload, voice-list refresh, missing voices, error messages, and page-close cleanup. A saved-choice display bug when language options changed during loading was reproduced and fixed. Accessible control names and a 375-pixel layout were checked. Source/result speech used the corresponding saved voice, and other-language speech used a compatible automatic voice.

Fresh isolated profiles in the same Chrome/Edge versions exposed 180 local voices. Real previews using Tingting (`zh`, 1.2×) and Samantha (`en`, 1.1×) emitted native `start` and `end` events in both browsers. Stopping a started preview emitted `interrupted`/`cancelled` and restored its Preview button. Native speech was not replaced in these checks; event completion does not establish audible quality.

### Build and automated checks

- Bun 1.4.2 with a frozen lockfile; TypeScript, SolidJS, Vite, Manifest V3.
- Strict type checking covers all source, tests, and build configuration.
- **117 tests / 334 assertions** cover production unit/integration behavior. Tests preceded the routing, native lifecycle, message, and speech implementations.
- Production build passes and was checked for byte-for-byte reproducibility.
- `dist/` contains the V1 build. The superseded Phase 0 diagnostic code, its build script, and its 17 spike-only tests have been removed.
- Production permissions: `contextMenus`, `storage`, `tts`, `activeTab`, `scripting`. No host permissions, persistent content scripts, offscreen, remote code, or application network connections.

### Review regression checks

The seven review findings are addressed. Selection tabs close through `tabs.getCurrent()` / `tabs.remove()`; popup closure still uses `window.close()`. Speech stop is issued only for a controller's live utterance, and stale events cannot issue another global stop. Suggested source confirmation is scoped to unchanged text. Keyboard selection-read failures are separated from tab-opening failures. There is no global tab-close listener; expired handoffs are pruned on subsequent handoff access. All tests are included automatically in typechecking, and repeat Copy clicks restart their feedback timer.

Browser-driven checks in Chrome and Edge confirmed Close with multiple history entries, native speech continuing while an idle popup document is edited and closed, and native speech stopping when its owning tab closes. A controlled translator verified that confirming Chinese followed by editing to English runs detection again and routes English to Chinese. The repeated-Copy feedback check used a clipboard double. These checks drove extension documents, not an actual toolbar popup.

The original mixed-script rule asked for confirmation on `我们使用 React 和 TypeScript 开发前端应用程序`; the later review fix below narrows that rule. Short text such as `你好，世界` still requires confirmation. The manifest now declares Chrome 138 as its minimum, matching the build target; unexpected translation errors preserve their name/message in the local developer console without adding the request or result to the log.

The earlier native speech startup/stop race remains: stopping immediately after the native `speak()` call resolves can emit `interrupted` while `isSpeaking()` still reports true. Normal stop after startup passed. Retrying a global stop from a stale callback can interrupt a newer page, so the extension does not do that. Audible rapid cancellation still requires manual verification.

### Follow-up review fixes — 2026-10-09

The mixed-script warning now requires a consecutive Latin phrase of at least four words as well as substantial Latin/East Asian content. Confident Chinese containing Starbucks, PDF/Michael, or React/TypeScript passes the regression examples. Ambiguous detector rankings and the under-12-letter rule still prompt.

Escape ignores composition (including tracked composition and legacy key code 229), cancels running work, and leaves idle selection tabs open. Only a primary or secondary language change invalidates a translation; voice/rate updates preserve both running work and finished results. Detected regional/script tags use matching catalog labels without duplicate source choices. Missing confidence is omitted. These decisions and confirmed-detection reuse now have unit-tested helpers.

The timeout is two minutes of inactivity. Advancing progress for each model and phase transitions reset it; repeating the same percentage does not. Fake-clock tests cover nine minutes of model downloads and a stalled download timing out. Context-menu integration tests cover frame-targeted reads before opening a tab, paragraph preservation, denied/empty-read fallback, oversize rejection, and opening the translation tab next to its source.

Controlled Chrome and Edge document checks passed for all three Chinese examples, composition/Escape behavior, speech-only changes during and after translation, language-change invalidation, catalog choices, and confirming an unknown confidence. These use native API replacements and synthetic composition events; real macOS input-method cancellation and native right-click interaction still need manual verification. The large translator JSX expressions were split for readability.

### Remaining manual acceptance checks

- [ ] Finish actual toolbar popup checks in each browser: natural English/Chinese input, Copy, source/result Listen, and Stop. Edge's model-preparation retry was exercised but native translation remains blocked as described above.
- [ ] Right-click a webpage selection with the popup closed. Verify the exact selected text arrives in the translation tab, including paragraph breaks and iframe selections, then translate/copy/speak.
- [ ] Assign the optional keyboard command and test main-frame text, input text, iframe limitations, and a restricted browser page.
- [ ] Cancel a Chinese input-method composition with Escape in the selection tab; verify the tab, source text, and translation remain available.
- [ ] Test popup close during model download, selection-tab navigation/close, browser restart, and rapid speech replacement while listening. Native request cancellation, stale results, and handoff cleanup have automated coverage.
- [ ] Verify a fresh-profile model download in the production UI. Phase 0 already observed real download progress; production UI rare states were also checked with controlled replacements.
- [ ] Resolve/retest Edge native translation on a working browser/model runtime before declaring both-browser acceptance complete.

The app deliberately requires confirmation for fewer than 12 letters, confidence below 0.8/missing confidence, competing base-language scores within 0.2, or a substantial mix of Latin and East Asian scripts with a Latin phrase of at least four consecutive words. These are conservative V1 heuristics, not a guarantee of detecting every multilingual passage. Source and transient target selectors remain editable.

## Historical Phase 0 evidence — 2026-10-08

The following records the feasibility investigation before V1 implementation. The diagnostic probe and its tests have since been removed; this evidence is retained to explain the production architecture and browser limitations. References to the probe manifest and an undecided execution surface describe that historical spike; the production decisions and checklist above supersede them. Do not infer native support from API presence or availability alone.

## Test environment and method

Observed on 2026-10-08, macOS 26.7.1 (25G241), Apple Silicon, using installed headed browsers and separate, agent-created temporary profiles:

- Google Chrome **155.0.8059.40**.
- Microsoft Edge **154.0.4258.62**.
- The same unpacked Manifest V3 build, produced by **Bun 1.4.2**.

These are observations for this machine and these versions, not claims about all Edge installations, other operating systems, or a minimum supported version. No browser package or OS voice was installed or updated by the spike.

Real native APIs were exercised through browser debugging and actual diagnostic button clicks. Unit-test doubles were used only for error and lifecycle behavior. The initial visible-document tests used ordinary API feature defaults. Isolated profiles were launched with `--remote-debugging-port`, `--enable-unsafe-extension-debugging`, `--no-first-run`, and `--no-default-browser-check` for automation. Afterward, both task-owned browser instances were restarted with `--offscreen-document-testing` for offscreen tests. No native AI feature flags or browser sandbox overrides were added. Developer mode must remain enabled when reloading unpacked extensions.

## Observed results

| Check | Chrome 155 | Edge 154 |
| --- | --- | --- |
| Same build loads in an extension-owned tab | Pass | Pass |
| Secure extension document exposes both APIs | Pass | Pass |
| Language detection of natural English | Pass; confidence about 0.9991 | Pass; confidence about 0.9999 |
| Initial `en → zh`, `zh → en` availability | `downloadable` | `downloadable` |
| `en → zh` creation and inference after a user gesture | Pass | **Fails with `NotSupportedError`** |
| `zh → en` creation and inference after a user gesture | Pass | **Fails with `NotSupportedError`** |
| Download progress | Observed 0 through 1, `total: 1` | Observed 0 through 1, `total: 1`, then creation fails |
| Browser restart and retry | Translation still works | Same failure persists |
| `zh-Hant → en`, `en → zh-Hant` inference | Pass in explicit pair probes | Availability only; no inference claim |
| Offscreen document exposes both APIs | Yes, with testing-only setup | Yes, with testing-only setup |
| Offscreen detection and translation of initialized default pairs, no activation | Pass | Detection succeeds; translation cannot initialize |
| New offscreen pair without activation (`en → fr` control) | `NotAllowedError` | `NotAllowedError` |
| Local English TTS, Samantha (`en-US`) | `start` and `end` events | `start` and `end` events |
| Local Chinese TTS, Tingting (`zh-CN`) | `start` and `end` events | `start` and `end` events |
| Stop an utterance after its `start` event | `interrupted`; `isSpeaking() === false` | `interrupted`; `isSpeaking() === false` |
| Native context-menu click → selection handoff | Implemented; manual verification pending | Implemented; manual verification pending |
| Full production popup/overlay workflow | Not implemented; behind gate | Not implemented; behind gate |

TTS event completion verifies the API path; audible quality and pronunciation still need human listening. Native context-menu interaction could not be reliably exercised through the automation available in this session. No simulated menu callback is being counted as real-browser proof.

## Translation and script examples

Chrome input, `en → zh`:

> This translation runs on my computer. Please keep the original meaning of these sentences.

Observed output:

> 此翻译在我的计算机上运行。 请保留这些句子的原意。

With the explicit target `zh-Hant`, the same input produced:

> 這個翻譯在我的電腦上運行。 請保留這些句子的原意。

Chrome input, `zh → en`:

> 这是一个浏览器本地翻译测试。我们希望在没有云端服务的情况下翻译这些句子。

Observed output:

> This is a browser local translation test. We would like to translate these sentences without cloud services.

The Chinese detection result was `zh-Hans` with confidence about 0.9988. Production routing therefore needs to handle `zh-Hans` as well as `zh`, `zh-Hant`, and regional forms. These examples establish sample behavior, not guaranteed script conversion or translation quality. The Phase 0 dropdown deliberately tests explicit pairs and does not implement automatic language routing.

## Edge blocker and attempted alternatives

After download reached 100%, both default directions failed with:

```text
NotSupportedError: Unable to create translator for the given source and target language.
```

This persisted after restarting the isolated browser and repeating with a user gesture. An ordinary secure-context localhost page reproduced the same failure, so the observed problem is not confined to the extension origin. Relevant Edge process diagnostics included:

```text
failed to get an adapter=No supported adapters
Unable to get gpu adapter
Edge LLM: Error getting component directory
Trying to load the allocator multiple times. This is *not* supported.
libc++abi: terminating due to uncaught exception of type std::runtime_error
```

The evidence points to a browser/model-runtime failure on this setup. It does not establish the root cause or prove that Edge generally lacks support. A working Edge environment is required before claiming cross-browser feasibility.

## Activation, execution surface, and model lifecycle

- Both browsers rejected first translator creation without document activation using `NotAllowedError`. Detection succeeded independently. Starting multiple new translator pairs from one synthetic gesture initialized only the first; test each new pair with a separate click.
- Chrome reported pairs as `available` after successful per-pair initialization, including after restart. Cached files alone did not authorize every new direction. Download progress can still emit 0 and 1 for already-ready models.
- Chrome translated both default directions offscreen without activation after visible-document initialization. The offscreen probe destroys each native session and closes its document after use; it does not retain a session cache.
- Both browsers rejected `reasons: ['TESTING']` without the explicit testing switch. The documented production reasons do not include native translation. Do not invent a DOM, audio, or worker use merely to justify an offscreen page.
- A visible extension tab is a tested Chrome inference surface and a candidate fallback for selection translation. It permits a real activation click but changes the interaction from an in-page overlay. The diagnostic tab is an experiment, not approval of that product tradeoff.
- Service workers coordinate context menus and messages only. Neither the spike nor the proposed design performs native inference inside the MV3 worker.
- Popup execution, cross-origin extension iframes, and content-script native AI access have not been verified. A production overlay architecture remains open.

Documented background: Chrome's [Translator documentation](https://developer.chrome.com/docs/ai/translator-api) and [Language Detector documentation](https://developer.chrome.com/docs/ai/language-detection) describe activation and document-context constraints. The [offscreen reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen) lists the supported reasons and notes that only the runtime extension API is available offscreen. Edge documents on-device translation for sites and extensions in its [Translator API reference](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api) and [148 release notes](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/148). Documentation is background, not a substitute for the results above.

## Speech, permissions, and privacy

Immediately after browser startup, English/Chinese voice lists contained only remote entries. Later, both exposed 180 local OS voices. Refresh or listen for `chrome.tts.onVoicesChanged`; do not treat the initial list as definitive. The probe selects only `remote === false`, preferring an exact language then a compatible base language and script. It refuses remote or unknown-locality fallbacks. The [TTS reference](https://developer.chrome.com/docs/extensions/reference/api/tts) defines the remote flag and speech events.

Stopping after an utterance started worked in both browsers. A separate check that stopped immediately after `speak()` resolved still reported speaking after 300 ms. Promise resolution is not a start event, and on macOS `isSpeaking()` reflects system speech too. The startup/stop race and audible cancellation need further lifecycle testing in Phase 2; no stronger guarantee is claimed here.

The Phase 0 manifest requests only `contextMenus`, `tts`, and `offscreen`. It requests no host access, storage, scripting, content scripts, or external messaging. Offscreen is present only for the diagnostic experiment. All message handlers restrict extension sender identity and document URL, validate bounded requests, and render data with `textContent` or textarea values.

There is no application fetch, telemetry, text history, or remote translation code. `connect-src 'none'` disallows application network connections. Browser model downloads still occurred, as expected. No packet capture or system-wide offline test was performed, so this is not a claim that the browser made no network requests. Only synthetic sample text was used in these checks.

## Historical Phase 0 checklist and gate decision

The following gate status was recorded at the end of the spike:

- [x] Same MV3 build loads in both browsers; actual native detection tested.
- [x] Chrome default-direction creation, translation, progress, and restart tested.
- [x] Both browsers emit completed speech events with local English/Chinese voices.
- [x] Offscreen activation limits and testing-only setup recorded.
- [ ] Resolve/retest Edge translation in a working environment.
- [ ] Manually select text on an ordinary webpage, invoke **Translate selection** with no toolbar popup open, and verify the diagnostic tab receives the exact text. Detect and translate there; test oversize selection and an expired handoff.
- [ ] Decide whether a visible extension page is acceptable for selection translation, or prove a production-supported overlay execution context.
- [ ] Verify source/result speech controls and stop by listening in both browsers.

At that point, automated checks passed: **17 tests, 58 assertions**. Test-first checks covered bounded requests, model availability, progress variants, failures, session destruction, cancellation, message origins, offscreen cleanup, and local-only voice matching. They did not satisfy the real-browser gate.

**Decision requested at the end of Phase 0 (superseded by the request to implement V1):** retain the Chrome-and-Edge requirement and continue Phase 0 investigation/retest in another Edge environment (recommended), or explicitly revise the implementation gate to permit Chrome-first development with Edge remaining unsupported. The later V1 implementation and remaining acceptance work are described above.
