// Execution Visualizer: records what a learner's own code did, line by line,
// so the workspace can scrub back and forth through it.
//
// The obvious design — install sys.settrace in the sandbox — has nowhere to
// live here: this server never runs code. Every execution goes out to a
// remote Judge0 instance over HTTP, so there is no interpreter of ours to
// instrument. Instead the user's source is wrapped in a harness that traces
// *itself*, and the whole thing is submitted as one ordinary program. The
// trace comes back on stdout behind a sentinel.
//
// Cost is why this never runs automatically. Tracing every line is far
// slower than running the code plainly, so it happens only when the learner
// asks for it, and normal submissions are untouched.

import { runProgram, type JudgeLanguage } from "../../integrations/judge0/judge0.service.js";
import { AppError } from "../../utils/errors.js";

/** Marks where the program's own output stops and the trace begins. */
const SENTINEL = "<<<KAIMANA_TRACE_a7f3e1>>>";

/** Frames kept after sampling. Beyond this the harness thins evenly. */
const MAX_FRAMES = 2000;

/**
 * Ceiling on the serialised trace. Judge0 truncates stdout at its own limit,
 * and a truncated JSON document parses as nothing — so the harness thins the
 * trace until it fits rather than letting the whole thing be lost.
 */
const MAX_TRACE_BYTES = 400_000;

/** Frames are what gets scrubbed, so detail is sacrificed before dropping below this. */
const MIN_FRAMES = 150;

/** Tracing multiplies runtime, so a traced run gets more room than a plain one. */
const TRACE_TIME_LIMIT_MS = 6000;
const TRACE_MEMORY_LIMIT_MB = 256;

/** A serialised value, shaped so the client can pick a rendering for it. */
export type TraceValue =
  | { t: "s"; v: string | number | boolean | null }
  | { t: "l" | "e"; v: TraceValue[]; n: number }
  | { t: "d"; v: [string, TraceValue][]; n: number }
  | { t: "r"; v: string };

export interface TraceFrame {
  /** 1-based line in the learner's source. */
  l: number;
  /** Call depth, 1 at module level. */
  d: number;
  /** Enclosing function name, "<module>" at top level. */
  fn: string;
  /** Locals visible at that line. */
  v: Record<string, TraceValue>;
}

export interface TraceResult {
  frames: TraceFrame[];
  /** 1 = every line kept; 2 = every other, and so on. */
  stride: number;
  truncated: boolean;
  /** The exception that ended the program, if any. */
  error: string | null;
  /** Whatever the program itself printed. */
  stdout: string;
}

/**
 * The tracer, as Python source.
 *
 * Notes that matter:
 * - The learner's code is compiled under a known filename and the tracer
 *   returns None for frames from anywhere else, so stepping never wanders
 *   into the standard library.
 * - Depth is counted by walking f_back while the filename still matches, so
 *   a recursive call reads as depth 2, 3, ... and the client can draw a tree.
 * - When the buffer fills it is halved in place and the sampling stride
 *   doubles. That bounds memory without deciding up front how long the run
 *   is, and keeps the kept frames spread evenly across the whole execution
 *   rather than stopping dead at frame 2000.
 * - Serialisation is depth- and length-capped. A learner's list can hold a
 *   million items, and Judge0 caps stdout.
 */
const HARNESS = (sourceLiteral: string) => `import sys as _k_sys, json as _k_json

_K_FILE = "<kaimana>"
_K_MAX = ${MAX_FRAMES}
_K_BUDGET = ${MAX_TRACE_BYTES}
_K_FLOOR = ${MIN_FRAMES}
_K_ITEMS = 48
_K_STR = 120

_k_frames = []
_k_stride = 1
_k_seen = 0

def _k_short(s):
    return s if len(s) <= _K_STR else s[:_K_STR] + "\\u2026"

def _k_value(v, depth=0):
    if v is None or isinstance(v, (bool, int, float)):
        # json cannot encode inf/nan; fall back to their repr.
        if isinstance(v, float) and (v != v or v in (float("inf"), float("-inf"))):
            return {"t": "r", "v": repr(v)}
        return {"t": "s", "v": v}
    if isinstance(v, str):
        return {"t": "s", "v": _k_short(v)}
    if depth >= 2:
        try:
            return {"t": "r", "v": _k_short(repr(v))}
        except Exception:
            return {"t": "r", "v": "<unrepresentable>"}
    if isinstance(v, (list, tuple)):
        return {"t": "l", "v": [_k_value(x, depth + 1) for x in list(v)[:_K_ITEMS]], "n": len(v)}
    if isinstance(v, (set, frozenset)):
        return {"t": "e", "v": [_k_value(x, depth + 1) for x in list(v)[:_K_ITEMS]], "n": len(v)}
    if isinstance(v, dict):
        out = []
        for i, (k, val) in enumerate(v.items()):
            if i >= _K_ITEMS:
                break
            out.append([_k_short(str(k)), _k_value(val, depth + 1)])
        return {"t": "d", "v": out, "n": len(v)}
    try:
        return {"t": "r", "v": _k_short(repr(v))}
    except Exception:
        return {"t": "r", "v": "<unrepresentable>"}

def _k_locals(frame):
    out = {}
    try:
        items = list(frame.f_locals.items())
    except Exception:
        return out
    for name, val in items[:_K_ITEMS]:
        if name.startswith("__") or name.startswith("_k_") or name.startswith("_K_"):
            continue
        try:
            out[name] = _k_value(val)
        except Exception:
            out[name] = {"t": "r", "v": "<unrepresentable>"}
    return out

def _k_depth(frame):
    n = 0
    f = frame
    while f is not None and f.f_code.co_filename == _K_FILE:
        n += 1
        f = f.f_back
    return n

def _k_tracer(frame, event, arg):
    global _k_seen, _k_stride, _k_frames
    if frame.f_code.co_filename != _K_FILE:
        return None
    if event in ("line", "return"):
        if _k_seen % _k_stride == 0:
            _k_frames.append({
                "l": frame.f_lineno,
                "d": _k_depth(frame),
                "fn": frame.f_code.co_name,
                "v": _k_locals(frame),
            })
            if len(_k_frames) >= _K_MAX * 2:
                _k_frames = _k_frames[::2]
                _k_stride *= 2
        _k_seen += 1
    return _k_tracer

_k_source = ${sourceLiteral}
_k_error = None
_k_globals = {"__name__": "__main__", "__file__": _K_FILE}

try:
    _k_code = compile(_k_source, _K_FILE, "exec")
except SyntaxError as _k_e:
    _k_error = "SyntaxError: " + str(_k_e)
    _k_code = None

if _k_code is not None:
    _k_sys.settrace(_k_tracer)
    try:
        exec(_k_code, _k_globals)
    except BaseException as _k_e:
        _k_error = type(_k_e).__name__ + ": " + str(_k_e)
    finally:
        _k_sys.settrace(None)

_k_payload = {
    "frames": _k_frames[:_K_MAX],
    "stride": _k_stride,
    "truncated": _k_stride > 1,
    "error": _k_error,
}

# A frame count alone does not bound the output: 2000 frames each holding a
# DP grid is megabytes, and Judge0 truncates stdout mid-JSON, which parses as
# nothing at all. So measure the real thing and shrink it until it fits.
#
# Order matters. Dropping frames first is what a naive version does, and on a
# 60x60 DP table it thins to a handful of frames — technically within budget,
# useless to scrub. Frames are the thing being visualised, so they are thinned
# only to a floor; past that it is the values that get summarised, because a
# grid you can step through beats a grid you can read once.
def _k_size(p):
    return len(_k_json.dumps(p, default=repr))

def _k_thin(p, floor):
    while _k_size(p) > _K_BUDGET and len(p["frames"]) > floor:
        p["frames"] = p["frames"][::2]
        p["stride"] *= 2
        p["truncated"] = True

def _k_summarise(p, min_n):
    # Replace collections with a note of their shape, largest first.
    names = {"l": "list", "e": "set", "d": "dict"}
    for fr in p["frames"]:
        for key in list(fr["v"].keys()):
            val = fr["v"][key]
            if isinstance(val, dict) and val.get("t") in names and val.get("n", 0) >= min_n:
                fr["v"][key] = {"t": "r", "v": "<%s of %d>" % (names[val["t"]], val["n"])}
    p["summarised"] = True

_k_thin(_k_payload, _K_FLOOR)
if _k_size(_k_payload) > _K_BUDGET:
    _k_summarise(_k_payload, 8)
if _k_size(_k_payload) > _K_BUDGET:
    _k_summarise(_k_payload, 0)
_k_thin(_k_payload, 8)
_k_text = _k_json.dumps(_k_payload, default=repr)

_k_sys.stdout.write("\\n${SENTINEL}\\n")
_k_sys.stdout.write(_k_text)
`;

/**
 * JSON string syntax is a subset of Python's, so a JSON-encoded string is a
 * valid Python literal — which keeps the learner's code away from the
 * harness's own indentation instead of being spliced into it.
 */
const pythonLiteral = (source: string) => JSON.stringify(source);

export const traceExecution = async ({
  language,
  source,
}: {
  language: JudgeLanguage;
  source: string;
}): Promise<TraceResult> => {
  // Python first: the harness is sys.settrace, which has no equivalent in the
  // other three runtimes here. The client hides the button for the rest.
  if (language !== "python") {
    throw new AppError("The execution visualizer currently supports Python only.", 400);
  }

  const execution = await runProgram({
    language,
    source: HARNESS(pythonLiteral(source)),
    stdin: "",
    timeLimitMs: TRACE_TIME_LIMIT_MS,
    memoryLimitMb: TRACE_MEMORY_LIMIT_MB,
  });

  if (execution.outcome === "TIME_LIMIT_EXCEEDED") {
    throw new AppError("This program takes too long to visualise. Try it on a smaller input.", 422);
  }

  const marker = execution.stdout.lastIndexOf(SENTINEL);
  if (marker === -1) {
    // No sentinel means the process died before the harness could report —
    // a memory limit, or a hard exit from the learner's own code.
    throw new AppError(
      execution.stderr.trim() || "The run ended before a trace could be recorded.",
      422,
    );
  }

  const printed = execution.stdout.slice(0, marker).replace(/\n$/, "");
  let parsed: Omit<TraceResult, "stdout">;
  try {
    parsed = JSON.parse(execution.stdout.slice(marker + SENTINEL.length));
  } catch {
    // Judge0 truncates stdout past its own limit, which lands mid-JSON.
    throw new AppError("This program produced more trace data than can be returned. Try a smaller input.", 422);
  }

  return { ...parsed, stdout: printed };
};

export const traceService = { traceExecution };
