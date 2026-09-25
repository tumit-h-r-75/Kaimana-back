// A reading of a problem draft before anyone else has to read it.
//
// Sending a proposal costs gems, and a draft that comes back rejected for
// something the author could have seen — an unstated limit, no edge case in
// the tests, an example that does not match its own statement — costs them
// twice: the gems, and the time of whoever reviewed it.
//
// So the author gets the first review, from the model, on demand and before
// they send. It never rewrites the problem and never decides anything: it
// lists what a reviewer would ask about, and the author chooses.

import { askAi, isAiConfigured } from "./ai.service.js";
import { AppError } from "../../utils/errors.js";
import type { AiLanguageCode } from "./aiLanguage.js";

const MAX_STATEMENT_CHARS = 6000;
const MAX_TESTS_SHOWN = 8;

const SYSTEM_PROMPT = `You review a draft programming problem the way an editor does, before it is submitted.

Return ONLY JSON:
{"verdict":"ready"|"needs-work","notes":[{"kind":"statement"|"constraints"|"tests"|"examples","severity":"blocker"|"worth-fixing","note":"..."}],"missingCases":["..."]}

What to look for:
- statement: anything ambiguous — what the input format actually is, what to print when nothing matches, whether the input is sorted, whether values can repeat.
- constraints: limits that are not stated (sizes, value ranges, negatives, empty input), or limits that contradict the examples.
- tests: whether the given tests exercise more than the happy path.
- examples: an example whose output does not follow from its own statement.
- missingCases: concrete inputs worth adding as tests — describe them in words, do not write the test data.

Rules: at most six notes, most important first. Never rewrite the statement, never invent an intended solution, never write code. A blocker is something a reviewer would send it back for; anything else is worth-fixing.`;

const clip = (value: unknown, max: number) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…[cut]` : text;
};

export interface ProposalReviewNote {
  kind: string;
  severity: "blocker" | "worth-fixing";
  note: string;
}

export const reviewProposalDraft = async ({
  title,
  statement,
  constraints,
  difficulty,
  testCases,
  language,
}: {
  title?: unknown;
  statement?: unknown;
  constraints?: unknown;
  difficulty?: unknown;
  testCases?: unknown;
  language?: AiLanguageCode;
}) => {
  const draftTitle = String(title ?? "").trim();
  const draftStatement = String(statement ?? "").trim();
  if (draftStatement.length < 40) throw new AppError("Write the statement first — there is nothing to review yet.", 400);
  if (!isAiConfigured()) throw new AppError("The reviewer is not available right now.", 503);

  const tests = Array.isArray(testCases) ? testCases.slice(0, MAX_TESTS_SHOWN) : [];
  const renderedTests = tests
    .map((test, index) => {
      const entry = test as { input?: unknown; expectedOutput?: unknown; isSample?: unknown };
      return `Test ${index + 1}${entry.isSample ? " (shown to solvers)" : ""}:\ninput: ${clip(entry.input, 300)}\nexpected: ${clip(entry.expectedOutput, 300)}`;
    })
    .join("\n\n");

  const prompt = [
    draftTitle ? `Title: ${draftTitle}` : "Title: (none yet)",
    `Difficulty the author chose: ${String(difficulty ?? "unspecified")}`,
    `Statement:\n${clip(draftStatement, MAX_STATEMENT_CHARS)}`,
    `Constraints as written:\n${clip(constraints, 800) || "(none written)"}`,
    tests.length ? `The ${tests.length} test cases attached:\n${renderedTests}` : "No test cases attached yet.",
    "",
    "Review this draft.",
  ].join("\n\n");

  const raw = await askAi({ system: SYSTEM_PROMPT, prompt, maxTokens: 900, language });
  if (!raw) throw new AppError("The reviewer is busy right now. Try again in a moment.", 503);

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      verdict?: string;
      notes?: ProposalReviewNote[];
      missingCases?: string[];
    };
    const notes = (parsed.notes ?? [])
      .filter((note) => note && typeof note.note === "string")
      .slice(0, 6)
      .map((note) => ({
        kind: typeof note.kind === "string" ? note.kind : "statement",
        severity: note.severity === "blocker" ? ("blocker" as const) : ("worth-fixing" as const),
        note: note.note,
      }));
    return {
      verdict: parsed.verdict === "ready" && !notes.some((note) => note.severity === "blocker") ? "ready" : "needs-work",
      notes,
      missingCases: (parsed.missingCases ?? []).filter((entry): entry is string => typeof entry === "string").slice(0, 6),
    };
  } catch {
    // Prose rather than JSON is still a review; show it as one note.
    return { verdict: "needs-work" as const, notes: [{ kind: "statement", severity: "worth-fixing" as const, note: raw.trim() }], missingCases: [] };
  }
};

export const proposalReviewService = { reviewProposalDraft };
