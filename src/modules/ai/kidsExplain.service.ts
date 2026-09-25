// Bolt, explaining in words a child can read — and in their own language.
//
// Code Quest already tells a child what went wrong, from a written set of
// messages (lib/kids/pythonFeedback.ts). Those messages are good, and they
// are also fixed: they cannot look at what this child actually wrote. This
// can, and it says it the way the robot would.
//
// The hard rule here is different from the rest of the AI on this site: no
// code, ever, not even a corrected line. A child who is handed the answer
// learns that asking is how you finish a level.

import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured } from "./ai.service.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_CODE_CHARS = 1500;
const MAX_FIELD_CHARS = 300;

const SYSTEM_PROMPT = `You are Bolt, a friendly robot in a coding game for children aged 8 to 14. A child's program did not do what they wanted, and they have asked you why.

Say, in at most three short sentences:
1. What their program actually made you do.
2. What the level wanted instead.
3. One small thing to look at — a line, a number, an order — phrased as a question.

Rules:
- No code. Not one line, not one corrected statement, not even a fixed number.
- Short, plain words. Speak as "I" (you are the robot) and "you" (the child).
- Never say they are wrong or bad at this. Curious and calm, always.
- Never mention being an AI, a model, or a prompt.`;

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export const explainForKid = async ({
  levelTitle,
  goal,
  kind,
  program,
  expected,
  actual,
  error,
  language,
}: {
  levelTitle?: unknown;
  goal?: unknown;
  kind?: unknown;
  program?: unknown;
  expected?: unknown;
  actual?: unknown;
  error?: unknown;
  language?: AiLanguageCode;
}) => {
  const code = String(program ?? "").trim();
  if (!code) throw new AppError("There is no program to look at yet.", 400);
  if (!isAiConfigured()) throw new AppError("Bolt cannot talk right now.", 503);

  const isPuzzle = kind === "puzzle";
  const prompt = [
    `Level: ${clip(levelTitle, 120) || "a level"}`,
    `What the level asks for: ${clip(goal, 400) || "get it right"}`,
    isPuzzle ? `The blocks they put together:\n${clip(code, MAX_CODE_CHARS)}` : `The Python they wrote:\n${clip(code, MAX_CODE_CHARS)}`,
    expected ? `What should have happened: ${clip(expected, MAX_FIELD_CHARS)}` : "",
    actual ? `What happened instead: ${clip(actual, MAX_FIELD_CHARS)}` : "",
    error ? `The computer complained: ${clip(error, MAX_FIELD_CHARS)}` : "",
    "",
    "Tell them why, the way Bolt would.",
  ]
    .filter(Boolean)
    .join("\n");

  const explanation = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 300, language });
  if (!explanation) throw new AppError("Bolt is thinking about something else. Try again in a moment.", 503);

  // A model that ignores the no-code rule would hand a child the answer, so
  // the fence is cut out rather than trusted.
  return { explanation: explanation.replace(/```[\s\S]*?```/g, "").trim() };
};

export const kidsExplainService = { explainForKid };
