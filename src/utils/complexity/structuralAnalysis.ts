// Lightweight, dependency-free static structural analysis for the
// Complexity Auditor (F4).
//
// A full formal-grammar AST parser per submission language (Python, C++,
// JavaScript) would normally mean pulling in a real parser per language —
// tree-sitter's WASM grammars are the standard choice, but loading WASM
// assets reliably from inside a Vercel serverless function bundle is a
// known source of silent production breakage that can't be verified
// without a live deploy. Rather than ship something that might 500 in
// production, this instead hand-rolls a small, real structural scanner:
// it tokenizes the actual submitted code (after stripping comments and
// string/char literals so a keyword inside a string never counts) and
// walks it to compute two concrete signals:
//   - maxLoopDepth: the deepest point of syntactically nested for/while
//     loops actually present in the code.
//   - usesRecursion: whether any user-defined function appears to call
//     itself.
// These are real, computed-from-the-actual-code signals — just not a
// full typed AST. audit.service.ts treats them as a secondary signal
// that corroborates (or flags disagreement with) the empirical
// measurement from curveFit.ts, which is the primary evidence.

export type JudgeLanguage = "python" | "cpp" | "javascript";

export interface StructuralSignal {
  maxLoopDepth: number;
  usesRecursion: boolean;
}

// Blanks out comments and string/char literal contents (replacing with
// spaces, preserving line structure) so a keyword like "for" appearing
// inside a string or comment is never mistaken for real code.
const stripCommentsAndStrings = (source: string, language: JudgeLanguage): string => {
  let out = "";
  let i = 0;
  const n = source.length;
  const isCLike = language === "cpp" || language === "javascript";

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (isCLike && ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (isCLike && ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (!isCLike && ch === "#") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    // Python triple-quoted strings/docstrings.
    if (!isCLike && (ch === '"' || ch === "'") && source[i + 1] === ch && source[i + 2] === ch) {
      const quote = ch.repeat(3);
      out += "   ";
      i += 3;
      while (i < n && source.slice(i, i + 3) !== quote) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "   ";
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += " ";
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
};

const tokenize = (source: string): string[] => source.match(/[A-Za-z_]\w*|[{}()]/g) ?? [];

// Brace-delimited languages (C++, JavaScript): a loop's body is either a
// `{...}` block or a single following statement. Only the `{...}` form is
// tracked — a braceless single-statement loop body is rare in formatted
// submissions and, when chained (`for(...) for(...) x++;`), is a
// deliberately out-of-scope edge case for a heuristic secondary signal.
const maxLoopNestingBraceStyle = (tokens: string[]): number => {
  const loopBraceIndices = new Set<number>();
  const LOOP_KEYWORDS = new Set(["for", "while"]);

  for (let i = 0; i < tokens.length; i += 1) {
    if (!LOOP_KEYWORDS.has(tokens[i])) continue;
    let j = i + 1;
    if (tokens[j] === "(") {
      let depth = 0;
      do {
        if (tokens[j] === "(") depth += 1;
        else if (tokens[j] === ")") depth -= 1;
        j += 1;
      } while (depth > 0 && j < tokens.length);
    }
    if (tokens[j] === "{") loopBraceIndices.add(j);
  }

  let braceDepth = 0;
  let curLoopDepth = 0;
  let maxLoopDepth = 0;
  const loopClosesAtDepth: number[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "{") {
      braceDepth += 1;
      if (loopBraceIndices.has(i)) {
        loopClosesAtDepth.push(braceDepth);
        curLoopDepth += 1;
        maxLoopDepth = Math.max(maxLoopDepth, curLoopDepth);
      }
    } else if (t === "}") {
      if (loopClosesAtDepth.length && loopClosesAtDepth[loopClosesAtDepth.length - 1] === braceDepth) {
        loopClosesAtDepth.pop();
        curLoopDepth -= 1;
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return maxLoopDepth;
};

// Python: loop bodies are indentation-delimited, so nesting is tracked by
// comparing each line's indent against a stack of open loop headers'
// indents rather than by matching braces.
const maxLoopNestingIndentStyle = (strippedSource: string): number => {
  const stack: number[] = [];
  let maxDepth = 0;

  for (const line of strippedSource.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    while (stack.length && indent <= stack[stack.length - 1]) stack.pop();
    if (/^[ \t]*(for|while)\b.*:\s*$/.test(line)) {
      stack.push(indent);
      maxDepth = Math.max(maxDepth, stack.length);
    }
  }

  return maxDepth;
};

// Best-effort: collects user-defined function names, then flags recursion
// if any of them is called (name followed by "(") more than once in the
// stripped source — i.e. at least once beyond its own definition. This
// can't distinguish "calls itself" from "is called twice from elsewhere"
// with certainty, which is exactly why this stays a secondary signal
// rather than being asserted as fact in the final report.
const detectsRecursion = (strippedSource: string, tokens: string[], language: JudgeLanguage): boolean => {
  const names = new Set<string>();
  if (language === "python") {
    for (const match of strippedSource.matchAll(/^\s*def\s+([A-Za-z_]\w*)\s*\(/gm)) names.add(match[1]);
  } else {
    for (const match of strippedSource.matchAll(/([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g)) names.add(match[1]);
  }
  names.delete("main");
  names.delete("if");
  names.delete("for");
  names.delete("while");
  names.delete("switch");

  if (!names.size) return false;

  const callCounts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i + 1] === "(" && names.has(tokens[i])) {
      callCounts.set(tokens[i], (callCounts.get(tokens[i]) ?? 0) + 1);
    }
  }
  for (const count of callCounts.values()) {
    if (count >= 2) return true;
  }
  return false;
};

export const analyzeStructure = (code: string, language: JudgeLanguage): StructuralSignal => {
  const stripped = stripCommentsAndStrings(code, language);
  const tokens = tokenize(stripped);

  const maxLoopDepth = language === "python" ? maxLoopNestingIndentStyle(stripped) : maxLoopNestingBraceStyle(tokens);
  const usesRecursion = detectsRecursion(stripped, tokens, language);

  return { maxLoopDepth, usesRecursion };
};
