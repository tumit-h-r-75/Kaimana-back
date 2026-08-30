// Service managing mock interview session state, transcripts, and AI dialogue.
//
// Follows the same "Plan B" philosophy as hint.service.ts: when
// ANTHROPIC_API_KEY isn't configured, askClaude returns null and every
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
import { askClaude } from "../ai/ai.service.js";

// Feedback previews on the session list are capped so a long AI report
// doesn't blow up the payload of an endpoint meant to stay light — the
// full text is always available from getSession().
const REPORT_SUMMARY_PREVIEW_LENGTH = 160;

// A candidate answers at most this many questions before the interview
// closes out with feedback and a score.
const MAX_CANDIDATE_TURNS = 5;

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

// Cycles through the topic's bank as the interview progresses; once
// exhausted, falls back to a generic probing follow-up.
const pickFollowUpQuestion = (topic: string, candidateTurnIndex: number): string => {
  const bank = TOPIC_QUESTIONS[normalizeTopic(topic)] ?? TOPIC_QUESTIONS[DEFAULT_TOPIC];
  if (candidateTurnIndex < bank.length) return bank[candidateTurnIndex];
  const genericFollowUps = [
    "Can you walk me through the time complexity of that approach?",
    "What's the space complexity of what you just described, and could you reduce it?",
    "Is there an edge case you'd want to double check before calling that solution done?",
  ];
  return genericFollowUps[(candidateTurnIndex - bank.length) % genericFollowUps.length];
};

const OPENING_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, a friendly but rigorous technical interviewer conducting a verbal-style mock coding interview.
Rules you must always follow:
- Ask exactly ONE open-ended interview question to start the interview.
- This is a verbal/conceptual interview question, NOT a full problem statement with formal input/output specs or test cases.
- Keep it to 1-3 sentences.
- Match the requested topic and difficulty.
- Do not answer your own question, and do not include any preamble like "Sure!" — output only the question.`;

const FOLLOW_UP_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, continuing a live mock coding interview.
Rules you must always follow:
- Ask exactly ONE natural follow-up question, or gently probe a weak point in the candidate's last answer.
- Keep it to 2-4 sentences.
- Never solve the problem for the candidate, and never reveal a full solution.
- Stay encouraging but rigorous, like a real technical interviewer.
- Output only the question/probe, no preamble.`;

const CLOSING_SYSTEM_PROMPT = `You are Kaimana's AI mock interviewer, wrapping up a mock coding interview.
Rules you must always follow:
- Give a brief, constructive 3-5 sentence summary of the candidate's performance across the conversation: strengths, and one or two areas to improve.
- Be encouraging but honest.
- End your response with a final line, on its own, in exactly this format: "Score: N/10" where N is an integer from 0 to 10.`;

const transcriptFor = (messages: IInterviewMessage[]): string =>
  messages.map((m) => `${m.role === "interviewer" ? "Interviewer" : "Candidate"}: ${m.content}`).join("\n\n");

const parseScore = (feedback: string): number | undefined => {
  const match = feedback.match(/score\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (Number.isNaN(value)) return undefined;
  return Math.min(Math.max(value, 0), 10);
};

const FALLBACK_CLOSING_FEEDBACK =
  "That wraps up this mock interview. AI-scored feedback isn't available right now (no AI provider is configured), but you can review your full transcript above to reflect on your answers, the clarity of your explanations, and whether you covered time/space complexity for each approach. Keep practicing — talking through your reasoning out loud, the way you just did, is exactly the skill real interviews test.";

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
  { topic, difficulty }: { topic: string; difficulty: Difficulty },
) => {
  const prompt = `Topic: ${topic}\nDifficulty: ${difficulty}\n\nAsk the candidate their opening interview question now.`;
  const aiQuestion = await askClaude({ system: OPENING_SYSTEM_PROMPT, prompt, maxTokens: 200 });
  const question = aiQuestion ?? pickOpeningQuestion(topic);

  const session = await InterviewSessionModel.create({
    userId,
    topic,
    difficulty,
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

  if (candidateTurns < MAX_CANDIDATE_TURNS) {
    const prompt = `Topic: ${session.topic}\nDifficulty: ${session.difficulty}\n\nConversation so far:\n${transcriptFor(session.messages)}\n\nAsk your next question or probe now.`;
    const aiFollowUp = await askClaude({ system: FOLLOW_UP_SYSTEM_PROMPT, prompt, maxTokens: 220 });
    const followUp = aiFollowUp ?? pickFollowUpQuestion(session.topic, candidateTurns);
    session.messages.push({ role: "interviewer", content: followUp, createdAt: new Date() });
    await session.save();
    return session;
  }

  const prompt = `Topic: ${session.topic}\nDifficulty: ${session.difficulty}\n\nFull conversation:\n${transcriptFor(session.messages)}\n\nGive your closing feedback and score now.`;
  const aiFeedback = await askClaude({ system: CLOSING_SYSTEM_PROMPT, prompt, maxTokens: 300 });
  const feedback = aiFeedback ?? FALLBACK_CLOSING_FEEDBACK;
  const score = aiFeedback ? parseScore(aiFeedback) : undefined;

  session.status = "completed";
  session.feedback = feedback;
  if (score !== undefined) session.score = score;
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
    .select("topic difficulty status score createdAt messages")
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
      status: s.status,
      score: s.score,
      createdAt: s.createdAt,
      messageCount: s.messages?.length ?? 0,
      reportSummary,
    };
  });
};

const getSession = async (userId: string, sessionId: string) => {
  return loadOwnedSession(userId, sessionId);
};

export const interviewService = { startSession, respond, listSessions, getSession };
