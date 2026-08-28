// Seeds the database with a starter set of problems + test cases so the
// judge pipeline (and the frontend problem list) has real data to work
// against. Run with: npm run seed

import { connectDatabase } from "../config/database.js";
import { ProblemModel } from "../models/Problem.model.js";
import { TestCaseModel } from "../models/TestCase.model.js";
import mongoose from "mongoose";

interface SeedTestCase {
  input: string;
  expectedOutput: string;
  isSample: boolean;
}

interface SeedProblem {
  slug: string;
  title: string;
  statement: string;
  inputFormat: string;
  outputFormat: string;
  constraints: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  tags: string[];
  basePoints: number;
  starterCode: { python: string; cpp: string; javascript: string };
  testCases: SeedTestCase[];
}

const problems: SeedProblem[] = [
  {
    slug: "two-sum",
    title: "Two Sum",
    statement:
      "Given an array of integers `arr` and an integer `target`, return the 0-indexed positions of the two numbers that add up to `target`. Each input has exactly one solution, and you may not use the same element twice.",
    inputFormat: "First line: n and target. Second line: n space-separated integers.",
    outputFormat: "Two space-separated indices (any valid order).",
    constraints: "2 <= n <= 10^4, -10^9 <= arr[i] <= 10^9",
    difficulty: "EASY",
    tags: ["array", "hashmap"],
    basePoints: 100,
    starterCode: {
      python: "def solve():\n    n, target = map(int, input().split())\n    arr = list(map(int, input().split()))\n    # write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; long long target;\n    cin >> n >> target;\n    vector<long long> arr(n);\n    for (auto &x : arr) cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst [n, target] = lines[0].split(' ').map(Number);\nconst arr = lines[1].split(' ').map(Number);\n// write your solution here\n",
    },
    testCases: [
      { input: "4 9\n2 7 11 15", expectedOutput: "0 1", isSample: true },
      { input: "3 6\n3 2 4", expectedOutput: "1 2", isSample: true },
      { input: "2 6\n3 3", expectedOutput: "0 1", isSample: false },
      { input: "5 -3\n-1 -2 -3 4 5", expectedOutput: "0 2", isSample: false },
      { input: "6 100\n10 20 30 40 25 75", expectedOutput: "4 5", isSample: false },
    ],
  },
  {
    slug: "reverse-integer",
    title: "Reverse Integer",
    statement: "Given a signed 32-bit integer `x`, return `x` with its digits reversed. Print 0 if reversing overflows a signed 32-bit range.",
    inputFormat: "A single integer x.",
    outputFormat: "The reversed integer.",
    constraints: "-2^31 <= x <= 2^31 - 1",
    difficulty: "EASY",
    tags: ["math"],
    basePoints: 100,
    starterCode: {
      python: "x = int(input())\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    long long x; cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const x = Number(require('fs').readFileSync(0, 'utf8').trim());\n// write your solution here\n",
    },
    testCases: [
      { input: "123", expectedOutput: "321", isSample: true },
      { input: "-123", expectedOutput: "-321", isSample: true },
      { input: "120", expectedOutput: "21", isSample: false },
      { input: "0", expectedOutput: "0", isSample: false },
      { input: "1534236469", expectedOutput: "0", isSample: false },
    ],
  },
  {
    slug: "valid-parentheses",
    title: "Valid Parentheses",
    statement: "Given a string containing only the characters `(`, `)`, `{`, `}`, `[`, `]`, determine if the string is valid: every open bracket must be closed by the same type, in the correct order.",
    inputFormat: "A single line string s.",
    outputFormat: "\"true\" or \"false\".",
    constraints: "1 <= s.length <= 10^4",
    difficulty: "EASY",
    tags: ["stack", "string"],
    basePoints: 100,
    starterCode: {
      python: "s = input()\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    string s; cin >> s;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const s = require('fs').readFileSync(0, 'utf8').trim();\n// write your solution here\n",
    },
    testCases: [
      { input: "()", expectedOutput: "true", isSample: true },
      { input: "()[]{}", expectedOutput: "true", isSample: true },
      { input: "(]", expectedOutput: "false", isSample: false },
      { input: "([)]", expectedOutput: "false", isSample: false },
      { input: "{[]}", expectedOutput: "true", isSample: false },
    ],
  },
  {
    slug: "maximum-subarray",
    title: "Maximum Subarray",
    statement: "Given an integer array `arr`, find the contiguous subarray (containing at least one number) with the largest sum, and return that sum. (Kadane's algorithm.)",
    inputFormat: "First line: n. Second line: n space-separated integers.",
    outputFormat: "The maximum subarray sum.",
    constraints: "1 <= n <= 10^5, -10^4 <= arr[i] <= 10^4",
    difficulty: "MEDIUM",
    tags: ["array", "dp"],
    basePoints: 250,
    starterCode: {
      python: "n = int(input())\narr = list(map(int, input().split()))\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; cin >> n;\n    vector<long long> arr(n);\n    for (auto &x : arr) cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst n = Number(lines[0]);\nconst arr = lines[1].split(' ').map(Number);\n// write your solution here\n",
    },
    testCases: [
      { input: "9\n-2 1 -3 4 -1 2 1 -5 4", expectedOutput: "6", isSample: true },
      { input: "1\n1", expectedOutput: "1", isSample: true },
      { input: "5\n5 4 -1 7 8", expectedOutput: "23", isSample: false },
      { input: "3\n-1 -2 -3", expectedOutput: "-1", isSample: false },
    ],
  },
  {
    slug: "merge-two-sorted-lists",
    title: "Merge Two Sorted Arrays",
    statement: "Given two sorted integer arrays, merge them into a single sorted array and print it space-separated.",
    inputFormat: "n, m on the first line. Then n sorted integers, then m sorted integers.",
    outputFormat: "The merged sorted array, space-separated.",
    constraints: "0 <= n, m <= 10^4",
    difficulty: "EASY",
    tags: ["array", "two-pointers"],
    basePoints: 150,
    starterCode: {
      python: "n, m = map(int, input().split())\na = list(map(int, input().split())) if n else []\nb = list(map(int, input().split())) if m else []\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n, m; cin >> n >> m;\n    vector<long long> a(n), b(m);\n    for (auto &x : a) cin >> x;\n    for (auto &x : b) cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst [n, m] = lines[0].split(' ').map(Number);\n// write your solution here\n",
    },
    testCases: [
      { input: "3 3\n1 2 4\n1 3 4", expectedOutput: "1 1 2 3 4 4", isSample: true },
      { input: "0 0", expectedOutput: "", isSample: true },
      { input: "1 0\n0", expectedOutput: "0", isSample: false },
    ],
  },
  {
    slug: "binary-search",
    title: "Binary Search",
    statement: "Given a sorted array `arr` of distinct integers and a target value, return the index of target if found, otherwise -1.",
    inputFormat: "n, target on the first line. Then n sorted integers.",
    outputFormat: "The index of target, or -1.",
    constraints: "1 <= n <= 10^5",
    difficulty: "EASY",
    tags: ["binary-search"],
    basePoints: 100,
    starterCode: {
      python: "n, target = map(int, input().split())\narr = list(map(int, input().split()))\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; long long target; cin >> n >> target;\n    vector<long long> arr(n);\n    for (auto &x : arr) cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst [n, target] = lines[0].split(' ').map(Number);\nconst arr = lines[1].split(' ').map(Number);\n// write your solution here\n",
    },
    testCases: [
      { input: "6 9\n-1 0 3 5 9 12", expectedOutput: "4", isSample: true },
      { input: "6 2\n-1 0 3 5 9 12", expectedOutput: "-1", isSample: true },
      { input: "1 5\n5", expectedOutput: "0", isSample: false },
    ],
  },
  {
    slug: "climbing-stairs",
    title: "Climbing Stairs",
    statement: "You are climbing a staircase with `n` steps. Each time you can climb 1 or 2 steps. In how many distinct ways can you climb to the top?",
    inputFormat: "A single integer n.",
    outputFormat: "The number of distinct ways.",
    constraints: "1 <= n <= 45",
    difficulty: "EASY",
    tags: ["dp"],
    basePoints: 100,
    starterCode: {
      python: "n = int(input())\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; cin >> n;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const n = Number(require('fs').readFileSync(0, 'utf8').trim());\n// write your solution here\n",
    },
    testCases: [
      { input: "2", expectedOutput: "2", isSample: true },
      { input: "3", expectedOutput: "3", isSample: true },
      { input: "5", expectedOutput: "8", isSample: false },
      { input: "10", expectedOutput: "89", isSample: false },
    ],
  },
  {
    slug: "longest-common-prefix",
    title: "Longest Common Prefix",
    statement: "Given n strings, find the longest common prefix string among them. If there is no common prefix, print an empty line.",
    inputFormat: "First line: n. Next n lines: one string each.",
    outputFormat: "The longest common prefix.",
    constraints: "1 <= n <= 200",
    difficulty: "EASY",
    tags: ["string"],
    basePoints: 100,
    starterCode: {
      python: "n = int(input())\nwords = [input() for _ in range(n)]\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; cin >> n;\n    vector<string> words(n);\n    for (auto &w : words) cin >> w;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst n = Number(lines[0]);\nconst words = lines.slice(1, n + 1);\n// write your solution here\n",
    },
    testCases: [
      { input: "3\nflower\nflow\nflight", expectedOutput: "fl", isSample: true },
      { input: "2\ndog\ncar", expectedOutput: "", isSample: true },
      { input: "1\nsingle", expectedOutput: "single", isSample: false },
    ],
  },
  {
    slug: "fizzbuzz",
    title: "FizzBuzz",
    statement: "Print numbers 1 to n, one per line. For multiples of 3 print \"Fizz\", for multiples of 5 print \"Buzz\", for multiples of both print \"FizzBuzz\".",
    inputFormat: "A single integer n.",
    outputFormat: "n lines, one entry per line.",
    constraints: "1 <= n <= 10^4",
    difficulty: "EASY",
    tags: ["implementation"],
    basePoints: 50,
    starterCode: {
      python: "n = int(input())\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n; cin >> n;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const n = Number(require('fs').readFileSync(0, 'utf8').trim());\n// write your solution here\n",
    },
    testCases: [
      { input: "3", expectedOutput: "1\n2\nFizz", isSample: true },
      { input: "5", expectedOutput: "1\n2\nFizz\n4\nBuzz", isSample: true },
      { input: "15", expectedOutput: "1\n2\nFizz\n4\nBuzz\nFizz\n7\n8\nFizz\nBuzz\n11\nFizz\n13\n14\nFizzBuzz", isSample: false },
    ],
  },
  {
    slug: "palindrome-number",
    title: "Palindrome Number",
    statement: "Given an integer x, print \"true\" if x is a palindrome, and \"false\" otherwise.",
    inputFormat: "A single integer x.",
    outputFormat: "\"true\" or \"false\".",
    constraints: "-2^31 <= x <= 2^31 - 1",
    difficulty: "EASY",
    tags: ["math"],
    basePoints: 100,
    starterCode: {
      python: "x = int(input())\n# write your solution here\n",
      cpp: "#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    long long x; cin >> x;\n    // write your solution here\n    return 0;\n}\n",
      javascript: "const x = Number(require('fs').readFileSync(0, 'utf8').trim());\n// write your solution here\n",
    },
    testCases: [
      { input: "121", expectedOutput: "true", isSample: true },
      { input: "-121", expectedOutput: "false", isSample: true },
      { input: "10", expectedOutput: "false", isSample: false },
      { input: "0", expectedOutput: "true", isSample: false },
    ],
  },
];

async function seed() {
  await connectDatabase();
  console.log(`Connected. Seeding ${problems.length} problems...`);

  for (const problemData of problems) {
    const { testCases, ...problemFields } = problemData;

    const problem = await ProblemModel.findOneAndUpdate(
      { slug: problemFields.slug },
      { ...problemFields, isPublished: true },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await TestCaseModel.deleteMany({ problemId: problem._id });
    await TestCaseModel.insertMany(
      testCases.map((testCase, index) => ({
        problemId: problem._id,
        input: testCase.input,
        expectedOutput: testCase.expectedOutput,
        isSample: testCase.isSample,
        order: index,
      })),
    );

    console.log(`  seeded: ${problem.slug} (${testCases.length} test cases)`);
  }

  console.log("Done.");
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
