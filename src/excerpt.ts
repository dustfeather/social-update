import fs from "fs";

// Deterministic transcript excerpting.
//
// This replaces the sub-agent that used to invent a `grep` per session. The point
// of doing it in JS is that the same transcript always yields the same excerpt:
// a local model gets one shot per session in an unattended run, so the input it
// reads has to be reproducible before a bad summary is debuggable at all.
//
// A transcript is mostly noise by volume. `attachment` lines, `thinking` blocks and
// full tool results account for the bulk of a 14 MB file while carrying almost none
// of what a summary needs, which is the human turns and what the assistant said it
// did. Tool calls are kept, but as one line each: *that* a file was edited or a
// command run is the spine of the session; the diff is not.

// Tool inputs have one field that says what the call was about, and the rest is
// payload. Ordered by how much it identifies the call.
const DIGEST_KEYS = [
  "command", "file_path", "path", "pattern", "notebook_path",
  "url", "query", "description", "prompt", "subagent_type",
];

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const squeeze = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

// One turn must never be able to starve the rest of the session. A pasted file or a
// long generated block arrives as a single turn of tens of thousands of characters;
// without a per-turn cap the head/tail packer cannot fit it anywhere and drops it
// whole, which is how a 13-turn session excerpted to 1851 characters. Eliding the
// middle keeps both ends — the opening of a turn says what it is, the end says how
// it resolved.
const TURN_MAX = 4000;
function capTurn(text: string): string {
  if (text.length <= TURN_MAX) return text;
  const keep = Math.floor((TURN_MAX - 40) / 2);
  return `${text.slice(0, keep)}\n[... ${text.length - keep * 2} chars elided ...]\n${text.slice(-keep)}`;
}

function digestToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const k of DIGEST_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 160);
  }
  return "";
}

function blockToText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, any>;
  switch (b.type) {
    case "text":
      return b.text ?? "";
    // Thinking is the model talking to itself. It is enormous and it is not what
    // happened — the tool calls and the final text are what happened.
    case "thinking":
    case "redacted_thinking":
      return "";
    case "tool_use":
      return `[tool ${b.name}] ${digestToolInput(b.input)}`;
    case "tool_result": {
      const c = b.content;
      const raw = typeof c === "string"
        ? c
        : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join(" ") : "";
      // A result matters as evidence of success or failure, not as data. 200 chars
      // is enough to carry an error string, which is the part a summary quotes.
      const head = squeeze(raw).slice(0, 200);
      return head ? `[result${b.is_error ? " ERROR" : ""}] ${head}` : "";
    }
    default:
      return "";
  }
}

/**
 * The working directory the session ran in, read from the transcript itself.
 *
 * The directory name under ~/.claude/projects is the cwd with every "/" replaced by
 * "-", which does not invert: a path containing a hyphen, a UUID or a temp
 * directory comes back shredded ("projects/flotila/9dcb0e32/0520/48d5/..."). Every
 * record carries the real `cwd`, so read it rather than trying to undo the mangling.
 */
export function sessionCwd(jsonlPath: string): string | null {
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o.cwd === "string" && o.cwd) return o.cwd;
    } catch { /* a truncated line is not worth failing over */ }
  }
  return null;
}

export interface Turn {
  role: string;
  text: string;
}

/** The conversation, as an ordered list of `{ role, text }`, noise removed. */
export function extractTurns(jsonlPath: string): Turn[] {
  const turns: Turn[] = [];
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    // Sidechain turns are a sub-agent's own conversation. They describe work the
    // main thread already reports, at several times the length.
    if (o.isSidechain) continue;
    const msg = o.message;
    if (!msg || typeof msg !== "object") continue;

    const content = msg.content;
    const parts = Array.isArray(content) ? content.map(blockToText) : [blockToText(content)];
    const text = squeeze(parts.filter(Boolean).join("\n").replace(SYSTEM_REMINDER, ""));
    if (!text) continue;
    turns.push({ role: msg.role ?? o.type, text: capTurn(text) });
  }
  return turns;
}

export interface Excerpt {
  text: string;
  turns: number;
  truncated: boolean;
  dropped?: number;
}

/**
 * A budget-bounded rendering of the session.
 *
 * When it does not fit, the tail is favoured over the head: the opening prompt is
 * what was *asked*, and the last turns are what was actually concluded and shipped.
 * A summary written from the head alone describes an intention — which is exactly
 * the failure the previous first-prompt collector had.
 */
export function excerpt(jsonlPath: string, { budgetChars = 24000 } = {}): Excerpt {
  const turns = extractTurns(jsonlPath);
  const rendered = turns.map((t) => `${t.role.toUpperCase()}: ${t.text}`);
  const full = rendered.join("\n\n");
  if (full.length <= budgetChars) return { text: full, turns: turns.length, truncated: false };

  const headBudget = Math.floor(budgetChars * 0.35);
  const tailBudget = budgetChars - headBudget;

  const head: string[] = [];
  let used = 0;
  for (const r of rendered) {
    if (used + r.length > headBudget) break;
    head.push(r); used += r.length;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = rendered.length - 1; i >= head.length; i--) {
    if (used + rendered[i].length > tailBudget) break;
    tail.unshift(rendered[i]); used += rendered[i].length;
  }
  // The final turn is the session's conclusion. If it alone overran the budget the
  // loop above kept nothing, which would hand the model a session with no ending.
  if (!tail.length && rendered.length > head.length) {
    tail.push(rendered[rendered.length - 1].slice(0, tailBudget));
  }
  const dropped = turns.length - head.length - tail.length;
  const text = [
    head.join("\n\n"),
    `\n[... ${dropped} turn(s) omitted from the middle of this session ...]\n`,
    tail.join("\n\n"),
  ].join("\n");
  return { text, turns: turns.length, truncated: true, dropped };
}
