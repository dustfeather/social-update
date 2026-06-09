# Social Journal — Build Plan

**Goal:** Turn sporadic posting into a weekly habit. Daily collectors log activity into a
local DB; a local web UI generates copy-ready LinkedIn drafts on demand. No posting APIs,
nothing auto-published — copy/paste only.

**Audience:** Recruiters/peers in the user's LinkedIn network → drafts are professional,
concrete, first-person, no buzzwords/hype.

**Environment:** Originally WSL/localhost. **Migrated to k3s** (2026-06): DB + UI +
generation run in-cluster (`social.itguys.ro`, WARP-only); collectors stay local and push to
`/api/ingest`. See README "Deployment (k3s)". Collectors still need local `gh` +
`~/.claude/projects`; the `claude` CLI now runs in the cluster pod.

---

## Stack (resolved)

- **Backend:** TypeScript, compiled with `tsc` → `dist/`, run via `node`.
- **DB:** SQLite via `better-sqlite3`, single file, sole source of truth. **No Obsidian
  journal note is written** — the vault is read-only input only.
- **API:** Express.
- **Frontend:** React + Vite + TypeScript, built to static, served by Express.
- **Generation:** shell out to `claude -p --output-format json`.
- **Config:** `dotenv`.

## Config (`.env`)

| Key | Value / note |
|-----|--------------|
| `VAULT_PATH` | `~/obsidian.md` (symlink → `/mnt/c/Users/Catalin Teodorescu/OneDrive/Documents/Obsidian Vault`). Path has spaces → quote everywhere. OneDrive may touch mtimes + cloud-only placeholder files may read empty. |
| `CLAUDE_PROJECTS` | `~/.claude/projects` |
| `GITHUB_USER` | `dustfeather` |
| `PORT` | web server port |

`gh` CLI is already authenticated → GitHub collector reuses it (no `GITHUB_TOKEN` managed).

---

## Data model (SQLite)

### `items`
`id INTEGER PK, source TEXT, external_id TEXT, title TEXT, body TEXT, url TEXT,
occurred_at TEXT, iso_week TEXT, collected_at TEXT, raw_json TEXT`

- **`UNIQUE(source, external_id)` + `INSERT OR IGNORE`** = dedup. No `.state` files.
- `iso_week` = ISO `YYYY-Www` of **`occurred_at` (source event time)**, so late collection
  files items into the week they actually happened.

### `drafts`
`id INTEGER PK, created_at TEXT, iso_week TEXT, input_snapshot TEXT (json),
prompt_used TEXT, output TEXT (json array of drafts)`

---

## Collectors — backend-complete first

One `collect` entry point runs all three. Each maps source records → `items` rows.

1. **GitHub** — `gh api /users/dustfeather/events --paginate` (reuses gh auth → includes
   private events). `external_id` = event id, `occurred_at` = event `created_at`.
   Captures commits, PRs, releases, new repos.
2. **Obsidian** — walk `VAULT_PATH` for `*.md`. `external_id` = `path + contentHash`
   (dedup robust to OneDrive mtime drift). `occurred_at` = file mtime. Read-only on vault.
   Handle cloud-only placeholder files that read empty.
3. **Claude Code** — parse `~/.claude/projects/*/*.jsonl`, extract first user prompt per
   recently-modified session as a topic line. All projects, no exclusion.
   `external_id` = session id, `occurred_at` = session mtime. **Parse defensively** —
   JSONL schema drifts across CLI versions.

---

## API (Express)

- `GET /api/weeks` — distinct weeks present.
- `GET /api/items?week=YYYY-Www&page=&limit=` — paginated read-only viewer.
- `GET /api/drafts?week=` — draft history.
- `POST /api/generate {week, manualText}` — all current-week items + manual items +
  `prompt.txt` piped via stdin to `claude -p --output-format json`. Parse the envelope's
  `.result`; the model is instructed (via `prompt.txt`) to emit a **JSON array of drafts**
  (replaces the fragile `===DRAFT===` delimiter). Save a `drafts` row, return cards.

`prompt.txt` (voice instruction, deliberately strips marketing language) is **backend-only**,
edited by hand, not surfaced in the UI.

---

## Frontend (React + Vite)

Single screen:
- Week selector
- Paginated, read-only item list (no per-item toggles — the **whole week** is sent)
- Manual-items textarea (work/NDA items; user curates before ingest so persistence is OK)
- Generate button
- Draft cards with copy buttons

---

## Scheduling

Windows Task Scheduler runs daily:

```
wsl.exe -d <distro> node ~/projects/social-update/dist/collect.js
```

Fires even with no WSL shell open. No in-WSL cron/systemd. Documented in README + npm scripts.

---

## Build slices (git init, `main`, feature branch per slice)

1. **Scaffold** — `package.json`, `tsconfig.json`, `.gitignore` (node_modules, dist,
   `*.sqlite`, `.env`), `.env.example`, DB schema (`db.ts`), `prompt.txt`.
2. **GitHub collector** + `collect` entry point.
3. **Obsidian collector.**
4. **Claude Code collector.**
5. **API** — weeks + items endpoints.
6. **Generate endpoint** + `drafts` table + `claude` shell.
7. **React UI.**
8. **Task Scheduler wiring + README.**

---

## Open risk flags

- `claude -p --output-format json` envelope shape needs a live verify before slice 6.
- OneDrive cloud-only placeholder files may read empty — handle in Obsidian collector.
- `gh` must stay authenticated (confirmed).
- `~/.claude/projects/*.jsonl` schema drifts — defensive parsing in Claude collector.
