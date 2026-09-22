// Search text goes into a $regex, so it's matched literally: an unescaped
// "(" is an invalid pattern (a 500 on a public endpoint), and arbitrary or
// very long patterns are a cheap way to make the database do heavy work.
// Same helper problem.service.ts and admin.service.ts each keep locally.
export const MAX_SEARCH_LENGTH = 100;

export const toSearchRegex = (search: string) =>
  search.trim().slice(0, MAX_SEARCH_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words people type for a language, mapped to the stored value. */
export const LANGUAGE_ALIASES: Record<string, "python" | "cpp" | "javascript" | "typescript"> = {
  python: "python",
  py: "python",
  cpp: "cpp",
  "c++": "cpp",
  javascript: "javascript",
  js: "javascript",
  typescript: "typescript",
  ts: "typescript",
};
