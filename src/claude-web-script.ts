// The script that runs inside a logged-in claude.ai tab, and a tiny CLI that
// prints it.
//
// claude.ai conversations live behind the app's internal API, not on disk
// (unlike Claude Code sessions — see ./claude), and the public Anthropic API is
// stateless and exposes no endpoint to list them. Cloudflare Turnstile loops
// forever on any freshly-launched automated browser, so the only way in is a
// browser the user already cleared during normal use.
//
// That browser is reached through the Claude-in-Chrome extension, which is
// available only inside an INTERACTIVE Claude Code session: an unattended
// `claude -p --chrome` run is refused by an auto-mode safety classifier
// ("[Browser JS Exfil]") that sits outside the permission system, so
// --permission-mode bypassPermissions does not clear it. Hence the split — a
// human-attended session runs this script and drops the payload, and the
// collector picks the payload up whenever it next runs. See README.
// The payload comes back as a TOOL RESULT, which is capped at roughly a kilobyte
// — and an oversized one is TRUNCATED SILENTLY, which yields corrupt JSON rather
// than an error. Measured: a 10-conversation window with 600-char prompts is cut
// off inside the 4th record.
//
// So the browser step is paged: ask for `limit` conversations starting at
// `offset`, append each chunk, repeat until a chunk comes back short. Keep
// `promptChars` modest too — the body only feeds draft generation, where the
// opening of a prompt carries nearly all the signal.
//
// (The round trip exists only because the payload has to pass through the agent.
// The page can reach the ingest host directly — verified: an opaque no-cors
// response comes back — so allowing the claude.ai origin on POST /api/ingest
// would let the script post straight there and remove paging entirely.)
export function browserScript(
  since: Date,
  { offset = 0, limit = 2, promptChars = 300 } = {}
): string {
  return `
const SINCE = ${JSON.stringify(since.toISOString())};
const OFFSET = ${offset};
const LIMIT = ${limit};
const PROMPT_CHARS = ${promptChars};
const j = async (p) => {
  const r = await fetch(p, { headers: { accept: 'application/json' }, credentials: 'include' });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
};
const orgs = await j('/api/organizations');
// An account can also carry an "api"-only org (a console org) whose chat
// endpoints 403 with "Invalid authorization for organization".
const org = (orgs.find(o => o.capabilities && o.capabilities.includes('chat')) || orgs[0]).uuid;
const convos = await j('/api/organizations/' + org + '/chat_conversations');
const recent = convos
  .filter(c => c && c.uuid && (c.updated_at || c.created_at || '') >= SINCE)
  .sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''))
  .slice(OFFSET, OFFSET + LIMIT);
const out = [];
for (const c of recent) {
  let prompt = null;
  try {
    const d = await j('/api/organizations/' + org + '/chat_conversations/' + c.uuid + '?tree=True&rendering_mode=messages');
    for (const m of (d.chat_messages || [])) {
      if (m.sender !== 'human') continue;
      const parts = Array.isArray(m.content) ? m.content : [];
      const t = (parts.map(p => (p && p.type === 'text' ? p.text : '')).join('') || m.text || '').trim();
      // Skip the slash-command and caveat wrappers the apps inject, the same way
      // the local-session collector does.
      if (t && !/^<(command-|local-command|caveat)/.test(t)) { prompt = t.slice(0, PROMPT_CHARS); break; }
    }
  } catch (e) { /* keep the conversation, name-only */ }
  out.push({ uuid: c.uuid, name: c.name || '', updated_at: c.updated_at || null, created_at: c.created_at || null, prompt });
}
JSON.stringify(out);
`.trim();
}

if (require.main === module) {
  const days = Number(process.env.CLAUDE_WEB_LOOKBACK_DAYS ?? 7);
  process.stdout.write(
    browserScript(new Date(Date.now() - days * 86_400_000), {
      offset: Number(process.env.CLAUDE_WEB_OFFSET ?? 0),
      limit: Number(process.env.CLAUDE_WEB_LIMIT ?? 2),
      promptChars: Number(process.env.CLAUDE_WEB_PROMPT_CHARS ?? 300),
    }) + "\n"
  );
}
