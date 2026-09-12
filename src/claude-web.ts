import { config } from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { insertItems } from "./sink";
import { expandHome } from "./paths";
import type { ItemInput } from "./db";

config();

// claude.ai collection, payload-driven.
//
// The browser half of this cannot run unattended (see ./claude-web-script for
// why), so it is deliberately decoupled from the schedule: an attended Claude
// Code session runs the in-page script through the Chrome extension and drops
// the result here, and whichever collector run comes next picks it up. A
// missing or stale payload is a normal outcome, not a failure — the daily timer
// still collects every other source.
const PAYLOAD = expandHome(
  process.env.CLAUDE_WEB_PAYLOAD ??
    path.join(os.homedir(), ".cache", "social-update", "claude-web.json")
);
// Wide enough that a payload dropped yesterday evening still counts today, tight
// enough that a forgotten one stops quietly re-inserting the same week forever.
const MAX_AGE_HOURS = Number(process.env.CLAUDE_WEB_PAYLOAD_MAX_AGE_HOURS ?? 36);
const CLAUDE_WEB_BASE = process.env.CLAUDE_WEB_BASE ?? "https://claude.ai";

const MAX_BODY = 4000;
const MAX_TITLE = 120;

export interface RawConvo {
  uuid: string;
  name: string;
  updated_at: string | null;
  created_at: string | null;
  prompt: string | null;
}

// The conversation's auto-generated name is a good title; the first human prompt
// is the richer body.
function toItem(c: RawConvo): ItemInput {
  const name = (c.name ?? "").trim();
  const prompt = c.prompt?.trim() || null;
  const title = name || (prompt ? prompt.split("\n")[0] : "") || "Conversation";
  const when = c.updated_at || c.created_at;
  return {
    source: "claude",
    external_id: `web:${c.uuid}`, // namespaced so it can't collide with a local session id
    title: `claude.ai: ${title}`.slice(0, MAX_TITLE),
    body: (prompt || name || title).slice(0, MAX_BODY),
    url: `${CLAUDE_WEB_BASE}/chat/${c.uuid}`,
    occurred_at: when ? new Date(when).toISOString() : null,
    raw_json: JSON.stringify({ uuid: c.uuid, name: c.name }),
  };
}

// The payload is written by a model that was told to copy a tool result
// verbatim, so tolerate the code fence it sometimes adds anyway.
export function parsePayload(raw: string): RawConvo[] {
  const s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const parsed = JSON.parse(fence ? fence[1].trim() : s);
  if (!Array.isArray(parsed)) throw new Error("payload is not a JSON array");
  return parsed.filter((c: any) => c && typeof c.uuid === "string") as RawConvo[];
}

export async function collectClaudeWeb(): Promise<number> {
  if (!fs.existsSync(PAYLOAD)) {
    console.log(`[collect] claude-web: no payload at ${PAYLOAD} — run "npm run claude-web:script" (see README)`);
    return 0;
  }

  const ageHours = (Date.now() - fs.statSync(PAYLOAD).mtimeMs) / 3_600_000;
  if (ageHours > MAX_AGE_HOURS) {
    console.log(
      `[collect] claude-web: payload is ${ageHours.toFixed(0)}h old (max ${MAX_AGE_HOURS}h) — ignoring it; refresh it to collect claude.ai again`
    );
    return 0;
  }

  const rows = parsePayload(fs.readFileSync(PAYLOAD, "utf8"));
  const inserted = insertItems(rows.map(toItem));
  // Consume it: a payload left in place would keep looking fresh for a day and a
  // half, and the browser step is what makes it meaningful, not the file.
  fs.rmSync(PAYLOAD, { force: true });
  return inserted;
}
