import { spawn } from "child_process";
import os from "os";
import path from "path";
import { config } from "dotenv";

config({ quiet: true });

// Client for the summarizer model: headless `claude -p` on Haiku.
//
// It used to be a local llama.cpp router (qwen3.6-35b-a3b). That held ~7.9 GiB of
// the 8 GiB card and 6 of 8 cores for the whole run, at ~90s a session — a full
// backlog was an eight-hour night with the GPU unusable for anything else. Haiku
// does the same six-field fill in seconds, off the box, and runs several at once.
//
// Every call is stripped down to a bare completion:
//   - `--tools ""`             no tool surface for a transcript to inject into
//   - `--setting-sources ""`   no user/project settings, so none of this box's hooks,
//                              plugins or env-injected config fire on a summary
//   - `--strict-mcp-config`    no MCP servers booted per call
//   - `--no-session-persistence`  no transcript written. Without it every call lands
//                              in ~/.claude/projects and the NEXT collection picks
//                              its own summarizer runs up as sessions to summarize.
// `--bare` would do most of that in one flag, but it also skips the OAuth credential
// read, and the call then fails with `terminal_reason: api_error` and zero tokens.

export const LLM_MODEL = process.env.LLM_MODEL ?? "haiku";
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");
/** What the run logs as its backend; kept beside LLM_MODEL for the log line. */
export const LLM_BASE = `${CLAUDE_BIN} -p`;

// A wedged call must not hold a worker until the run's budget runs out.
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_S ?? 300) * 1000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatReply {
  text: string;
  ms: number;
  promptTokens: number;
  outputTokens: number;
}

/**
 * `claude -p` takes one system prompt and one user turn. A conversation with a
 * correction round (summarize.ts, tag-pass.ts) is folded into that single turn:
 * the earlier reply and the feedback on it are quoted, then the model answers again.
 */
function fold(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1) return { system, prompt: turns[0].content };
  const prompt = turns
    .map((m) =>
      m.role === "assistant"
        ? `<your_previous_reply>\n${m.content}\n</your_previous_reply>`
        : m === turns[0]
          ? m.content
          : `<feedback_on_previous_reply>\n${m.content}\n</feedback_on_previous_reply>`
    )
    .join("\n\n");
  return { system, prompt: `${prompt}\n\nReply again, in full, with the corrected output only.` };
}

// A rate limit is the subscription pacing several workers, not a broken transport.
// The callers' transport retries back off 3s/6s and stop the run after five in a row,
// so with four workers one limit would halt a backfill in seconds. Wait it out here.
const RATE_LIMIT_RETRIES = Number(process.env.LLM_RATE_LIMIT_RETRIES ?? 4);
const RATE_LIMIT_WAIT_MS = Number(process.env.LLM_RATE_LIMIT_WAIT_S ?? 60) * 1000;
const isRateLimit = (e: unknown) => /rate.?limit|overloaded|\b429\b|\b529\b|usage limit/i.test(String(e));

export async function chat(messages: ChatMessage[]): Promise<ChatReply> {
  for (let i = 0; ; i++) {
    try {
      return await chatOnce(messages);
    } catch (e) {
      if (i >= RATE_LIMIT_RETRIES || !isRateLimit(e)) throw e;
      await new Promise((r) => setTimeout(r, RATE_LIMIT_WAIT_MS * (i + 1)));
    }
  }
}

async function chatOnce(messages: ChatMessage[]): Promise<ChatReply> {
  const { system, prompt } = fold(messages);
  const t0 = Date.now();

  // The box's own steering (plugin dirs, mods) is passed in by env, not settings, so
  // `--setting-sources ""` alone does not keep it out of the child.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_PLUGIN_DIRS;

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p",
        "--model", LLM_MODEL,
        "--output-format", "json",
        "--tools", "",
        "--setting-sources", "",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--system-prompt", system,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env, cwd: os.tmpdir() }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      resolve(out);
    });
    child.stdin.end(prompt);
  });

  // Select the envelope by its `type` field, never by a line prefix: key order is not
  // an API, and the CLI already moved `type` off the front once.
  let envelope: any;
  for (const line of raw.split("\n")) {
    try {
      const v = JSON.parse(line);
      if (v && v.type === "result") envelope = v;
    } catch {
      // not JSON — not ours
    }
  }
  if (!envelope) throw new Error(`claude -p printed no result envelope: ${raw.trim().slice(0, 200)}`);
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(
      `claude -p error (${envelope.terminal_reason ?? envelope.subtype ?? "?"}): ` +
      String(envelope.result ?? "").slice(0, 200)
    );
  }

  return {
    text: envelope.result,
    ms: Date.now() - t0,
    promptTokens:
      (envelope.usage?.input_tokens ?? 0) +
      (envelope.usage?.cache_read_input_tokens ?? 0) +
      (envelope.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: envelope.usage?.output_tokens ?? 0,
  };
}
