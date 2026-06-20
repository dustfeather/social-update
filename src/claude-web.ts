import { config } from "dotenv";
import { insertItems } from "./sink";
import { firstText, isRealPrompt } from "./claude";
import type { ItemInput } from "./db";

config();

// claude.ai web conversations live behind the app's internal API, not on disk
// (unlike Claude Code sessions — see ./claude). The public Anthropic API is
// stateless and exposes no endpoint to list them.
//
// claude.ai is fronted by Cloudflare Turnstile, which loops forever on any
// freshly-launched automated browser (headless, headful, even stealth-patched)
// — so we DON'T launch one. Instead we attach over CDP to a real Chrome the
// user already runs and has cleared Cloudflare in during normal use. Requests
// run as same-origin fetch() in that genuine context: real TLS, live
// cf_clearance, the logged-in sessionKey already in its cookie jar.
//
// Enable by starting Chrome with a debug port and pointing CLAUDE_CDP_URL at it:
//   chrome --remote-debugging-port=9222 --user-data-dir=<dedicated-profile>
//   CLAUDE_CDP_URL="http://localhost:9222"
// Unset → collector is a no-op.
const CLAUDE_CDP_URL = process.env.CLAUDE_CDP_URL;
const CLAUDE_WEB_BASE = process.env.CLAUDE_WEB_BASE ?? "https://claude.ai";

const MAX_BODY = 4000;
const MAX_TITLE = 120;

type Getter = (pathname: string) => Promise<unknown>;

// Attach to the user's running Chrome over CDP and hand `fn` a same-origin JSON
// getter. Never closes the real browser — only disconnects, and only closes a
// page we created ourselves.
async function withClaudeApi<T>(fn: (get: Getter) => Promise<T>): Promise<T> {
  // Lazy import: keeps Playwright out of the cluster server's startup path
  // (it only ever runs the local collector). No browser download needed — we
  // attach to an external one.
  const { chromium } = await import("playwright");

  let browser;
  try {
    browser = await chromium.connectOverCDP(CLAUDE_CDP_URL!);
  } catch (e) {
    throw new Error(
      `cannot attach to Chrome at ${CLAUDE_CDP_URL} — start it with ` +
        `--remote-debugging-port and log into claude.ai (${(e as Error).message})`
    );
  }

  try {
    const ctx = browser.contexts()[0] ?? (await browser.newContext());

    // Reuse an existing claude.ai tab if one is open (already past Cloudflare);
    // otherwise open one in the genuine context.
    let page = ctx.pages().find((p) => p.url().startsWith(CLAUDE_WEB_BASE));
    const created = !page;
    if (!page) {
      page = await ctx.newPage();
      await page.goto(`${CLAUDE_WEB_BASE}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    }

    const get: Getter = (pathname) => {
      const url = pathname.startsWith("http") ? pathname : `${CLAUDE_WEB_BASE}${pathname}`;
      return page!.evaluate(async (u) => {
        const r = await fetch(u, {
          headers: { accept: "application/json" },
          credentials: "include",
        });
        if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
        return r.json();
      }, url);
    };

    try {
      return await fn(get);
    } finally {
      if (created) await page.close().catch(() => {});
    }
  } finally {
    // Over CDP this disconnects the client; it does NOT close the user's Chrome.
    await browser.close().catch(() => {});
  }
}

// Chat-capable org uuid, or null. An account can also carry an "api"-only org
// (e.g. a console org) whose chat endpoints 403 with "Invalid authorization for
// organization" — so prefer the org whose capabilities include "chat".
async function findOrgUuid(get: Getter): Promise<string | null> {
  const orgs = await get("/api/organizations");
  if (!Array.isArray(orgs)) return null;
  const hasUuid = (o: any) => o && typeof o.uuid === "string";
  const chat = orgs.find((o: any) => hasUuid(o) && Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
  const org = chat ?? orgs.find(hasUuid);
  return org ? (org as any).uuid : null;
}

// First genuine human prompt in a conversation, or null. Mirrors the local
// session logic: skip slash-command/caveat wrappers and tool results.
async function firstPrompt(get: Getter, org: string, convoId: string): Promise<string | null> {
  const detail = (await get(
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
  if (!CLAUDE_CDP_URL) return 0; // not enabled → nothing to collect

  const rows = await withClaudeApi(async (get) => {
    const org = await findOrgUuid(get);
    if (!org) return [];

    const convos = await get(`/api/organizations/${org}/chat_conversations`);
    if (!Array.isArray(convos)) return [];

    const out: ItemInput[] = [];
    for (const c of convos as any[]) {
      if (!c?.uuid) continue;

      // The conversation's auto-generated name is a good title; the first human
      // prompt is the richer body. Detail fetch can fail per-convo — degrade to
      // the name rather than dropping the item.
      let prompt: string | null = null;
      try {
        prompt = await firstPrompt(get, org, c.uuid);
      } catch {
        /* keep name-only */
      }

      const name = typeof c.name === "string" ? c.name.trim() : "";
      const title = name || (prompt ? prompt.split("\n")[0] : "") || "Conversation";
      const when = c.updated_at || c.created_at;

      out.push({
        source: "claude",
        external_id: `web:${c.uuid}`, // namespaced so it can't collide with a local session id
        title: `claude.ai: ${title}`.slice(0, MAX_TITLE),
        body: (prompt || name || title).slice(0, MAX_BODY),
        url: `${CLAUDE_WEB_BASE}/chat/${c.uuid}`,
        occurred_at: when ? new Date(when).toISOString() : null,
        raw_json: JSON.stringify({ uuid: c.uuid, name: c.name }),
      });
    }
    return out;
  });

  return insertItems(rows);
}
