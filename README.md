# Social Journal

Turn sporadic posting into a weekly habit. Daily collectors log your activity into a local
SQLite DB; a local web UI generates copy-ready LinkedIn drafts on demand.

**Nothing is auto-published.** No posting APIs — you copy/paste the drafts yourself. The
Obsidian vault is read-only input; no journal note is ever written.

## How it works

```
collectors ──► SQLite (items) ──► web UI ──► POST /api/generate ──► claude CLI ──► drafts
 github                                                                            (copy/paste)
 obsidian
 claude code
```

- **Collectors** map source records → `items` rows, deduped by `UNIQUE(source, external_id)`.
- **Generate** sends a week's items + your manual notes + `prompt.txt` to the local `claude`
  CLI, which returns a JSON array of drafts. Each generation is saved to `drafts`.

## Prerequisites

- Node.js (run inside WSL).
- Local **`claude` CLI**, authenticated (used by generation).
- **`gh` CLI**, authenticated (the GitHub collector reuses its auth → includes private events).
- `~/.claude/projects` present (Claude Code session logs).

## Setup

```bash
cp .env.example .env      # adjust paths/port if needed
npm install
npm run build:all         # compiles backend (tsc) + builds web/ (vite)
```

### `.env`

| Key | Meaning |
|-----|---------|
| `VAULT_PATH` | Obsidian vault root (read-only). `~` and `$HOME` are expanded; quote paths with spaces. |
| `CLAUDE_PROJECTS` | Claude Code session logs root (`~/.claude/projects`). |
| `GITHUB_USER` | GitHub username whose events the collector reads (via authed `gh`). |
| `GITHUB_EXCLUDE_REPOS` | Comma-separated `owner/repo` to drop from collection; trailing `/*` excludes a whole owner. Empty = none. Editable from the UI ("GitHub repo filter" panel) — saved here, applied on the next collection run. |
| `PORT` | Web server port (default 4000). |
| `DB_PATH` | SQLite file location. |

## Usage

```bash
npm run collect    # run all collectors once → upserts into the DB
npm start          # serve API + web UI at http://localhost:$PORT
```

Open the UI, pick a week, optionally add manual (work/NDA) items the collectors can't see,
and click **Generate**. Copy any draft card.

### Dev

```bash
npm run dev                  # backend tsc --watch
npm --prefix web run dev     # vite dev server (proxies /api → :4000)
```

## Scheduling (daily collection)

Windows Task Scheduler runs the collector daily — fires even with no WSL shell open. There is
no in-WSL cron/systemd.

`scripts/collect-task.cmd` invokes the collector through a WSL login shell and logs to
`collect.log`. Register it (run in **Windows** PowerShell/cmd, adjust the distro if needed):

```cmd
schtasks /Create /TN "SocialJournalCollect" /SC DAILY /ST 18:00 /F ^
  /TR "wsl.exe -d Ubuntu-24.04 -- bash -lic \"cd ~/projects/social-update && node dist/collect.js >> collect.log 2>&1\""
```

Or point the task at the committed script via its WSL path:
`\\wsl$\Ubuntu-24.04\home\<you>\projects\social-update\scripts\collect-task.cmd`.

Verify / remove:

```cmd
schtasks /Run    /TN "SocialJournalCollect"
schtasks /Query  /TN "SocialJournalCollect"
schtasks /Delete /TN "SocialJournalCollect" /F
```

## Data model

- **`items`** — `source, external_id, title, body, url, occurred_at, iso_week, collected_at,
  raw_json`. `iso_week` is the ISO week of `occurred_at`, so late collection files items into
  the week they actually happened.
- **`drafts`** — `created_at, iso_week, input_snapshot, prompt_used, output` (JSON draft array).

## Voice

`prompt.txt` holds the generation voice instruction (first-person, concrete, no marketing
hype). It is backend-only — edit it by hand; it is not surfaced in the UI.
