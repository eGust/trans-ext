import { expect, test } from "bun:test";
import { SpeechController, localVoice, compatibleLocalVoices, voiceKey, preferredVoiceFor, speechFor, plainSpeech, type SpeechAPI } from "../../src/tts/tts";
import { DEFAULT_PREFERENCES } from "../../src/core/preferences";

const voices = [{ voiceName: "Cloud", lang: "en-US", remote: true }, { voiceName: "Unknown", lang: "en-US" }, { voiceName: "Samantha", lang: "en-US", remote: false }, { voiceName: "Tingting", lang: "zh-CN", remote: false }, { voiceName: "Meijia", lang: "zh-TW", remote: false }];
function api() {
  const calls: { text: string; options: chrome.tts.TtsOptions }[] = []; let stops = 0;
  const value: SpeechAPI = { async getVoices() { return voices; }, async speak(text, options) { calls.push({ text, options }); }, stop() { stops++; } };
  return { value, calls, stops: () => stops };
}

test("matches exact and compatible local voices; refuses cloud and mismatched Chinese scripts", () => {
  expect(localVoice(voices, "en-GB")?.voiceName).toBe("Samantha");
  expect(localVoice(voices, "zh")?.voiceName).toBe("Tingting");
  expect(localVoice(voices, "zh-Hant")?.voiceName).toBe("Meijia");
  expect(localVoice(voices.slice(0, 2), "en")).toBeUndefined();
  expect(localVoice(voices, "ja")).toBeUndefined();
});

test("source and target speech use the original outcome languages", () => {
  const result = { sourceText: "你好", sourceLanguage: "zh-Hant", targetLanguage: "en", translatedText: "Hello" };
  expect(speechFor(result, "source")).toEqual({ text: "你好", language: "zh-Hant" });
  expect(speechFor(result, "result")).toEqual({ text: "Hello", language: "en" });
});

test("voice choices include only named local voices matching the language and script", () => {
  const candidates = [...voices, { voiceName: "Invalid", lang: "not_a_tag", remote: false }, { lang: "en", remote: false }, { voiceName: "No language", remote: false }];
  expect(compatibleLocalVoices(candidates, "en").map(voice => voice.voiceName)).toEqual(["Samantha"]);
  expect(compatibleLocalVoices(candidates, "zh-Hant").map(voice => voice.voiceName)).toEqual(["Meijia"]);
});

test("a chosen voice overrides the automatic accent and is identified by name, language, and engine", () => {
  const preferred = { voiceName: "Alex", lang: "en-GB", extensionId: "local-engine" };
  const candidates = [...voices,
    { voiceName: "Alex", lang: "en-US", extensionId: "local-engine", remote: false },
    { voiceName: "Alex", lang: "en-GB", remote: false },
    { ...preferred, remote: false },
  ];
  expect(localVoice(candidates, "en-US", preferred)).toBe(candidates[7]);
  expect(localVoice([...candidates].reverse(), "en-US", preferred)).toBe(candidates[7]);
  expect(voiceKey(preferred)).not.toBe(voiceKey(candidates[6]!));
  expect(voiceKey(preferred)).toBe(voiceKey({ ...preferred, lang: "en-gb" }));
});

test("missing, online, unknown-locality, and incompatible saved voices use a compatible local fallback", () => {
  for (const preferred of [
    { voiceName: "Removed", lang: "en-US" },
    { voiceName: "Cloud", lang: "en-US" },
    { voiceName: "Unknown", lang: "en-US" },
    { voiceName: "Tingting", lang: "zh-CN" },
  ]) expect(localVoice(voices, "en", preferred)?.voiceName).toBe("Samantha");
  expect(localVoice(voices, "zh-Hant", { voiceName: "Tingting", lang: "zh-CN" })?.voiceName).toBe("Meijia");
  expect(localVoice(voices.slice(0, 2), "en", { voiceName: "Cloud", lang: "en-US" })).toBeUndefined();
});

test("voice preferences follow the language being spoken, regardless of source or result", () => {
  const preferences = { ...DEFAULT_PREFERENCES, primaryVoice: { voiceName: "Tingting", lang: "zh-CN" }, secondaryVoice: { voiceName: "Samantha", lang: "en-US" } };
  expect(preferredVoiceFor("zh-Hans", preferences)).toEqual(preferences.primaryVoice);
  expect(preferredVoiceFor("en-GB", preferences)).toEqual(preferences.secondaryVoice);
  expect(preferredVoiceFor("ja", preferences)).toBeUndefined();
  expect(preferredVoiceFor("en", DEFAULT_PREFERENCES)).toBeUndefined();
});

test("speaks with the chosen engine and current rate, while rechecking local availability", async () => {
  const preferred = { voiceName: "Alex", lang: "en-GB", extensionId: "local-engine" };
  const a = api();
  a.value.getVoices = async () => [...voices, { ...preferred, remote: false }];
  const controller = new SpeechController(a.value);
  await controller.speak("This is a voice preview.", "en", 0.8, preferred);
  expect(a.calls[0]?.options).toMatchObject({ voiceName: "Alex", extensionId: "local-engine", rate: 0.8, lang: "en" });
  a.value.getVoices = async () => voices;
  await controller.speak("A later preview.", "en", 1.4, preferred);
  expect(a.calls[1]?.options).toMatchObject({ voiceName: "Samantha", rate: 1.4 });
  expect(a.calls[1]?.options.extensionId).toBeUndefined();
});

test("passes language/rate/local voice and tracks completion", async () => {
  const a = api(); const states: string[] = []; const controller = new SpeechController(a.value, state => states.push(state));
  await controller.speak("A local test.", "en", 1.5);
  expect(a.calls[0]?.options).toMatchObject({ lang: "en", rate: 1.5, voiceName: "Samantha" });
  a.calls[0]!.options.onEvent?.({ type: "start" }); a.calls[0]!.options.onEvent?.({ type: "end" });
  expect(states.at(-1)).toBe("idle");
});

test("stopping during voice lookup prevents delayed speech", async () => {
  const a = api(); let resolve!: (value: typeof voices) => void;
  a.value.getVoices = () => new Promise(done => { resolve = done; });
  const controller = new SpeechController(a.value);
  const pending = controller.speak("A local test.", "en", 1);
  controller.stop(); resolve(voices); await pending;
  expect(a.calls).toEqual([]);
  expect(a.stops()).toBe(0);
});

test("stale start events cannot stop a newer utterance", async () => {
  const a = api(); const controller = new SpeechController(a.value);
  await controller.speak("A local test.", "en", 1);
  controller.stop();
  await controller.speak("A newer utterance.", "en", 1);
  const stops = a.stops();
  a.calls[0]!.options.onEvent?.({ type: "start" });
  expect(a.stops()).toBe(stops);
  controller.stop();
  expect(a.stops()).toBe(stops + 1);
});

test("an idle popup's controls and disposal do not stop another page's speech", async () => {
  const a = api(); const selection = new SpeechController(a.value); const popup = new SpeechController(a.value);
  await selection.speak("The selection is being read aloud.", "en", 1);
  a.calls[0]!.options.onEvent?.({ type: "start" });
  popup.stop(); popup.dispose();
  expect(a.stops()).toBe(0);
  selection.stop(); selection.dispose();
  expect(a.stops()).toBe(1);
});

test.each(["end", "interrupted", "cancelled", "error"] as const)("%s releases the utterance before disposal", async type => {
  const a = api(); const controller = new SpeechController(a.value);
  await controller.speak("A local test.", "en", 1);
  a.calls[0]!.options.onEvent?.({ type });
  controller.dispose();
  expect(a.stops()).toBe(0);
});

test("late events from a stopped page cannot stop another page", async () => {
  const a = api(); const first = new SpeechController(a.value); const second = new SpeechController(a.value);
  await first.speak("The first utterance.", "en", 1);
  first.dispose();
  await second.speak("The second utterance.", "en", 1);
  const stops = a.stops();
  a.calls[0]!.options.onEvent?.({ type: "start" });
  a.calls[0]!.options.onEvent?.({ type: "interrupted" });
  first.stop();
  expect(a.stops()).toBe(stops);
  second.stop();
  expect(a.stops()).toBe(stops + 1);
});

test("a failed speak releases its utterance", async () => {
  const a = api(); a.value.speak = async () => { throw new Error("Voice failed"); };
  const controller = new SpeechController(a.value);
  await expect(controller.speak("A local test.", "en", 1)).rejects.toThrow("Voice failed");
  controller.dispose();
  expect(a.stops()).toBe(0);
});

test("never speaks when there is no local voice; validates text and rate", async () => {
  const a = api(); const controller = new SpeechController(a.value);
  await expect(controller.speak("test", "ja", 1)).rejects.toThrow("local voice");
  await expect(controller.speak("", "en", 1)).rejects.toThrow();
  await expect(controller.speak("test", "en", Infinity)).rejects.toThrow();
  expect(a.calls).toEqual([]);
});

test("untrusted text cannot become SSML instructions", () => {
  expect(plainSpeech('<speak><audio src="https://example.com">hello</audio></speak>')).not.toContain("<");
  expect(plainSpeech("Hello world.")).toBe("Hello world.");
});
