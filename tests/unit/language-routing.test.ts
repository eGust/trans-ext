import { describe, expect, test } from "bun:test";
import { baseLanguage, chooseTarget, assessDetection, languageCandidates, validateText } from "../../src/core/language-routing";
import { DEFAULT_PREFERENCES, validatePreferences, restorePreferences } from "../../src/core/preferences";

const paragraph = "This is a natural English paragraph. It contains enough words for language detection.";

test("defaults are Simplified Chinese and English with normal speech rate", () => {
  expect(DEFAULT_PREFERENCES).toEqual({ primaryLanguage: "zh", secondaryLanguage: "en", speechRate: 1 });
});

describe("primary/secondary routing", () => {
  test.each([['en', 'zh'], ['ja', 'zh'], ['fr', 'zh'], ['zh', 'en'], ['zh-Hant', 'en'], ['zh-Hans', 'en'], ['zh-CN', 'en'], ['zh-TW', 'en']])("%s routes to %s", (source, expected) => {
    expect(chooseTarget(source, DEFAULT_PREFERENCES)).toBe(expected);
  });
  test("canonicalizes tags and compares only base languages", () => {
    expect(baseLanguage("EN-us")).toBe("en");
    expect(chooseTarget("en-GB", { primaryLanguage: "en", secondaryLanguage: "ja" })).toBe("ja");
    expect(chooseTarget("ja-JP", { primaryLanguage: "ja", secondaryLanguage: "fr" })).toBe("fr");
    expect(chooseTarget("zh-Hant", { primaryLanguage: "en", secondaryLanguage: "zh" })).toBe("en");
  });
  test.each(["", "und", "not_a_tag", "x-private"])('rejects invalid or unknown source %s', tag => {
    expect(() => chooseTarget(tag, DEFAULT_PREFERENCES)).toThrow();
  });
  test("source override reroutes and target override is transient", () => {
    const prefs = { ...DEFAULT_PREFERENCES };
    expect(chooseTarget("zh-Hant", prefs)).toBe("en");
    expect(chooseTarget("en", prefs, "ja")).toBe("ja");
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
    expect(() => chooseTarget("en-US", prefs, "en-GB")).toThrow();
  });
  test("rejects preferences sharing a base language", () => {
    for (const [primaryLanguage, secondaryLanguage] of [["zh", "zh-Hant"], ["en-US", "en-GB"]] as const) {
      expect(() => chooseTarget("ja", { primaryLanguage, secondaryLanguage })).toThrow();
    }
  });
});

describe("safe variants", () => {
  test("tries regional tags first then base", () => expect(languageCandidates("en-US")).toEqual(["en-US", "en"]));
  test("Chinese fallbacks keep the intended script", () => {
    expect(languageCandidates("zh-TW")).toEqual(["zh-TW", "zh-Hant"]);
    expect(languageCandidates("zh-Hant-HK")).toEqual(["zh-Hant-HK", "zh-Hant"]);
    expect(languageCandidates("zh-Hans-CN")).toEqual(["zh-Hans-CN", "zh-Hans", "zh"]);
    expect(languageCandidates("zh-Hant")).not.toContain("zh");
    expect(languageCandidates("sr-Latn-RS")).toEqual(["sr-Latn-RS", "sr-Latn"]);
  });
});

describe("detection uncertainty", () => {
  test.each([
    "我今天在 Starbucks 买了一杯咖啡",
    "请把这个 PDF 文件发给 Michael，谢谢",
    "我们使用 React 和 TypeScript 开发前端应用程序",
  ])("confident Chinese with names or technical terms translates without confirmation: %s", text => {
    expect(assessDetection(text, [{ detectedLanguage: "zh-Hans", confidence: 0.99 }])).toMatchObject({ certain: true, language: "zh-Hans" });
  });
  test("borrowed names do not bypass an ambiguous detector ranking", () => {
    expect(assessDetection("我今天在 Starbucks 买了一杯咖啡", [{ detectedLanguage: "zh", confidence: 0.85 }, { detectedLanguage: "en", confidence: 0.7 }])).toMatchObject({ certain: false });
  });
  test("uses ranked predominant language with confidence", () => {
    expect(assessDetection(paragraph, [{ detectedLanguage: "fr", confidence: 0.02 }, { detectedLanguage: "en", confidence: 0.98 }])).toMatchObject({ certain: true, language: "en", confidence: 0.98 });
  });
  test("asks for confirmation on very short, unknown, missing or low confidence text", () => {
    for (const [text, results] of [
      ["Hi", [{ detectedLanguage: "en", confidence: 0.99 }]],
      [paragraph, []],
      [paragraph, [{ detectedLanguage: "und", confidence: 0.99 }]],
      [paragraph, [{ detectedLanguage: "en", confidence: 0.4 }]],
      [paragraph, [{ detectedLanguage: "en" }]],
      [paragraph, [{ detectedLanguage: "en", confidence: NaN }]],
    ] as const) expect(assessDetection(text, [...results]).certain).toBe(false);
  });
  test("surfaces ambiguous rankings and clearly mixed scripts", () => {
    expect(assessDetection(paragraph, [{ detectedLanguage: "en", confidence: 0.65 }, { detectedLanguage: "fr", confidence: 0.35 }]).certain).toBe(false);
    expect(assessDetection("这是中文测试文本。 This is also a complete English sentence.", [{ detectedLanguage: "en", confidence: 0.99 }]).certain).toBe(false);
    expect(assessDetection("これは日本語の文章です。漢字も含まれています。", [{ detectedLanguage: "ja", confidence: 0.99 }]).certain).toBe(true);
  });
});

test("rejects empty and oversized inputs before detection", () => {
  expect(() => validateText(" \n ")).toThrow();
  expect(() => validateText("a".repeat(4001))).toThrow();
  expect(validateText(" hello ")).toBe("hello");
});

test("preferences validate the curated list and speech rate, recovering corrupted storage", () => {
  expect(validatePreferences({ primaryLanguage: "ja", secondaryLanguage: "fr", speechRate: 1.5 }).primaryLanguage).toBe("ja");
  for (const value of [null, {}, { ...DEFAULT_PREFERENCES, speechRate: Infinity }, { ...DEFAULT_PREFERENCES, speechRate: 0 }, { ...DEFAULT_PREFERENCES, primaryLanguage: "xx" }, { ...DEFAULT_PREFERENCES, secondaryLanguage: "zh-Hant" }]) expect(() => validatePreferences(value)).toThrow();
  expect(restorePreferences({ bad: true })).toEqual(DEFAULT_PREFERENCES);
});
