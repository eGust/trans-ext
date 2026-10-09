import { baseLanguage, canonicalLanguage } from "../core/language-routing";
import type { Preferences, VoicePreference } from "../core/preferences";

export type SpeechState = "idle" | "loading" | "speaking";
export interface SpeechAPI {
  getVoices(): Promise<chrome.tts.TtsVoice[]>;
  speak(text: string, options: chrome.tts.TtsOptions): Promise<void>;
  stop(): void;
}
export const MAX_SPEECH_LENGTH = 16_000;

export function voiceKey(voice: Pick<chrome.tts.TtsVoice, "voiceName" | "lang" | "extensionId">): string {
  return JSON.stringify([voice.voiceName, voice.lang?.toLowerCase(), voice.extensionId ?? ""]);
}
export function compatibleLocalVoices(voices: chrome.tts.TtsVoice[], language: string): (chrome.tts.TtsVoice & VoicePreference)[] {
  const wanted = new Intl.Locale(canonicalLanguage(language)).maximize();
  return voices.filter((voice): voice is chrome.tts.TtsVoice & VoicePreference => {
    if (voice.remote !== false || !voice.voiceName || !voice.lang) return false;
    try { const candidate = new Intl.Locale(voice.lang).maximize(); return candidate.language === wanted.language && candidate.script === wanted.script; }
    catch { return false; }
  });
}
export function localVoice(voices: chrome.tts.TtsVoice[], language: string, preferred?: VoicePreference): chrome.tts.TtsVoice | undefined {
  const compatible = compatibleLocalVoices(voices, language);
  return (preferred && compatible.find(voice => voiceKey(voice) === voiceKey(preferred)))
    || compatible.find(voice => voice.lang.toLowerCase() === language.toLowerCase()) || compatible[0];
}
export function preferredVoiceFor(language: string, preferences: Preferences): VoicePreference | undefined {
  const base = baseLanguage(language);
  if (base === baseLanguage(preferences.primaryLanguage)) return preferences.primaryVoice;
  if (base === baseLanguage(preferences.secondaryLanguage)) return preferences.secondaryVoice;
  return undefined;
}
export function speechFor(outcome: { sourceText: string; sourceLanguage: string; targetLanguage: string; translatedText: string }, which: "source" | "result") {
  return which === "source" ? { text: outcome.sourceText, language: outcome.sourceLanguage } : { text: outcome.translatedText, language: outcome.targetLanguage };
}
// chrome.tts can interpret a complete SSML document. Treat all user text literally.
export function plainSpeech(text: string): string { return text.replaceAll("<", "＜").replaceAll(">", "＞"); }

export class SpeechController {
  private generation = 0;
  private disposed = false;
  private utterance?: number;
  constructor(private api: SpeechAPI = chrome.tts, private onState: (state: SpeechState, error?: string) => void = () => {}) {}
  stop() {
    this.generation++;
    // stop() affects speech from every extension page. An idle controller must
    // not interrupt a selection tab when a popup changes or closes.
    if (this.utterance !== undefined) {
      this.utterance = undefined;
      this.api.stop();
    }
    if (!this.disposed) this.onState("idle");
  }
  dispose() { this.disposed = true; this.stop(); }
  async speak(text: string, language: string, rate: number, preferred?: VoicePreference) {
    if (!text.trim() || text.length > MAX_SPEECH_LENGTH) throw new Error("Speech requires 1–16,000 characters. Try a shorter passage.");
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) throw new Error("Choose a speech rate between 0.5× and 2×.");
    canonicalLanguage(language);
    if (this.disposed) return;
    this.stop();
    const generation = this.generation;
    this.onState("loading");
    try {
      const voices = await this.api.getVoices();
      if (generation !== this.generation || this.disposed) return;
      const voice = localVoice(voices, language, preferred);
      if (!voice) throw new Error("No local voice is ready for this language. Try again shortly or install a voice in your system settings. Online voices are not used.");
      this.utterance = generation;
      await this.api.speak(plainSpeech(text), {
        lang: language, voiceName: voice.voiceName, rate, enqueue: false,
        ...(voice.extensionId ? { extensionId: voice.extensionId } : {}),
        onEvent: event => {
          // Never stop from a stale callback: a newer utterance may belong to
          // another page, and the native stop API has no utterance identifier.
          if (this.utterance !== generation || this.disposed) return;
          if (event.type === "start" || event.type === "resume") this.onState("speaking");
          if (["end", "interrupted", "cancelled", "error"].includes(event.type)) {
            this.utterance = undefined;
            this.onState("idle", event.type === "error" ? "The system voice could not speak this text. Try another language or check your system voices." : undefined);
          }
        },
      });
    } catch (error) {
      if (this.utterance === generation) this.utterance = undefined;
      if (generation === this.generation && !this.disposed) { this.onState("idle"); throw error; }
    }
  }
}
