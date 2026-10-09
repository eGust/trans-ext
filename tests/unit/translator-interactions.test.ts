import { expect, test } from "bun:test";
import { catalogLanguage, languageLabel } from "../../src/core/languages";
import { DEFAULT_PREFERENCES } from "../../src/core/preferences";
import { confidenceLabel, escapeAction, isComposingInput, languageSettingsChanged, reusableSourceLanguage } from "../../src/core/translator-interactions";

const escape = { key: "Escape", isComposing: false, keyCode: 27, defaultPrevented: false };

test("Escape preserves an idle selection tab and cancels only active work", () => {
  expect(escapeAction(escape, true, false)).toBeUndefined();
  expect(escapeAction(escape, true, true)).toBe("cancel");
  expect(escapeAction(escape, false, false)).toBe("close");
  expect(escapeAction(escape, false, true)).toBe("cancel");
});

test("composition, handled keys, and non-Escape keys cannot cancel or close", () => {
  for (const event of [{ ...escape, isComposing: true }, { ...escape, keyCode: 229 }, { ...escape, defaultPrevented: true }, { ...escape, key: "Enter" }]) {
    expect(escapeAction(event, false, false)).toBeUndefined();
    expect(escapeAction(event, true, true)).toBeUndefined();
  }
  expect(escapeAction(escape, false, false, true)).toBeUndefined();
  expect(isComposingInput({ isComposing: true, keyCode: 13 })).toBe(true);
  expect(isComposingInput({ isComposing: false, keyCode: 229 })).toBe(true);
});

test("speech-only changes preserve translation state; language or script changes invalidate it", () => {
  expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, speechRate: 1.7 })).toBe(false);
  expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, secondaryVoice: { voiceName: "Alex", lang: "en-US" } })).toBe(false);
  expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, primaryLanguage: "zh-Hant" })).toBe(true);
  expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, secondaryLanguage: "ja" })).toBe(true);
});

test("only confirmed detection is reused and an explicit source takes precedence", () => {
  expect(reusableSourceLanguage("", { certain: false, language: "zh-Hans" })).toBeUndefined();
  expect(reusableSourceLanguage("", { certain: true, language: "zh-Hans" })).toBe("zh-Hans");
  expect(reusableSourceLanguage("en", { certain: true, language: "zh" })).toBe("en");
  expect(reusableSourceLanguage("", undefined)).toBeUndefined();
});

test("confidence is omitted when unknown, while an actual zero stays visible", () => {
  for (const confidence of [undefined, NaN, Infinity, -1, 1.5]) expect(confidenceLabel(confidence)).toBeUndefined();
  expect(confidenceLabel(0)).toBe("0% confidence");
  expect(confidenceLabel(0.99)).toBe("99% confidence");
});

test.each([["zh-Hans", "zh"], ["zh-CN", "zh"], ["zh-TW", "zh-Hant"], ["zh-Hant-HK", "zh-Hant"], ["en-GB", "en"]] as const)("catalog display maps %s to %s without losing script distinctions", (tag, expected) => {
  expect(catalogLanguage(tag)?.tag).toBe(expected);
  expect(languageLabel(tag)).toBe(languageLabel(expected));
});

test("uncatalogued languages or scripts remain distinct choices", () => {
  expect(catalogLanguage("en-Shaw")).toBeUndefined();
  expect(catalogLanguage("sr-Latn")).toBeUndefined();
  expect(catalogLanguage("not_a_tag")).toBeUndefined();
});

test.each(["und", "UND", "und-US", "und-Latn", "mul", "zxx"])("unknown language tag %s cannot resolve to a catalog language", tag => {
  expect(catalogLanguage(tag)).toBeUndefined();
  expect(languageLabel(tag)).not.toBe(languageLabel("en"));
});
