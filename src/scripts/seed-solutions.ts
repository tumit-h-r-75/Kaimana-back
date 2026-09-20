/**
 * Reference solutions, one per problem.
 *
 * The workspace only reveals these once a learner has solved the problem
 * themselves (see problem.service.ts). Until then they are the answer key;
 * after that they are what the AI hints deliberately withhold — a clean
 * version to compare your own against.
 *
 * Every solution here is verified against that problem's real test cases by
 * scripts/verify-solutions.ts before it is worth shipping. A wrong reference
 * solution is worse than none: it is wrong with authority.
 *
 *   npx tsx src/scripts/seed-solutions.ts
 */

import { pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { ProblemModel } from "../models/Problem.model.js";

/** slug -> Python 3 solution reading stdin, printing the expected output. */
export const SOLUTIONS: Record<string, string> = {
  "two-sum": `import sys

def main():
    data = sys.stdin.read().split()
    n, target = int(data[0]), int(data[1])
    nums = list(map(int, data[2:2 + n]))
    seen = {}
    for i, v in enumerate(nums):
        if target - v in seen:
            print(seen[target - v], i)
            return
        seen[v] = i

main()
`,
  "reverse-integer": `import sys

n = int(sys.stdin.read().strip())
sign = -1 if n < 0 else 1
value = sign * int(str(abs(n))[::-1])
# Python integers do not overflow, so the 32-bit bound the statement asks
# for has to be checked rather than relied on.
print(value if -(2 ** 31) <= value <= 2 ** 31 - 1 else 0)
`,
  "valid-parentheses": `import sys

s = sys.stdin.read().strip()
pairs = {")": "(", "]": "[", "}": "{"}
stack = []
for ch in s:
    if ch in "([{":
        stack.append(ch)
    elif not stack or stack.pop() != pairs[ch]:
        print("false")
        break
else:
    print("true" if not stack else "false")
`,
  "maximum-subarray": `import sys

data = sys.stdin.read().split()
nums = list(map(int, data[1:1 + int(data[0])]))
best = cur = nums[0]
for v in nums[1:]:
    cur = max(v, cur + v)
    best = max(best, cur)
print(best)
`,
  "merge-two-sorted-lists": `import sys

data = sys.stdin.read().split()
n, m = int(data[0]), int(data[1])
a = list(map(int, data[2:2 + n]))
b = list(map(int, data[2 + n:2 + n + m]))
out, i, j = [], 0, 0
while i < n and j < m:
    if a[i] <= b[j]:
        out.append(a[i]); i += 1
    else:
        out.append(b[j]); j += 1
out.extend(a[i:]); out.extend(b[j:])
print(" ".join(map(str, out)))
`,
  "binary-search": `import sys

data = sys.stdin.read().split()
n, target = int(data[0]), int(data[1])
nums = list(map(int, data[2:2 + n]))
lo, hi, found = 0, n - 1, -1
while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        found = mid
        break
    if nums[mid] < target:
        lo = mid + 1
    else:
        hi = mid - 1
print(found)
`,
  "climbing-stairs": `import sys

n = int(sys.stdin.read().strip())
a, b = 1, 1
for _ in range(n):
    a, b = b, a + b
print(a)
`,
  "longest-common-prefix": `import sys

lines = sys.stdin.read().split()
words = lines[1:1 + int(lines[0])]
prefix = words[0] if words else ""
for w in words[1:]:
    while not w.startswith(prefix):
        prefix = prefix[:-1]
print(prefix)
`,
  fizzbuzz: `import sys

n = int(sys.stdin.read().strip())
for i in range(1, n + 1):
    if i % 15 == 0:
        print("FizzBuzz")
    elif i % 3 == 0:
        print("Fizz")
    elif i % 5 == 0:
        print("Buzz")
    else:
        print(i)
`,
  "palindrome-number": `import sys

s = sys.stdin.read().strip()
print("true" if not s.startswith("-") and s == s[::-1] else "false")
`,

  "contains-duplicate": `import sys

data = sys.stdin.read().split()
nums = data[1:1 + int(data[0])]
print("true" if len(set(nums)) < len(nums) else "false")
`,
  "single-number": `import sys
from functools import reduce

data = sys.stdin.read().split()
nums = list(map(int, data[1:1 + int(data[0])]))
print(reduce(lambda a, b: a ^ b, nums))
`,
  "move-zeroes": `import sys

data = sys.stdin.read().split()
nums = list(map(int, data[1:1 + int(data[0])]))
write = 0
for i, v in enumerate(nums):
    if v != 0:
        nums[write], nums[i] = nums[i], nums[write]
        write += 1
print(" ".join(map(str, nums)))
`,
  "majority-element": `import sys

data = sys.stdin.read().split()
nums = list(map(int, data[1:1 + int(data[0])]))
count, candidate = 0, None
for v in nums:
    if count == 0:
        candidate = v
    count += 1 if v == candidate else -1
print(candidate)
`,
  "best-time-to-buy-and-sell": `import sys

data = sys.stdin.read().split()
prices = list(map(int, data[1:1 + int(data[0])]))
cheapest, best = prices[0], 0
for p in prices[1:]:
    best = max(best, p - cheapest)
    cheapest = min(cheapest, p)
print(best)
`,
  "valid-anagram": `import sys
from collections import Counter

a, b = sys.stdin.read().split()
print("true" if Counter(a) == Counter(b) else "false")
`,
  "intersection-of-arrays": `import sys

data = sys.stdin.read().split()
n = int(data[0])
a = set(data[1:1 + n])
m = int(data[1 + n])
b = set(data[2 + n:2 + n + m])
print(" ".join(map(str, sorted(map(int, a & b)))))
`,
  "plus-one": `import sys

data = sys.stdin.read().split()
digits = data[1:1 + int(data[0])]
value = int("".join(digits)) + 1
print(" ".join(str(value)))
`,
  "group-anagrams": `import sys
from collections import defaultdict

data = sys.stdin.read().split()
words = data[1:1 + int(data[0])]
groups = defaultdict(list)
for w in words:
    groups["".join(sorted(w))].append(w)
rows = [sorted(g) for g in groups.values()]
rows.sort(key=lambda g: g[0])
for row in rows:
    print(" ".join(row))
`,
  "product-except-self": `import sys

data = sys.stdin.read().split()
nums = list(map(int, data[1:1 + int(data[0])]))
n = len(nums)
out = [1] * n
prefix = 1
for i in range(n):
    out[i] = prefix
    prefix *= nums[i]
suffix = 1
for i in range(n - 1, -1, -1):
    out[i] *= suffix
    suffix *= nums[i]
print(" ".join(map(str, out)))
`,
  "longest-substring-no-repeat": `import sys

s = sys.stdin.read().strip()
last, start, best = {}, 0, 0
for i, ch in enumerate(s):
    if ch in last and last[ch] >= start:
        start = last[ch] + 1
    last[ch] = i
    best = max(best, i - start + 1)
print(best)
`,
  "three-sum": `import sys

data = sys.stdin.read().split()
nums = sorted(map(int, data[1:1 + int(data[0])]))
n, found = len(nums), set()
for i in range(n - 2):
    lo, hi = i + 1, n - 1
    while lo < hi:
        total = nums[i] + nums[lo] + nums[hi]
        if total == 0:
            found.add((nums[i], nums[lo], nums[hi]))
            lo += 1
            hi -= 1
        elif total < 0:
            lo += 1
        else:
            hi -= 1
print(len(found))
`,
  "container-with-most-water": `import sys

data = sys.stdin.read().split()
h = list(map(int, data[1:1 + int(data[0])]))
lo, hi, best = 0, len(h) - 1, 0
while lo < hi:
    best = max(best, (hi - lo) * min(h[lo], h[hi]))
    if h[lo] < h[hi]:
        lo += 1
    else:
        hi -= 1
print(best)
`,
  "coin-change": `import sys

data = sys.stdin.read().split()
n = int(data[0])
coins = list(map(int, data[1:1 + n]))
amount = int(data[1 + n])
INF = float("inf")
dp = [0] + [INF] * amount
for a in range(1, amount + 1):
    for c in coins:
        if c <= a and dp[a - c] + 1 < dp[a]:
            dp[a] = dp[a - c] + 1
print(dp[amount] if dp[amount] != INF else -1)
`,
  "number-of-islands": `import sys

lines = sys.stdin.read().split()
rows, cols = int(lines[0]), int(lines[1])
grid = [list(lines[2 + r]) for r in range(rows)]
count = 0
for r in range(rows):
    for c in range(cols):
        if grid[r][c] != "1":
            continue
        count += 1
        stack = [(r, c)]
        grid[r][c] = "0"
        while stack:
            y, x = stack.pop()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < rows and 0 <= nx < cols and grid[ny][nx] == "1":
                    grid[ny][nx] = "0"
                    stack.append((ny, nx))
print(count)
`,
  "course-schedule": `import sys
from collections import deque

data = sys.stdin.read().split()
n, m = int(data[0]), int(data[1])
adj = [[] for _ in range(n)]
indeg = [0] * n
idx = 2
for _ in range(m):
    a, b = int(data[idx]), int(data[idx + 1])
    idx += 2
    adj[b].append(a)
    indeg[a] += 1
queue = deque(i for i in range(n) if indeg[i] == 0)
seen = 0
while queue:
    node = queue.popleft()
    seen += 1
    for nxt in adj[node]:
        indeg[nxt] -= 1
        if indeg[nxt] == 0:
            queue.append(nxt)
print("true" if seen == n else "false")
`,
  "rotate-image": `import sys

data = sys.stdin.read().split()
n = int(data[0])
grid = [list(map(int, data[1 + r * n:1 + (r + 1) * n])) for r in range(n)]
for row in zip(*grid[::-1]):
    print(" ".join(map(str, row)))
`,
  "top-k-frequent": `import sys
from collections import Counter

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))
k = int(data[1 + n])
counts = Counter(nums)
order = sorted(counts, key=lambda v: (-counts[v], v))
print(" ".join(map(str, order[:k])))
`,
  "search-rotated-array": `import sys

data = sys.stdin.read().split()
n = int(data[0])
nums = list(map(int, data[1:1 + n]))
target = int(data[1 + n])
lo, hi, found = 0, n - 1, -1
while lo <= hi:
    mid = (lo + hi) // 2
    if nums[mid] == target:
        found = mid
        break
    if nums[lo] <= nums[mid]:
        if nums[lo] <= target < nums[mid]:
            hi = mid - 1
        else:
            lo = mid + 1
    else:
        if nums[mid] < target <= nums[hi]:
            lo = mid + 1
        else:
            hi = mid - 1
print(found)
`,
  subsets: `import sys

data = sys.stdin.read().split()
nums = sorted(map(int, data[1:1 + int(data[0])]))
seen = {()}
for v in nums:
    seen |= {tuple(sorted(s + (v,))) for s in seen}
print(len(seen))
`,
  "word-break": `import sys

data = sys.stdin.read().split()
s = data[0]
words = set(data[2:2 + int(data[1])])
dp = [True] + [False] * len(s)
for i in range(1, len(s) + 1):
    for j in range(i):
        if dp[j] and s[j:i] in words:
            dp[i] = True
            break
print("true" if dp[len(s)] else "false")
`,
  "median-two-sorted": `import sys

data = sys.stdin.read().split()
n = int(data[0])
a = list(map(int, data[1:1 + n]))
m = int(data[1 + n])
b = list(map(int, data[2 + n:2 + n + m]))
merged = sorted(a + b)
k = len(merged)
median = merged[k // 2] if k % 2 else (merged[k // 2 - 1] + merged[k // 2]) / 2
print(f"{median:.1f}")
`,
  "trapping-rain-water": `import sys

data = sys.stdin.read().split()
h = list(map(int, data[1:1 + int(data[0])]))
lo, hi = 0, len(h) - 1
left, right, total = 0, 0, 0
while lo < hi:
    if h[lo] < h[hi]:
        left = max(left, h[lo])
        total += left - h[lo]
        lo += 1
    else:
        right = max(right, h[hi])
        total += right - h[hi]
        hi -= 1
print(total)
`,
  "edit-distance": `import sys

a, b = sys.stdin.read().split()
prev = list(range(len(b) + 1))
for i in range(1, len(a) + 1):
    cur = [i] + [0] * len(b)
    for j in range(1, len(b) + 1):
        cur[j] = prev[j - 1] if a[i - 1] == b[j - 1] else 1 + min(prev[j - 1], prev[j], cur[j - 1])
    prev = cur
print(prev[len(b)])
`,
  "word-ladder": `import sys
from collections import deque
from string import ascii_lowercase

data = sys.stdin.read().split()
start, end = data[0], data[1]
words = set(data[3:3 + int(data[2])])
if end not in words:
    print(0)
else:
    queue = deque([(start, 1)])
    seen = {start}
    answer = 0
    while queue:
        word, depth = queue.popleft()
        if word == end:
            answer = depth
            break
        for i in range(len(word)):
            for ch in ascii_lowercase:
                nxt = word[:i] + ch + word[i + 1:]
                if nxt in words and nxt not in seen:
                    seen.add(nxt)
                    queue.append((nxt, depth + 1))
    print(answer)
`,
  "largest-rectangle-histogram": `import sys

data = sys.stdin.read().split()
heights = list(map(int, data[1:1 + int(data[0])])) + [0]
stack, best = [], 0
for i, h in enumerate(heights):
    while stack and heights[stack[-1]] >= h:
        height = heights[stack.pop()]
        left = stack[-1] + 1 if stack else 0
        best = max(best, height * (i - left))
    stack.append(i)
print(best)
`,
};

async function main() {
  await connectDatabase();
  let written = 0;
  let missing: string[] = [];

  for (const [slug, code] of Object.entries(SOLUTIONS)) {
    const res = await ProblemModel.updateOne(
      { slug },
      { $set: { referenceSolution: { language: "python", code } } },
    );
    if (res.matchedCount) written++;
    else missing.push(slug);
  }

  const total = await ProblemModel.countDocuments({ isPublished: true });
  const covered = await ProblemModel.countDocuments({ "referenceSolution.code": { $exists: true, $ne: "" } });
  console.log(`wrote ${written} reference solutions`);
  if (missing.length) console.log(`no such problem: ${missing.join(", ")}`);
  console.log(`coverage: ${covered}/${total} published problems`);

  await mongoose.disconnect();
  process.exit(0);
}

// Only when run directly. verify-solutions.ts imports SOLUTIONS from here,
// and a bare main() call would mean importing the table writes it to the
// database — the verifier would seed unverified solutions and then be killed
// by this file's process.exit before it had checked a single one.
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch(async (error) => {
    console.error("seed-solutions failed:", error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
