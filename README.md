# Local Translate

A Manifest V3 translation extension for desktop Chrome and Edge, built with TypeScript, SolidJS, and Vite. Translation uses browser-provided on-device models; speech uses installed local voices. No account, backend, API key, or cloud translation service is involved.

**V1 implementation is ready to load.** Chrome translation was verified on the local test machine. The installed Edge version exposes the APIs but its native translation service crashes; the extension reports that failure and does not switch providers. See [compatibility and remaining browser checks](docs/compatibility.md).

## Install from source

Use **Bun 1.4.2**, pinned in `.bun-version` and `package.json`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs formatting checks, oxlint and Solid ESLint rules, TypeScript checking, the unit/integration suite, and the production build. Load the **same `dist/` directory** in both browsers:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select `dist/`.
3. Pin **Local Translate** in the extensions menu if desired.
4. After rebuilding, reload the extension on the extensions page.

Other development commands:

```sh
bun run format         # Format with oxfmt (Markdown uses spaces; code uses tabs)
bun run format:check   # Check formatting without writing
bun run lint           # oxlint plus eslint-plugin-solid
bun run lint:fix       # Apply automatic lint fixes
bun test               # Unit and integration tests
bun run typecheck      # Strict checking of all source, build code, and tests
bun run build          # Production unpacked extension in dist/
bun run dev            # Watch and rebuild; reload the extension after changes
```

`bunfig.toml` runs tool scripts on Bun and requires new dependency versions to be at least 20 days old, with explicit exceptions for Bun types, TypeScript, Oxc tooling and their platform bindings, and `tinypool`. These exceptions also apply to future upgrades until removed.

Use `bun run typecheck` for TypeScript 7 (`typescript-go`) checking. TypeScript 6 supplies the compiler API required by ESLint's TypeScript parser; the default `tsc` executable and editors using the workspace TypeScript package use version 6.

`lint` rejects all errors and warnings. Oxlint checks correctness, suspicious behavior, performance, and selected safety rules; broad style and pedantic categories are disabled to allow the project's function declarations, unbraced conditionals, and method signatures. Solid rules run through ESLint. Scoped exceptions allow Solid's JSX refs, delegated Escape handling, CSS imports, and empty test doubles.

The extension does not request offscreen permission. Dependencies are pinned in `bun.lock`; no remote scripts are loaded. The manifest declares Chrome 138 as the minimum version, matching the build target. Native model availability is still checked at runtime.

## Use

Select text on an ordinary webpage and open the toolbar popup. It fills the source box and starts translation automatically using your language settings. The popup reads the main frame, including selected text in supported text inputs and textareas. For iframe selections, use the right-click menu or paste manually. If no selection is available or page access is blocked, the popup opens ready for typing. Selections over 4,000 characters show a message without being truncated.

You can also paste or type up to 4,000 characters and click **Translate**. **Ctrl+Enter** or **Command+Enter** also translates. Typing alone does not run detection or translation. Copy the result or use the separate **Listen** controls for the original and translation. Click the active **Stop** control to stop speech.

In **Settings**, choose a primary and a secondary language:

- Text in another language translates into your primary language.
- Text in your primary language translates into your secondary language.
- Defaults are Simplified Chinese (`zh`) and English (`en`).

Chinese script variants count as Chinese for routing, and regional English variants count as English. The settings reject two languages with the same base language. Set speech rate between 0.5× and 2×; settings stay on this device.

Under **Read it aloud**, choose a **Primary voice** and **Secondary voice** from the installed local voices for those languages. **Preview** reads a short sample in that language using your current voice and speed, without saving; click **Stop** to end it. Changing the voice, language, or speed also stops the preview. Click **Save settings** to apply the choices to source and translation speech.

**Automatic** picks a compatible local voice. Other languages use Automatic, and a saved voice that becomes unavailable falls back to a compatible local voice. Changing a primary/secondary language resets its voice to Automatic. The voice list updates when the browser reports changes; **Refresh voices** also reloads it after installing voices in your system settings. Saving a voice or speech-rate change preserves open translations. Changing the primary or secondary language clears the previous result so it can be translated with the new direction.

The source selector lets you correct detection. Short text, low-confidence results, ambiguous rankings, and substantial mixed-language passages require source confirmation. Isolated English names or technical terms in otherwise confidently detected Chinese do not trigger the mixed-language warning. The suggested **Use language** confirmation applies only to the current text; editing it resumes detection. An explicit source-selector choice stays selected until you change it. Detection is applied to the whole passage; mixed text is not translated sentence by sentence. You can also choose a target just for the current translation without changing Settings.

### Selected text

On an ordinary HTTP(S) webpage, select a passage and choose **Translate selection** from the right-click menu. It opens a translation tab next to the original page and starts detection. The original page is untouched, and the toolbar popup does not need to be open. The extension reads the clicked frame's selection to keep paragraph breaks. If access is blocked or the frame does not respond within 500 ms, it uses the browser's selection snapshot, which may flatten line breaks.

This tab is the V1 selection surface. Phase 0 found that new model pairs need a visible user gesture and that the tested offscreen setup used a testing-only permission reason. The production extension therefore uses the verified visible extension document instead of an unproven offscreen overlay.

The optional **Translate selected text in a new tab** keyboard command has no reserved default shortcut. Assign one at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`. It reads the main frame's selected text; for text inside an iframe, use the right-click menu or paste it manually. Browser-internal pages, extension stores, PDFs with restricted viewers, and other protected pages may disallow selection access. The translation tab explains failures and accepts pasted text as a fallback.

Escape cancels an active translation. An idle popup closes on Escape; a selection tab stays open. Use its Close button or the browser's tab controls to close it. Composition keystrokes are ignored by the extension's shortcuts. Closing or navigating away cancels work and requests a stop for that document's live speech. Source text and results are not restored after closing or reloading the document.

### First use and unsupported models

Open **Set up translation models** below the Translate button for a step-by-step guide in either the popup or selection tab. It also expands when model setup reports an error. The browser manages downloads; no model file needs to be installed manually. For a setup that stays open, use **Translate selection** from a webpage's right-click menu.

The browser may download language models initially. Keep the popup/tab open; progress appears when provided. Detection and a new translation pair can need separate user activation, including after the popup starts automatically. If prompted, click **Try again** inside the popup/tab. Advancing model downloads reset the two-minute inactivity timeout; a stalled operation still times out.

The curated settings list contains English, Simplified/Traditional Chinese, Japanese, French, German, Spanish, and Korean. Each pair is checked at runtime. Support, downloads, and output quality differ between browsers; the list is not a promise that every combination works everywhere. Regional fallbacks preserve Chinese script requirements.

If speech reports no local voice, retry after the browser finishes enumerating voices or install the language in your OS voice settings. Voices marked remote, or with unknown locality, are not selected. Speech is limited to 16,000 characters per utterance; the source-input limit is 4,000 UTF-16 code units.

## Privacy and permissions

Only language preferences, selected voice identities, and speech rate are saved to `chrome.storage.local`. Selection handoffs use `chrome.storage.session` (memory only), are bound to the receiving tab, and can be consumed once. They are valid for one minute, removed on consumption, and stale entries are pruned on subsequent handoff access. Browser shutdown clears session storage. At most ten pending handoffs are kept. Text never appears in a handoff URL, and browsing URLs are not saved.

| Permission | Purpose |
| --- | --- |
| `contextMenus` | Translate selection menu |
| `storage` | Local preferences and temporary in-memory selection handoffs |
| `tts` | Local speech and stop controls |
| `activeTab`, `scripting` | Read the current selection when the toolbar popup opens or the optional keyboard command is invoked |

There are no host permissions, permanent content scripts, telemetry, external translation calls, or translation history. Extension CSP disallows application network connections with `connect-src 'none'`. Browser model downloads and browser updates can still use the network. Copying happens only when you click **Copy**.

## Verification and limitations

The implementation follows [the V1 plan](docs/browser-ai-translator-v1-plan.md). Core routing and lifecycle work was developed with failing tests first. The suite covers routing, uncertainty, tag fallback, preferences, model states, cancellation, stale results, local speech, message validation, and handoff cleanup.

[Compatibility notes](docs/compatibility.md) distinguish real native results from mocked error checks and list the remaining manual smoke tests. The actual toolbar popup's selection-prefill flow was verified in both browsers, with automatic translation in Chrome. Native context-menu activation, system clipboard behavior, and audible speech checks still need manual confirmation. Edge's model failure remains an environmental compatibility issue; cross-browser acceptance is not claimed complete.
