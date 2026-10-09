import { assessDetection, canonicalLanguage, chooseTarget, languageCandidates, validateText, type Detection, type DetectionAssessment, type LanguagePreferences } from "../core/language-routing";
import { TranslationError } from "../core/errors";

export type Availability = "available" | "downloadable" | "downloading" | "unavailable";
export type TranslationUpdate =
  | { stage: "detecting" | "translating" }
  | { stage: "detected"; assessment: DetectionAssessment; candidates: Detection[] }
  | { stage: "model"; model: "detector" | "translator"; availability: Availability }
  | { stage: "download"; model: "detector" | "translator"; progress?: number };
export interface TranslationRequest { text: string; sourceLanguageOverride?: string; targetLanguageOverride?: string }
export interface TranslationOutcome {
  kind: "translated";
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  effectiveSourceLanguage: string;
  effectiveTargetLanguage: string;
  translatedText: string;
  detectionConfidence?: number;
}
export type TranslationResult = TranslationOutcome | { kind: "uncertain"; assessment: DetectionAssessment; candidates: Detection[] };
export interface Pair { sourceLanguage: string; targetLanguage: string }
interface Session { destroy(): void }
interface Progress { loaded?: number; total?: number }
interface CreateOptions { signal?: AbortSignal; monitor?: (monitor: { addEventListener(type: "downloadprogress", listener: (event: Progress) => void): void }) => void }
export interface NativeEnvironment {
  LanguageDetector?: {
    availability(): Promise<string>;
    create(options?: CreateOptions): Promise<Session & { detect(text: string, options?: { signal?: AbortSignal }): Promise<Detection[]> }>;
  };
  Translator?: {
    availability(pair: Pair): Promise<string>;
    create(options: Pair & CreateOptions): Promise<Session & { translate(text: string, options?: { signal?: AbortSignal }): Promise<string> }>;
  };
}
export interface TranslateOptions { environment?: NativeEnvironment; signal?: AbortSignal; onUpdate?: (update: TranslationUpdate) => void }

export function downloadProgress({ loaded, total }: Progress): number | undefined {
  if (typeof loaded !== "number" || !Number.isFinite(loaded) || loaded < 0) return;
  if (total === undefined) return loaded <= 1 ? loaded : undefined;
  if (!Number.isFinite(total) || total <= 0) return;
  return Math.min(loaded / total, 1);
}
function availability(value: string): Availability {
  if (!["available", "downloadable", "downloading", "unavailable"].includes(value)) throw new TranslationError("unavailable", "This browser returned an unsupported model status. Update the browser and retry.");
  return value as Availability;
}

// Abort promptly even if a browser implementation fails to settle its promise.
// A session created after cancellation is still destroyed when it arrives.
export function cancellable<T>(pending: Promise<T>, signal?: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    pending.then(value => { if (signal?.aborted) onLate?.(value); else resolve(value); }, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
async function useSession<T extends Session, R>(pending: Promise<T>, signal: AbortSignal | undefined, use: (session: T) => Promise<R>): Promise<R> {
  const session = await cancellable(pending, signal, session => session.destroy());
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; session.destroy(); } };
  signal?.addEventListener("abort", destroy, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await cancellable(use(session), signal);
    signal?.throwIfAborted();
    return result;
  } finally { signal?.removeEventListener("abort", destroy); destroy(); }
}

export async function translate(request: TranslationRequest, preferences: LanguagePreferences, options: TranslateOptions = {}): Promise<TranslationResult> {
  const text = validateText(request.text);
  const environment = options.environment ?? (globalThis as NativeEnvironment);
  const { signal } = options;
  signal?.throwIfAborted();
  const emit = (update: TranslationUpdate) => { if (!signal?.aborted) options.onUpdate?.(update); };
  const monitor = (model: "detector" | "translator"): CreateOptions["monitor"] => monitor => monitor.addEventListener("downloadprogress", event => emit({ stage: "download", model, progress: downloadProgress(event) }));
  let sourceLanguage: string;
  let detectionConfidence: number | undefined;
  if (request.sourceLanguageOverride) sourceLanguage = canonicalLanguage(request.sourceLanguageOverride);
  else {
    if (!environment.LanguageDetector) throw new TranslationError("unavailable", "Automatic language detection is unavailable in this browser. Choose a source language, or update your desktop browser.");
    emit({ stage: "detecting" });
    const state = availability(await cancellable(environment.LanguageDetector.availability(), signal));
    emit({ stage: "model", model: "detector", availability: state });
    if (state === "unavailable") throw new TranslationError("unavailable", "The language detector model is unavailable. Choose a source language to continue.");
    signal?.throwIfAborted();
    const candidates = await useSession(environment.LanguageDetector.create({ signal, monitor: monitor("detector") }), signal, session => session.detect(text, { signal }));
    const assessment = assessDetection(text, candidates);
    emit({ stage: "detected", assessment, candidates });
    if (!assessment.certain || !assessment.language) return { kind: "uncertain", assessment, candidates };
    sourceLanguage = assessment.language;
    detectionConfidence = assessment.confidence;
  }
  const targetLanguage = chooseTarget(sourceLanguage, preferences, request.targetLanguageOverride);
  if (!environment.Translator) throw new TranslationError("unavailable", "On-device translation is unavailable in this browser. Use a recent desktop Chrome or Edge with native translation enabled.");
  let chosen: Pair | undefined;
  for (const source of languageCandidates(sourceLanguage)) {
    for (const target of languageCandidates(targetLanguage)) {
      signal?.throwIfAborted();
      const pair = { sourceLanguage: source, targetLanguage: target };
      let state: Availability;
      try { state = availability(await cancellable(environment.Translator.availability(pair), signal)); }
      catch (error) {
        signal?.throwIfAborted();
        // Some implementations reject unsupported variants instead of returning
        // "unavailable". Try only the already-vetted, script-preserving variants.
        if (error instanceof Error && error.name === "NotSupportedError") continue;
        throw error;
      }
      if (state !== "unavailable") {
        emit({ stage: "model", model: "translator", availability: state });
        chosen = pair;
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) throw new TranslationError("unavailable", "This language pair is unavailable on this browser. Choose another source or target language.");
  signal?.throwIfAborted();
  const translatedText = await useSession(environment.Translator.create({ ...chosen, signal, monitor: monitor("translator") }), signal, session => {
    emit({ stage: "translating" });
    return session.translate(text, { signal });
  });
  return { kind: "translated", sourceText: text, sourceLanguage, targetLanguage, effectiveSourceLanguage: chosen.sourceLanguage, effectiveTargetLanguage: chosen.targetLanguage, translatedText, detectionConfidence };
}
