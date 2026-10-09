import type { DetectionAssessment } from "./language-routing";
import type { Preferences } from "./preferences";

type CompositionKey = Pick<KeyboardEvent, "isComposing" | "keyCode">;
type EscapeKey = CompositionKey & Pick<KeyboardEvent, "key" | "defaultPrevented">;

export function isComposingInput(event: CompositionKey, composing = false): boolean {
  return composing || event.isComposing || event.keyCode === 229;
}

export function escapeAction(
  event: EscapeKey,
  selection: boolean,
  working: boolean,
  composing = false,
): "cancel" | "close" | undefined {
  if (event.key !== "Escape" || event.defaultPrevented || isComposingInput(event, composing)) return;
  if (working) return "cancel";
  if (!selection) return "close";
}

export function languageSettingsChanged(previous: Preferences, next: Preferences): boolean {
  return previous.primaryLanguage !== next.primaryLanguage || previous.secondaryLanguage !== next.secondaryLanguage;
}

export function reusableSourceLanguage(source: string, detection?: DetectionAssessment): string | undefined {
  return source || (detection?.certain ? detection.language : undefined);
}

export function confidenceLabel(confidence: number | undefined): string | undefined {
  if (confidence === undefined || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return;
  return `${Math.round(confidence * 100)}% confidence`;
}
