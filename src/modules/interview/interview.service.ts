// Service managing mock interview session state, transcripts, and AI dialogue.
//
// Follows the same "Plan B" philosophy as hint.service.ts: when
// GEMINI_API_KEY isn't configured, askAi returns null and every
// interviewer turn (opening question, follow-up, closing feedback) falls
// back to a deterministic, topic-keyed question bank so the interview
// still runs end to end with zero setup.

import { Types } from "mongoose";
import {
  InterviewSessionModel,
  type IInterviewMessage,
  type IInterviewSession,
} from "../../models/InterviewSession.model.js";
import { AIReportModel } from "../../models/AIReport.model.js";
import { AppError } from "../../utils/errors.js";
import { askAi, isAiConfigured, getLastAiErrorDetail } from "../ai/ai.service.js";

// Feedback previews on the session list are capped so a long AI report
// doesn't blow up the payload of an endpoint meant to stay light — the
// full text is always available from getSession().
const REPORT_SUMMARY_PREVIEW_LENGTH = 160;

// A candidate picks how many questions to answer on the start form (see
// app/interview/page.tsx); this is the range that's offered and enforced
// server-side, plus the default when nothing was chosen. Each session then
// stores its own totalQuestions (see InterviewSession.model.ts) so a
// session already in progress isn't affected by later changes here.
const MIN_TOTAL_QUESTIONS = 3;
const MAX_TOTAL_QUESTIONS = 10;
const DEFAULT_TOTAL_QUESTIONS = 5;

export const clampTotalQuestions = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TOTAL_QUESTIONS;
  return Math.min(Math.max(Math.round(n), MIN_TOTAL_QUESTIONS), MAX_TOTAL_QUESTIONS);
};

type Difficulty = "EASY" | "MEDIUM" | "HARD";

// Deterministic, topic-keyed fallback question bank. Mirrors the
// TAG_HINTS/DEFAULT_HINTS pattern in hint.service.ts.
const TOPIC_QUESTIONS: Record<string, string[]> = {
  arrays: [
    "Tell me how you'd approach finding two numbers in an array that sum to a target, and why.",
    "How would you find the largest sum of any contiguous subarray? Walk me through your thinking, not code.",
    "Suppose an array is almost sorted except for a couple of swapped elements — how would you detect and describe that?",
  ],
  strings: [
    "How would you check whether two strings are anagrams of each other, and what's the trade-off of your approach?",
    "Walk me through how you'd find the longest substring without repeating characters, conceptually.",
    "How would you determine if a string can be rearranged into a palindrome, and why does your approach work?",
  ],
  "dynamic-programming": [
    "How would you approach the classic 'climbing stairs' style problem, and what makes it a good fit for dynamic programming?",
    "Tell me how you'd think about the 0/1 knapsack problem — what state would you track and why?",
    "How would you explain the difference between memoization and tabulation to someone new to DP, using an example?",
  ],
  graphs: [
    "How would you decide between BFS and DFS to find the shortest path in an unweighted graph, and why?",
    "Tell me how you'd detect a cycle in a directed graph, conceptually.",
    "How would you approach finding the number of connected components in an undirected graph?",
  ],
  general: [
    "Tell me about a challenging technical problem you've solved recently and how you approached it.",
    "How do you typically decide which data structure to reach for when you first see a new problem?",
    "Walk me through how you'd estimate the time and space complexity of an approach before implementing it.",
  ],
};

const DEFAULT_TOPIC = "general";

const normalizeTopic = (topic: string): string => {
  const key = topic.trim().toLowerCase().replace(/\s+/g, "-");
  return TOPIC_QUESTIONS[key] ? key : DEFAULT_TOPIC;
};

const pickOpeningQuestion = (topic: string): string => {
  const bank = TOPIC_QUESTIONS[normalizeTopic(topic)] ?? TOPIC_QUESTIONS[DEFAULT_TOPIC];
  return bank[Math.floor(Math.random() * bank.length)];
};

// Plan-B has no way to judge free-text answer correctness without an AI
// call, so rather than silently skipping straight to the next question (the
// original bug this note exists to prevent), it says so honestly instead of
// pretending to grade the answer.
const NO_AI_TURN_NOTE =
  "(Automatic answer-checking wasn't available for that turn, so I can't confirm whether it was right — keep going, and double-check it yourself against the concept.)";

// Only ever adds anything when an AI provider (Groq and/or Gemini — see
// ai.service.ts) IS configured but the call still failed — i.e. never for
// a deployment that genuinely hasn't configured AI yet (that's expected
// Plan-B behavior and needs no explanation). Lets a real misconfiguration
// (bad key format, wrong model, quota, account issue) show up directly in
// the interview transcript, since server logs aren't always within reach
// when debugging a live deployment. `detail` is already provider-prefixed
// (e.g. "Groq: HTTP 404 ...") by ai.service.ts, so this message doesn't
// name a specific provider or env var itself — whichever one actually ran
// is named in `detail`.
const aiDebugSuffix = (): string => {
  if (!isAiConfigured()) return "";
  const detail = getLastAiErrorDetail();
  return ` [AI debug — an AI provider is configured but the call failed: ${detail ?? "unknown error"}]`;
};

// Cycles through the topic's bank as the interview progresses; once
// exhausted, falls back to a generic probing follow-up.
const pickFollowUpQuestion = (topic: string, candidateTurnIndex: number): string => {
  const bank = TOPIC_QUESTIONS[normalizeTopic(topic)] ?? TOPIC_QUESTIONS[DEFAULT_TOPIC];
  const genericFollowUps = [
    "Can you walk me through the time complexity of that approach?",
    "What's the space complexity of what you just described, and could you reduce it?",
    "Is there an edge case you'd want to double check before calling that solution done?",
  ];
  const next =
    candidateTurnIndex < bank.length
      ? bank[candidateTurnIndex]
      : genericFollowUps[(candidateTurnIndex - bank.length) % genericFollowUps.length];
  return `${NO_AI_TURN_NOTE}${aiDebugSuffix()} ${next}`;
};

const OPENING_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, a friendly but rigorous technical interviewer conducting a verbal-style mock coding interview.
Rules you must always follow:
- Ask exactly ONE open-ended interview question to start the interview.
- This is a verbal/conceptual interview question, NOT a full problem statement with formal input/output specs or test cases.
- Keep it to 1-3 sentences.
- Match the requested topic and difficulty.
- Do not answer your own question, and do not include any preamble like "Sure!" — output only the question.`;

// Both of these ask for JSON rather than prose. The judgement used to be
// glued to the front of the next question in one blob, which meant the
// verdict on an answer could not be stored beside that answer, could not be
// shown apart from the question, and could not be counted — "how many did
// they get right" was unanswerable without re-reading the transcript.
const FOLLOW_UP_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, continuing a live mock coding interview.

Reply with ONLY a JSON object, no markdown fence, in exactly this shape:
{"verdict":"correct"|"partial"|"incorrect","assessment":"...","question":"..."}

Rules:
- "verdict" judges the candidate's LAST answer. Judge every answer, including short, vague, wrong or nonsense ones. Never default to "correct" to be kind.
- "assessment" is 1-3 sentences saying why, in plain language. If the answer was wrong or incomplete, state what the right idea actually is at a conceptual level — never full code.
- "question" is exactly ONE new question, or a deeper probe on the weakness you just named. 1-3 sentences.
- Be encouraging but rigorous, like a real interviewer. Do not wave through an answer that was wrong.
- No preamble, no trailing commentary, no code fences. JSON only.`;

const CLOSING_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, wrapping up a mock coding interview.

Reply with ONLY a JSON object, no markdown fence, in exactly this shape:
{"summary":"...","rubric":{"correctness":N,"approach":N,"complexity":N,"communication":N},"overall":N}

Rules:
- Every N is an integer from 0 to 10.
- "summary" is 3-5 sentences grounded in what actually happened: refer to specific answers this candidate got right or wrong. No generic advice that would fit anyone.
- "correctness" is whether the answers were right. "approach" is how they reasoned toward them. "complexity" is whether they discussed time and space cost. "communication" is how clearly they explained themselves.
- "overall" reflects the four. If several answers were wrong, it must be low — do not soften it.
- No preamble, no code fences. JSON only.`;

/**
 * The conversation as the model sees it on the next turn.
 *
 * Past judgements are included, not just the questions. Without them the
 * model re-reads a transcript of bare questions and answers and has to
 * re-derive what it already decided, which is how a closing summary ends
 * up contradicting the verdicts given during the interview.
 */
const transcriptFor = (messages: IInterviewMessage[]): string =>
  messages
    .map((m) => {
      if (m.role === "candidate") return `Candidate: ${m.content}`;
      const judged = m.verdict ? ` [you judged the previous answer: ${m.verdict}${m.assessment ? ` — ${m.assessment}` : ""}]` : "";
      return `Interviewer:${judged} ${m.content}`;
    })
    .join("\n\n");

/**
 * Pulls a JSON object out of a model reply.
 *
 * Models fence JSON in ```json blocks about as often as they do not, and
 * occasionally add a sentence either side of it, whatever the prompt says.
 * Slicing from the first brace to the last is cheap and survives both.
 * Returns null rather than throwing, so every caller can fall back to the
 * prose path it had before.
 */
const extractJson = <T>(raw: string | null): T | null => {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
};

const VERDICTS = new Set(["correct", "partial", "incorrect"]);

/** Clamps a model-supplied rubric figure into the 0-10 the schema allows. */
const clampScore = (value: unknown): number | undefined => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.round(n), 0), 10);
};

const parseScore = (feedback: string): number | undefined => {
  const match = feedback.match(/score\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (Number.isNaN(value)) return undefined;
  return Math.min(Math.max(value, 0), 10);
};

// A function, not a constant, because the reason AI-scored feedback isn't
// available differs — genuinely unconfigured vs configured-but-failing —
// and saying "no AI provider is configured" when one actually IS
// configured (just failing) was actively misleading whoever was debugging
// a live deployment from this message alone.
const fallbackClosingFeedback = (): string => {
  const reason = isAiConfigured()
    ? `AI-scored feedback isn't available right now (the AI request failed).${aiDebugSuffix()}`
    : "AI-scored feedback isn't available right now (no AI provider is configured).";
  return `That wraps up this mock interview. ${reason} You can review your full transcript above to reflect on your answers, the clarity of your explanations, and whether you covered time/space complexity for each approach. Keep practicing — talking through your reasoning out loud, the way you just did, is exactly the skill real interviews test.`;
};

const loadOwnedSession = async (userId: string, sessionId: string) => {
  if (!Types.ObjectId.isValid(sessionId)) throw new AppError("Interview session not found.", 404);
  const session = await InterviewSessionModel.findById(sessionId);
  if (!session) throw new AppError("Interview session not found.", 404);
  if (String(session.userId) !== String(userId)) {
    throw new AppError("This interview session belongs to another user.", 403);
  }
  return session;
};

const startSession = async (
  userId: string,
  { topic, difficulty, totalQuestions }: { topic: string; difficulty: Difficulty; totalQuestions?: number },
) => {
  const prompt = `Topic: ${topic}\nDifficulty: ${difficulty}\n\nAsk the candidate their opening interview question now.`;
  const aiQuestion = await askAi({ system: OPENING_SYSTEM_PROMPT, prompt, maxTokens: 600 });
  const question = aiQuestion ?? pickOpeningQuestion(topic);

  const session = await InterviewSessionModel.create({
    userId,
    topic,
    difficulty,
    totalQuestions: clampTotalQuestions(totalQuestions),
    status: "in_progress",
    messages: [{ role: "interviewer", content: question, createdAt: new Date() }],
  });

  return session;
};

const respond = async (userId: string, sessionId: string, answer: string) => {
  const session = await loadOwnedSession(userId, sessionId);
  if (session.status === "completed") throw new AppError("This interview has already ended.", 400);

  session.messages.push({ role: "candidate", content: answer, createdAt: new Date() });

  const candidateTurns = session.messages.filter((m: IInterviewMessage) => m.role === "candidate").length;
  // Older sessions created before totalQuestions existed fall back to the
  // previous fixed length rather than reading undefined as 0 and closing
  // out immediately on their next answer.
  const totalQuestions = session.totalQuestions ?? DEFAULT_TOTAL_QUESTIONS;

  if (candidateTurns < totalQuestions) {
    const prompt = `Topic: ${session.topic}\nDifficulty: ${session.difficulty}\n\nConversation so far:\n${transcriptFor(session.messages)}\n\nJudge the last answer and ask your next question now.`;
    // The budget covers a judgement, a correction and a question, and the
    // model's own reasoning is charged against the same number.
    const raw = await askAi({ system: FOLLOW_UP_SYSTEM_PROMPT, prompt, maxTokens: 900 });
    const parsed = extractJson<{ verdict?: string; assessment?: string; question?: string }>(raw);

    if (parsed?.question) {
      session.messages.push({
        role: "interviewer",
        content: parsed.question.trim(),
        // Only trust a verdict the model actually gave us one of. Anything
        // else is left unset rather than guessed at — an invented "correct"
        // on the transcript is worse than a missing one.
        verdict: VERDICTS.has(String(parsed.verdict)) ? (parsed.verdict as IInterviewMessage["verdict"]) : undefined,
        assessment: parsed.assessment?.trim() || undefined,
        createdAt: new Date(),
      });
    } else {
      // Either no AI, or a reply we could not read. Both fall through to the
      // written bank, which says plainly that it could not grade the answer
      // rather than skipping silently past it.
      session.messages.push({
        role: "interviewer",
        content: raw?.trim() || pickFollowUpQuestion(session.topic, candidateTurns),
        createdAt: new Date(),
      });
    }
    await session.save();
    return session;
  }

  const prompt = `Topic: ${session.topic}\nDifficulty: ${session.difficulty}\n\nFull conversation:\n${transcriptFor(session.messages)}\n\nGive your closing assessment now.`;
  const raw = await askAi({ system: CLOSING_SYSTEM_PROMPT, prompt, maxTokens: 900 });
  const parsed = extractJson<{ summary?: string; overall?: unknown; rubric?: Record<string, unknown> }>(raw);

  const feedback = parsed?.summary?.trim() || raw?.trim() || fallbackClosingFeedback();
  // Prefer the structured figure; fall back to scraping "Score: N/10" out of
  // prose, which is what older sessions and a non-JSON reply still look like.
  const score = clampScore(parsed?.overall) ?? (raw ? parseScore(raw) : undefined);

  const rubric = parsed?.rubric
    ? {
        correctness: clampScore(parsed.rubric.correctness),
        approach: clampScore(parsed.rubric.approach),
        complexity: clampScore(parsed.rubric.complexity),
        communication: clampScore(parsed.rubric.communication),
      }
    : undefined;

  session.status = "completed";
  session.feedback = feedback;
  if (score !== undefined) session.score = score;
  // Only store a rubric where every dimension came back a number; a partial
  // one would render as a chart with silent gaps in it.
  if (rubric && Object.values(rubric).every((v) => v !== undefined)) {
    session.rubric = rubric as Required<typeof rubric>;
  }
  session.messages.push({ role: "interviewer", content: feedback, createdAt: new Date() });

  await session.save();

  // Best-effort: the interview itself already completed and saved above,
  // so a failure writing the AIReport copy must never fail this request.
  try {
    await AIReportModel.create({
      userId: session.userId,
      type: "interview",
      sourceId: session._id,
      topic: session.topic,
      difficulty: session.difficulty,
      score: session.score,
      summary: feedback,
    });
  } catch (reportError) {
    console.error(`Failed to save AI report for interview session ${session._id}:`, reportError);
  }

  return session;
};

const listSessions = async (userId: string) => {
  const sessions = await InterviewSessionModel.find({ userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .select("topic difficulty totalQuestions status score createdAt updatedAt messages")
    .lean<(IInterviewSession & { _id: Types.ObjectId })[]>();

  // Joins each completed session against its (much lighter) AIReport row
  // to surface a feedback preview here without ever loading `messages` —
  // that's the entire reason AIReport exists as its own collection.
  const completedIds = sessions.filter((s) => s.status === "completed").map((s) => s._id);
  const reports = completedIds.length
    ? await AIReportModel.find({ sourceId: { $in: completedIds } })
        .select("sourceId summary")
        .lean<{ sourceId: Types.ObjectId; summary: string }[]>()
    : [];
  const summaryBySourceId = new Map(reports.map((r) => [String(r.sourceId), r.summary]));

  return sessions.map((s) => {
    const fullSummary = summaryBySourceId.get(String(s._id));
    const reportSummary = fullSummary
      ? fullSummary.length > REPORT_SUMMARY_PREVIEW_LENGTH
        ? `${fullSummary.slice(0, REPORT_SUMMARY_PREVIEW_LENGTH)}…`
        : fullSummary
      : undefined;

    return {
      id: String(s._id),
      topic: s.topic,
      difficulty: s.difficulty,
      totalQuestions: s.totalQuestions ?? DEFAULT_TOTAL_QUESTIONS,
      status: s.status,
      score: s.score,
      createdAt: s.createdAt,
      // For a completed session, the moment it finished — how long it took.
      updatedAt: (s as { updatedAt?: Date }).updatedAt,
      messageCount: s.messages?.length ?? 0,
      reportSummary,
    };
  });
};

const getSession = async (userId: string, sessionId: string) => {
  return loadOwnedSession(userId, sessionId);
};

export const interviewService = { startSession, respond, listSessions, getSession };
