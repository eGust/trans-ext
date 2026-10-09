import { afterEach, expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences, restorePreferences, validatePreferences } from "../../src/core/preferences";
afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome; });

test("stores only validated language and rate preferences locally", async () => {
  let stored: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = { storage: { local: { async get() { return stored; }, async set(value: Record<string, unknown>) { stored = value; } } } };
  expect(await loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  await savePreferences({ primaryLanguage: "en", secondaryLanguage: "ja", speechRate: 1.3, selectedText: "must not be saved", browsingUrl: "https://example.com" });
  expect(stored).toEqual({ preferences: { primaryLanguage: "en", secondaryLanguage: "ja", speechRate: 1.3 } });
  expect(await loadPreferences()).toEqual({ primaryLanguage: "en", secondaryLanguage: "ja", speechRate: 1.3 });
  await expect(savePreferences({ primaryLanguage: "zh", secondaryLanguage: "zh-Hant", speechRate: 1 })).rejects.toThrow();
  expect(stored).toEqual({ preferences: { primaryLanguage: "en", secondaryLanguage: "ja", speechRate: 1.3 } });
});

test("voice preferences round-trip without storing runtime voice metadata or sample text", async () => {
  let stored: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = { storage: { local: { async get() { return stored; }, async set(value: Record<string, unknown>) { stored = value; } } } };
  const preferences = { ...DEFAULT_PREFERENCES, primaryVoice: { voiceName: "Tingting", lang: "zh-CN" }, secondaryVoice: { voiceName: "Alex", lang: "en-GB", extensionId: "local-engine" } };
  await savePreferences({ ...preferences, primaryVoice: { ...preferences.primaryVoice, remote: false, sampleText: "never save" } });
  expect(stored).toEqual({ preferences });
  expect(await loadPreferences()).toEqual(preferences);
  await savePreferences({ ...preferences, primaryVoice: undefined, secondaryVoice: undefined });
  expect(stored).toEqual({ preferences: DEFAULT_PREFERENCES });
});

test("old settings keep their languages and speed; invalid stored voice fields are discarded independently", () => {
  const old = { primaryLanguage: "ja", secondaryLanguage: "fr", speechRate: 1.6 };
  expect(restorePreferences(old)).toEqual(old);
  const secondaryVoice = { voiceName: "Thomas", lang: "fr-FR" };
  expect(restorePreferences({ ...old, primaryVoice: { bad: true }, secondaryVoice })).toEqual({ ...old, secondaryVoice });
});

test("voice settings validate their identity and normalize language tags", () => {
  expect(validatePreferences({ ...DEFAULT_PREFERENCES, secondaryVoice: { voiceName: "Alex", lang: "EN-gb" } }).secondaryVoice).toEqual({ voiceName: "Alex", lang: "en-GB" });
  for (const primaryVoice of [null, "Tingting", {}, { voiceName: " ", lang: "zh" }, { voiceName: "Bad", lang: "not_a_tag" }, { voiceName: "Bad", lang: "zh", extensionId: 42 }]) {
    expect(() => validatePreferences({ ...DEFAULT_PREFERENCES, primaryVoice })).toThrow();
  }
});
