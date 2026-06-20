import { config } from "dotenv";
import { insertItems } from "./sink";
import { firstText, isRealPrompt } from "./claude";
import type { ItemInput } from "./db";

config();

// claude.ai web conversations live behind the app's internal API, not on disk
// (unlike Claude Code sessions — see ./claude). Auth is the `sessionKey` cookie
// copied from a logged-in browser session. Unset → collector is a no-op.
const CLAUDE_SESSION_KEY = process.env.CLAUDE_SESSION_KEY;
const CLAUDE_WEB_BASE = process.env.CLAUDE_WEB_BASE ?? "https://claude.ai";

const MAX_BODY = 4000;
const MAX_TITLE = 120;

async function webGet(pathname: string): Promise<unknown> {
  const res = await fetch(new URL(pathname, CLAUDE_WEB_BASE), {
    headers: {
      cookie: `sessionKey=${CLAUDE_SESSION_KEY}`,
      accept: "application/json",
      // claude.ai rejects requests without a browser-ish UA.
      "user-agent": "Mozilla/5.0 social-update-collector",
    },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`claude.ai GET ${pathname} → ${res.status} ${detail}`);
  }
  return res.json();
}

// First account org uuid, or null if the session can't see one.
async function findOrgUuid(): Promise<string | null> {
  const orgs = await webGet("/api/organizations");
  if (!Array.isArray(orgs)) return null;
  const org = orgs.find((o) => o && typeof (o as any).uuid === "string");
  return org ? (org as any).uuid : null;
}

// First genuine human prompt in a conversation, or null. Mirrors the local
// session logic: skip slash-command/caveat wrappers and tool results.
async function firstPrompt(org: string, convoId: string): Promise<string | null> {
  const detail = (await webGet(
    `/api/organizations/${org}/chat_conversations/${convoId}?tree=True&rendering_mode=messages`
  )) as any;
  const msgs: any[] = Array.isArray(detail?.chat_messages) ? detail.chat_messages : [];
  for (const m of msgs) {
    if (m?.sender !== "human") continue;
    const text = (firstText(m.content) || (typeof m.text === "string" ? m.text : "")).trim();
    if (isRealPrompt(text)) return text;
  }
  return null;
}

export async function collectClaudeWeb(): Promise<number> {
  if (!CLAUDE_SESSION_KEY) return 0; // no cookie → nothing to collect

  const org = await findOrgUuid();
  if (!org) return 0;

  const convos = await webGet(`/api/organizations/${org}/chat_conversations`);
  if (!Array.isArray(convos)) return 0;

  const rows: ItemInput[] = [];
  for (const c of convos as any[]) {
    if (!c?.uuid) continue;

    // The conversation's auto-generated name is a good title; the first human
    // prompt is the richer body. Detail fetch can fail per-convo — degrade to
    // the name rather than dropping the item.
    let prompt: string | null = null;
    try {
      prompt = await firstPrompt(org, c.uuid);
    } catch {
      /* keep name-only */
    }

    const name = typeof c.name === "string" ? c.name.trim() : "";
    const title = name || (prompt ? prompt.split("\n")[0] : "") || "Conversation";
    const when = c.updated_at || c.created_at;

    rows.push({
      source: "claude",
      external_id: `web:${c.uuid}`, // namespaced so it can't collide with a local session id
      title: `claude.ai: ${title}`.slice(0, MAX_TITLE),
      body: (prompt || name || title).slice(0, MAX_BODY),
      url: `${CLAUDE_WEB_BASE}/chat/${c.uuid}`,
      occurred_at: when ? new Date(when).toISOString() : null,
      raw_json: JSON.stringify({ uuid: c.uuid, name: c.name }),
    });
  }

  return insertItems(rows);
}
