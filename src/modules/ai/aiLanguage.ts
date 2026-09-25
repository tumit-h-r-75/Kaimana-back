// What language the AI answers in.
//
// Kaimana's readers are mostly not native English speakers, and an
// explanation you have to translate in your head is a worse explanation.
// Every AI feature takes a language, and the model is told to answer in it.
//
// Code is never translated: identifiers, keywords, operators and the names
// of complexity classes stay exactly as they are, because that is what the
// reader will type and search for.

/** The languages the interface offers. Anything else falls back to English. */
export const SUPPORTED_AI_LANGUAGES = {
  en: "English",
  bn: "Bangla (বাংলা)",
  hi: "Hindi (हिन्दी)",
  ur: "Urdu (اردو)",
  ar: "Arabic (العربية)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  pt: "Portuguese (Português)",
  id: "Indonesian (Bahasa Indonesia)",
  ru: "Russian (Русский)",
  zh: "Chinese (简体中文)",
  ja: "Japanese (日本語)",
} as const;

export type AiLanguageCode = keyof typeof SUPPORTED_AI_LANGUAGES;

export const isAiLanguage = (value: unknown): value is AiLanguageCode =>
  typeof value === "string" && value in SUPPORTED_AI_LANGUAGES;

export const resolveAiLanguage = (value: unknown): AiLanguageCode => (isAiLanguage(value) ? value : "en");

/**
 * The line appended to a system prompt. English adds nothing — the prompts
 * are written in English, and a redundant instruction is one more thing for
 * a small model to trip over.
 */
export const languageInstruction = (code: AiLanguageCode): string => {
  if (code === "en") return "";
  const name = SUPPORTED_AI_LANGUAGES[code];
  return [
    "",
    `Write your entire answer in ${name}.`,
    "Keep all code, identifiers, keywords, operators, file names and complexity notation (for example O(n log n)) exactly as they are, in English — do not translate or transliterate them.",
    "Use simple, everyday words; the reader is a student, not a translator.",
  ].join("\n");
};
