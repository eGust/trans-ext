# Browser AI Translator — V1 Implementation Handoff

Status: Ready for implementation  
Date: 2026-10-08  
Audience: Codex CLI / Claude Code / human maintainers

## 1. Goal

Build a lightweight, privacy-oriented browser translation extension similar in interaction style to Simple Translate. **V1 supports desktop Google Chrome and Microsoft Edge only**, uses their **built-in on-device Translator and Language Detector APIs** for translation, and uses **built-in browser/system text-to-speech (TTS)**. It has no backend, no third-party AI provider, no API keys, and no paid service dependency.

**Most important behavior:** Users configure a _primary language_ and a _secondary language_. Translation direction is automatically selected from the detected source language:

- If source language is **different from primary**, translate **into primary**.
- If source language **is primary**, translate **into secondary**.

Defaults: primary `zh` (Simplified Chinese), secondary `en` (English).

Example:

| Selected text language | Detected source | Target | Result                                   |
| ---------------------- | --------------- | ------ | ---------------------------------------- |
| English                | `en`            | `zh`   | Chinese                                  |
| Japanese               | `ja`            | `zh`   | Chinese                                  |
| French                 | `fr`            | `zh`   | Chinese                                  |
| Simplified Chinese     | `zh`            | `en`   | English                                  |
| Traditional Chinese    | `zh-Hant`       | `en`   | English (see normalization policy below) |

## 2. Fixed scope and explicit non-goals

### In scope

1. **Single Manifest V3 extension codebase/build** for recent desktop Chrome and Edge.
2. Translation from toolbar popup: paste/type text; auto-detect source; translate; display, copy, and speak result.
3. Selected-text translation on ordinary webpages: right-click context menu and optional keyboard shortcut; show result in a lightweight in-page overlay (or a viable extension surface, if proven necessary in Phase 0).
4. Configurable primary and secondary languages, persisted locally; defaults `zh` and `en`; enforce they are meaningfully distinct.
5. Built-in `LanguageDetector` + `Translator`; model availability and downloading states; clear unsupported/unavailable errors.
6. TTS for both source and translation via `chrome.tts` (system/installed voices), including play/stop and speech rate; optional voice picker if available without complicating MVP.
7. No automatic cloud fallback, no external translation requests, no user tracking.
8. Automated unit tests for language routing and error handling, plus manual real-browser smoke tests in Chrome and Edge.

### Out of scope for V1

- OpenAI/Claude/DeepSeek APIs, API keys, website-session automation, or generic provider framework beyond what is needed to isolate the native translation implementation.
- General-purpose on-device Prompt API (Gemini Nano/Phi), custom prompts, definitions, explanations, or grammar tutoring.
- Full-page translation, DOM rewriting, watching dynamically inserted page text.
- Firefox/Safari, mobile browsers, hosted web service, authentication, cloud sync, telemetry, and translation-history database.
- Paid or cloud TTS voices; do not attempt to extract proprietary Edge Read Aloud voices.

## 3. Core language-routing specification

Persist preferences as BCP 47 language tags:

```ts
interface LanguagePreferences {
  primaryLanguage: string; // default "zh"
  secondaryLanguage: string; // default "en"
}
```

Use language tags accepted by the native browser APIs. Present friendly labels in Settings. For V1, support a curated, tested list rather than promising every conceivable language pair; check support at runtime.

### Routing algorithm

1. Reject empty/whitespace-only input without running detection.
2. Run `LanguageDetector` on the source text; collect a ranked result including confidence where provided.
3. Normalize language tags for comparison only: parse BCP 47 tags, compare base languages case-insensitively. **Both `zh` and `zh-Hant` count as Chinese for routing.** `en-US` and `en-GB` count as English. Preserve actual source/destination variants when constructing a translator if supported.
4. If detected base language equals primary base language, target secondary language; otherwise target primary language.
5. Ensure source and target are not the same effective language. If primary and secondary share a base language, Settings should reject that combination for V1; this intentionally avoids complex same-language script conversion.
6. Check `Translator.availability({sourceLanguage, targetLanguage})` with the best supported tag combination; do not assume every language pair is available. Consider falling back from regional variants to base tags where appropriate (e.g. `en-US` to `en`) without silently changing a Chinese script requirement.
7. If source is unknown, ambiguous, or confidence is too low, show detected-language uncertainty and let the user explicitly select the source language. **Never silently guess a direction for very short or mixed text**. The UI may propose the most likely language, but it must be editable.
8. Source-language override should re-run routing using the overridden language; optionally provide an explicit target override for the current translation without changing stored preferences.
9. If no supported pair exists, display an actionable message rather than using an external service.

Example reference logic (not production-ready validation):

```ts
function baseLanguage(tag: string): string {
  return tag.split('-')[0].toLowerCase();
}

function chooseTarget(detectedSource: string, prefs: LanguagePreferences): string {
  return baseLanguage(detectedSource) === baseLanguage(prefs.primaryLanguage)
    ? prefs.secondaryLanguage
    : prefs.primaryLanguage;
}
```

**Mixed-language policy:** Source detection is at the selected-text level, not sentence-by-sentence. V1 may translate the entire selection according to the predominant detected language. Surface ambiguous results; do not attempt segmented multilingual translation yet.

**Chinese script policy:** Primary default is Simplified Chinese, `zh`. Treat Chinese script variants as Chinese for _routing_ (translate to English). Actual output script and browser language-pack support must be verified in Chrome and Edge; do not promise script conversion or exact Simplified/Traditional formatting without testing.

## 4. UI and interactions

### Toolbar popup

- Compact design inspired by Simple Translate; responsive, keyboard-friendly, accessible.
- Source textarea, **Auto Detect** source indicator/dropdown, target language label, Translate button.
- Output area with Copy and Speak controls; separate Speak button for source input.
- Clear loading, model-downloading, unsupported-language, error, and empty states.
- A Settings button; optionally show current browser native AI availability.
- Do not translate on every keystroke. Use button/Enter shortcut to avoid resource churn.
- Preserve current text/results while popup stays open. Popup state need not persist after closing.

### Selection translation

- Context menu: **Translate selection**; clicking requests translation of highlighted text.
- Keyboard command (choose a sensible default only if not conflicting; user can remap via browser shortcuts).
- Render compact in-page overlay near selection, with detected source, target, translated result, Copy, Speak, Close, and optional Retry.
- Overlay should not alter source page content or hijack its UI. Handle scroll, escape key, click-away, and very long selections safely.
- Use Shadow DOM and minimal styling isolation where practical. Sanitize/escape all source/result text; never inject translation as HTML.
- Clearly document that browser-internal pages (e.g. `chrome://`, `edge://`), stores, and some restricted pages disallow content scripts.

### Settings

- Primary language selector (default Simplified Chinese).
- Secondary language selector (default English).
- Validate different base languages; show explanatory text: `If selected text is in your primary language, translate it into your secondary language; otherwise, translate into your primary language.`
- TTS rate setting (default 1.0); optionally voice selectors per language if reliable; fallback to OS defaults.
- Save to `chrome.storage.local` (or `sync` only after evaluating portability/privacy; local is preferred for V1).

## 5. Browser native AI APIs

Use documented **Translator** and **LanguageDetector** interfaces (not general-purpose `LanguageModel`). Both are on-device; downloads of language packs may require network connection initially.

- Feature detect: `'Translator' in globalThis`, `'LanguageDetector' in globalThis`.
- Call static `.availability()` before `.create()`; handle `available`, `downloadable`, `downloading`, `unavailable` states.
- Use `.create({ ..., monitor })` with the documented `downloadprogress` event and show progress if provided. Handle API or implementation variations defensively.
- Use `.translate(text)` for actual translation; stream only if it improves user experience and is supported reliably.
- Clean up/destroy sessions when no longer needed; consider small caches for repeated language pairs only after measuring resource impact.
- Abort outdated requests on new translation or overlay closure where supported; prevent stale results from overwriting newer ones.
- Test native API in **extension-owned document contexts**. **Do not call Translator inside the MV3 service worker**: Chrome documents it as unavailable in Web Workers. The service worker should coordinate commands and messaging, not execute translation itself.
- The target execution surface (popup, extension offscreen document, or another viable extension page) **must be validated in Phase 0**. Popup-only execution is insufficient for selection translation because the popup may not be open. If offscreen execution is used, validate the relevant API access and lifecycle on both browsers.
- Check whether extension origins and page-content contexts have restrictions, and explicitly document all discovered constraints.

Important: Edge and Chrome share the web API shape, but use different implementation/models. Do **not** assume identical language coverage, performance, model size, or model availability.

## 6. TTS

- Prefer `chrome.tts` with the manifest `tts` permission; supported in Chromium-based extensions.
- `chrome.tts.getVoices()` for optional voice selection; allow OS/browser defaults when voices are unavailable.
- `chrome.tts.speak(text, {lang, rate, ...})`; `chrome.tts.stop()`; track utterance state via supported events.
- Source TTS uses detected/overridden source tag; translated TTS uses target tag. Map language tags to compatible voices where practical.
- Speaking translated text is independent of the translation engine/model.
- Long text may need chunking due to TTS utterance length limits; avoid excessive complexity in V1 by setting an input length limit, and explain it to users.
- Never claim cloud-quality neural voices are necessarily available via `chrome.tts`.

## 7. Suggested stack and repository layout

Use TypeScript, SolidJS, Vite, Manifest V3. Consider WXT as the extension scaffolding/build tool; confirm that it produces one compatible build for Chrome/Edge and supports the required document contexts. Minimize dependencies.

```text
browser-ai-translator/
  README.md
  package.json
  wxt.config.ts                 # if WXT chosen
  src/
    entrypoints/
      background.ts             # context menu, commands, routing/messaging
      content.ts                # selection + overlay
      popup/                    # main UI
      options/                  # preferences UI
      offscreen/                # only if validated as necessary
    core/
      language-routing.ts       # pure testable decision logic
      languages.ts              # tags + display labels
      preferences.ts
      messages.ts               # typed request/response contracts
    native-ai/
      detector.ts
      translator.ts
      capability.ts
    tts/
      tts.ts
    ui/
      components/
  tests/
    unit/
    integration/
    e2e/
  docs/
    compatibility.md
```

Possible minimal abstraction:

```ts
type TranslationOutcome = {
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string;
  detectionConfidence?: number;
};

type TranslateRequest = {
  text: string;
  sourceLanguageOverride?: string;
  targetLanguageOverride?: string; // transient UI override only
};
```

Don't design a complex multi-provider plugin framework for this native-only V1.

## 8. Security, privacy, permissions

- No backend, cloud AI, API keys, analytics, account, or persistent text history.
- State plainly that text is processed by browser-provided models locally; language pack download and browser update mechanisms may use network connections. Verify behavior and distinguish local inference from model downloads.
- Keep manifest permissions minimal: contextMenus, storage, tts, activeTab/scripting as required, and any explicitly needed offscreen permission. Avoid `<all_urls>` unless demonstrated necessary and justified.
- Do not use `eval`, remote scripts, remote code, or unsafe HTML interpolation. Keep Manifest V3 CSP compliant.
- Restrict message origins, validate payloads, bound max text size, and handle injection risk when showing page-selected text.
- Do not persist highlighted text, results, or browsing URLs by default.

## 9. Test plan / acceptance criteria

### Unit tests (required)

1. Default prefs (`primary=zh`, `secondary=en`).
2. English → Chinese; Japanese → Chinese; French → Chinese.
3. Chinese (`zh`) → English; Traditional Chinese (`zh-Hant`) → English.
4. `en-US` is treated as English when primary is `en`; `zh-CN` and `zh-TW` as Chinese for routing.
5. Swap primary/secondary preferences, and test arbitrary distinct language selections.
6. Reject primary/secondary that share a base language.
7. Empty selection, unknown source, low-confidence detection, and mixed-language selection.
8. User source override changes translation direction; transient target override does not modify saved preferences.
9. Unsupported language pair, model unavailable, download failure, cancelled/replaced request.
10. TTS source language, target language, voice fallback, stop control.

### Real-browser smoke tests (required, Chrome AND Edge)

1. Load same generated unpacked extension build in each browser.
2. Confirm `Translator`/`LanguageDetector` available **where code actually executes**.
3. Test `en → zh` and `zh → en` using natural multi-sentence inputs; verify download flow on fresh profile as possible.
4. Translate text entered in popup; copy and speak both source/result.
5. Translate a webpage selection with context menu while toolbar popup is closed.
6. Translate via keyboard shortcut, if implemented.
7. Change primary/secondary in Settings and confirm routing changes.
8. Test unavailable model/language/error UI (can use controlled mocks for rare states).
9. Exercise popup-close, page navigation, overlay close, multiple quick requests, browser restart.
10. Check no translation text goes to remote third-party AI services; no unintended permissions.

### Definition of Done

- One extension codebase/build works in current supported Chrome and Edge.
- Direction follows primary/secondary routing rules and allows correction when detection is uncertain.
- Works with no account, API key, external provider, or paid service.
- Both popup and selected-text workflows function; built-in TTS works.
- Native model availability and download states are handled without silent failure.
- Unit tests pass and a manual browser compatibility checklist is documented.
- README includes installation steps (`chrome://extensions`, `edge://extensions`), limitations, model download caveats, and usage.

## 10. Implementation phases (instructions to coding agent)

### Phase 0: Spike — prove feasibility before building UI

1. Scaffold minimal MV3 extension; instrument capability checks in Chrome and Edge.
2. Prove `LanguageDetector` and `Translator` work in an extension-owned document.
3. Prove selection/context-menu translation **without an open toolbar popup**. Decide where native inference executes, with a minimal end-to-end demonstration.
4. Prove TTS both languages.
5. Record supported browsers, model lifecycle, language pairs, and limitations in `docs/compatibility.md`.
6. If the API is blocked in proposed execution context, investigate documented alternatives, report findings, and **do not silently substitute cloud services**.

**Hard gate:** Don't proceed to the full UI until Chrome and Edge feasibility is demonstrated, or clearly document unresolved blockers and request a decision.

### Phase 1: Core features

- Language preferences and pure routing logic with tests.
- Popup UI with detect → route → availability → translate.
- Error, progress, and cancellation handling.

### Phase 2: Page interactions and speech

- Context menu, selected-text overlay, optional keyboard shortcut.
- Source/result speech, speech rate, voice fallback.
- Test navigation, focus, overlay lifecycle, and content script restrictions.

### Phase 3: Harden and package

- Permissions audit, accessibility, unit/integration tests, real-browser smoke tests.
- README and compatibility matrix; one reproducible production build.

## 11. Agent workflow requirements

- Work in small, reviewable increments.
- For core routing behavior, write failing unit tests first, then implement, then run checks.
- Confirm real browser API behavior before abstracting it; do not rely on mocked APIs as proof of availability.
- Keep user-configured primary/secondary language semantics consistent across popup, context menu, and overlay.
- Prefer documented APIs and smallest viable scope; do not add cloud providers or full-page translation.
- If forced to make a nontrivial product tradeoff, document alternatives and ask rather than inventing a requirement.
- End with build commands, test results, manual steps, limitations, and remaining tasks.

## 12. Official reference documentation

- Chrome built-in translation: https://developer.chrome.com/docs/ai/translator-api
- Edge Translator API: https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api
- Edge 148 release notes: https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/148
- MDN built-in Translator and Language Detector APIs: https://developer.mozilla.org/en-US/docs/Web/API/Translator_and_Language_Detector_APIs
- Chrome extensions TTS: https://developer.chrome.com/docs/extensions/reference/api/tts
- Chrome MV3 documentation: https://developer.chrome.com/docs/extensions/develop

Notes: Browser-native APIs may be experimental or have limited availability. Feature detection, model availability checks, real-browser verification, and clear limitations are non-optional.
