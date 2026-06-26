# Vault-Keeper — Spec & Runbook

Status: **planned** (design resolved via grill 2026-06-25, not yet built).
Extends this repo (`social-update`). Supersedes the on-demand web-UI draft button and
the `obsidian-sync` GitHub Action.

Automates keeping the Obsidian vault current: sorts the inbox, updates per-project
notes + decision logs, writes a daily activity digest, and generates weekly LinkedIn
drafts — all via headless Claude Code on a schedule.

---

## 1. Why / scope

Replace three things with one local, Claude-Code-driven pipeline:
1. The Windows PowerShell inbox watcher (`Obsidian Watcher` scheduled task) — **deleted**.
2. The `github-to-vault.yml` CI Action (daily GitHub digest) — **retired**.
3. The web UI's on-demand LinkedIn-draft generation button — **removed**.

Outputs are now **in the vault**, two kinds:
- **Project-specific updates** — `Projects/<page>.md` activity + decision log.
- **Overall daily "social update"** — digest in `Daily Notes/`, plus **weekly** LinkedIn drafts.

Plus: the same job **sorts the `_Inbox`** into Projects / Notes / Resources.

---

## 2. Environment facts (verified 2026-06-25)

- **Vault path**: `~/obsidian.md` → symlink → `/mnt/c/Users/Catalin Teodorescu/OneDrive/Documents/Obsidian Vault`.
- **Filesystem**: `/mnt/c` is **9p** (WSL2 ↔ Windows). **No inotify** on 9p — neither Windows-side nor Linux-side changes fire events. Any "watch" must **poll**.
- **Sync layers**: OneDrive (**being deprecated** — unreliable on mobile), **Syncthing** (`syncthing@dustfeather.service`, active; folder `Obsidian Vault`, `rescanIntervalS=60`, also polling since 9p gives it no inotify), and **git** (`origin git@github.com:dustfeather/obsidian-sync.git`).
- **Git role going forward = backup only.** Syncthing is the sync layer. Bot writes **plain files**; git is a periodic backup snapshot, NOT the write path.
- **Vault is a git repo** with `core.hooksPath = "99 System/Hooks"` (a pre-commit Mermaid note-graph generator — **to be dropped**, see §6). `.gitignore`: `.stfolder/ .trash/ .gh-sync/`.
- **15 git repos** in `~/projects`. The canonical repo→GitHub→note map already exists as the **`Local Repos`** vault note (handles `flotila`→`fleet-manager`, nested `browser-extensions/*`, `TE/no7`=no-git/secrets, ITGuys-RO vs dustfeather owners).
- **Claude invocation**: alias `claude='headroom wrap claude'` (`~/.local/bin/headroom`, a local Anthropic-API compression proxy). **Alias does NOT expand in systemd/cron** — call `~/.local/bin/headroom wrap claude` explicitly.
- **Permissions**: `~/.claude/settings.json` has `permissions.defaultMode="bypassPermissions"` + `skipDangerousModePermissionPrompt=true`. So headless runs auto-approve all tools — **no `--allowedTools` needed**. Unit must set `HOME=/home/dustfeather` or settings won't load (would fall back to `default` mode and hang); also pass `--permission-mode bypassPermissions` explicitly as belt-and-suspenders.
- **Windows watcher handle**: scheduled task `\Obsidian Watcher` on host `DUSTYPC` (logon-triggered). `Watch-Inbox.vbs` launches hidden `powershell.exe -File Watch-Inbox.ps1`. No registry Run-key.

---

## 3. Vault structure (target — renamed, de-numbered)

```
_Inbox   Daily Notes   Projects   Resources   Notes   System
```

- Numeric prefixes **dropped** (`99 System` → `System`, etc.).
- Inbox = **`_Inbox`** (underscore sorts top in Obsidian default sort). NOT `.inbox` — Obsidian hides any `.`-prefixed folder.
- **Areas merged into `Projects`** — the Project/Area distinction becomes frontmatter `status` (`active|ongoing|planned|done`).
- `Notes/` = landing spot for atomic notes from inbox routing.
- Existing conventions to preserve: project frontmatter (`date`, `tags:[project,…]`, `status`), `## Goal`, decisions table `| # | Decision | Choice |` ("Resolved via grill (date)"); daily-note template (`## Log`, `## Tasks`, `## Notes`); daily path `LC_TIME=C TZ=Europe/Bucharest date +'Daily Notes/%Y/%m/%d (%a).md'`.

---

## 4. Components

### 4.1 Inbox sorter — always-on service
- `systemd --user` **service**, **30s poll** of `_Inbox` (9p = no inotify), **drain-on-start**.
- Model: **Haiku 4.5**.
- Per `.md`: classify → **Project / Resource / Note / Task-log / leave-if-unsure**.
- Action: **move** to destination; delete original **only on confident** classification; leave in `_Inbox` if unsure. **Light-touch** rewrite — add frontmatter + clean title, **body verbatim** (no lossy summarize).

### 4.2 Daily writer — chained after collector
- New `social-collect.service` follow-on, ordered `After=` the 18:00 collector (one timer, `Persistent=true`).
- Model: **Opus 4.8**.
- **Two-layer source**: collector SQLite = which repos were active + what changed (drives which notes to touch); **raw Claude transcripts of active repos only** (`~/.claude/projects/<encoded>/*.jsonl`, filtered by SQLite activity window) = decisions/rationale.
- Writes: `Projects/<page>` activity (daily) + decision log (append-only table) + **daily digest** into `Daily Notes/YYYY/MM/DD (Ddd).md` under managed `<!-- UPDATE:START -->…<!-- UPDATE:END -->`.
- Maintains the **`Local Repos`** map: unmapped active repo → **auto-add best guess + disclose** in that day's note (`🆕 mapped repo X → Projects/Y — correct if wrong`).

### 4.3 Weekly drafts — **BUILT** (slice 5)
- New timer, **Sunday 19:00** (after Sunday daily run; end of ISO week). The `.service`
  carries `After=vault-daily.service` so it orders behind the same-time daily run.
- Model: **Opus 4.8**. Reuses `prompt.txt` → LinkedIn drafts into a **weekly note**
  `Daily Notes/YYYY/Www.md`. Source: `src/vault-weekly.ts`; wrapper `scripts/vault-weekly.sh`;
  installer `scripts/install-vault-weekly.sh`.
- **Signal** (read-only, no model tools): the ISO week's seven **daily digest blocks**
  (already distilled by slice 3) + a `git log` oneline backup across `~/projects/*` for the
  week (so weeks the daily writer never ran still produce drafts) + the author's hand-curated
  items from the note's manual block.
- **Output**: a managed `<!-- vault-keeper:drafts:start -->…end -->` block, idempotent by ISO
  week (re-run replaces it, never duplicates). A `<!-- vault-keeper:manual:start -->…end -->`
  block is seeded on first write and **preserved verbatim** across regeneration — the author
  pre-fills it; those items are fed in as the highest-priority signal.
- ISO week + the seven calendar days are computed in UTC off the Bucharest calendar day, so DST
  never shifts which day a date lands on. `--shadow` dumps to `.vault-keeper/shadow-<week>.md`.

### 4.4 Graphify (knowledge graph) — **BUILT** (slice 4)
Built against graphify(y) **v0.8.x**; CLI reality differs from the original design,
which assumed a workspace/federation mode and a Glob/Grep hook that **do not exist**.
Scripts: `scripts/install-vault-graphify.sh` (setup) + `scripts/vault-graphify.sh` (worker).
- **Install (global, once)**: `pipx install graphifyy` (+ `pipx inject graphifyy anthropic`)
  → `graphify install --platform claude`. Registers the `/graphify` skill at
  `~/.claude/skills/graphify/` and appends a 3-line trigger to `~/.claude/CLAUDE.md`.
  It does **NOT** touch `settings.json` / add a Glob/Grep `PreToolUse` hook (the v0.8
  integration is the `/graphify` skill, not a pre-tool intercept). Global `CLAUDE.md`
  is backed up to `.vault-keeper/backups/` first.
- **Backend = `claude-cli`** (not the SDK `claude` backend): graphify shells
  `claude -p --output-format json --model haiku`, authenticating via the existing
  Claude **subscription** login — **no metered `ANTHROPIC_API_KEY`** (the SDK `claude`
  backend would need one; the local gateway relays `x-api-key` and 401s a dummy).
  `GRAPHIFY_CLAUDE_CLI_MODEL=haiku` keeps the structured extraction cheap. Each
  `claude -p` boots the full MCP stack (serena/context-mode) per chunk → slow but free.
- **Federation = `extract --global --as <tag>`** (NOT workspace mode — Issue #425 never
  shipped). Every repo + the vault merges into **one** `~/.graphify/global-graph.json`.
  This supersedes the logical-join-via-repo-map fallback the design held in reserve.
  Query the federated graph: `graphify query "<q>" --graph ~/.graphify/global-graph.json`
  (also `path "A" "B"`, `explain "X"`). Per-repo graphs live in each repo's
  `graphify-out/` (git-excluded via `.git/info/exclude`, not the tracked `.gitignore`).
- **Scope**: 15 git repos under `~/projects` + the vault. Vault graph output goes to
  `~/.graphify/vaultgraph/` (NOT into the synced vault — keeps graph internals out of
  Syncthing/OneDrive, spec §8).
- **Freshness**: `graphify hook install` per repo = a **post-commit** rebuild hook
  (`.git/hooks`, AST-only, no LLM). Worker installs it for every git repo.
- Idempotent: graphify's SHA256 cache (`graphify-out/cache/`) reprocesses only changed
  files, so the worker is safe to re-run. `--shadow` = AST-only (`graphify update`, no
  LLM/quota, no `--global`, no hooks) for a free dry pass.

### 4.5 Git backup
- Periodic snapshot only: scoped `git add` (**never `-A`**) → commit → push to `obsidian-sync`. Decoupled from writing.

---

## 5. Invocation, state, safety

### Invocation
```
~/.local/bin/headroom wrap claude -p "<prompt>" --permission-mode bypassPermissions --model <opus|haiku>
```
- Unit env: `HOME=/home/dustfeather`. No `--allowedTools`. Skills + MCP plugins (Graphify, context-mode) load under bypass mode.

### State / idempotency (extend collector SQLite)
- Ledger table `vault_writes(source_key, note_path, written_at)`.
- Daily block **regenerated** each run (idempotent by date).
- Project/decision entries **append-only**, deduped by **session-UUID + decision-index** (text-hash fallback). Corrections = new entries (no rewrite).

### Safety
- **`PreToolUse` write-guard hook**: deny `Write`/`Edit`/mutating-`Bash` to any path **outside the vault** (+ the SQLite ledger). Hard blast-radius cap on the bypass-mode agent.
- **Watchdog wrap** (model on `scripts/social-collect-watchdog.sh`): health probe → run → flag → journald. Writes atomic (temp+rename); nothing partial on error.
- **Shadow first-run**: emit proposed diffs to a log / scratch copy before going live.
- Failures → **journald only**, no push notifications (future: agentic self-healing — see vault note `Notes/Agentic Self-Healing (idea).md`).

---

## 6. Teardown (cutover)

1. **Delete Windows watcher** (from WSL):
   ```
   schtasks.exe /End /TN "Obsidian Watcher"
   schtasks.exe /Delete /TN "Obsidian Watcher" /F
   ```
   Kill any live watcher `powershell.exe`; remove `.watcher.lock`.
2. **Retire CI Action**: delete `.github/workflows/github-to-vault.yml` + `99 System/Scripts/github-fetch-delta.sh` in the vault repo, commit. (GitHub App + `CLAUDE_CODE_OAUTH_TOKEN` secret left dormant — no revoke needed.)
3. **Drop the Mermaid pre-commit hook**: remove `99 System/Hooks/pre-commit`, unset `core.hooksPath` (frees `.git/hooks` for Graphify). Graphify's graph + Obsidian's graph supersede the README Mermaid diagram.
4. **Remove dead scripts** (git keeps history): `Watch-Inbox.ps1`, `Watch-Inbox.vbs`, `graph-to-mermaid.sh`, `install-hooks.sh`, `watcher.log`.

---

## 7. Build order (vertical slices)

1. ✅ **Vault rename + teardown** — de-number folders (`_Inbox` etc.), merge Areas→Projects, do all of §6.
2. ✅ **Inbox sorter service** (Haiku) — smallest end-to-end loop; validates 9p-poll + write-guard + Syncthing propagation.
3. ✅ **Daily writer + ledger + write-guard hook** — shadow first-run → live. Project notes + decisions + daily digest.
4. ✅ **Graphify** — install, federate (`--global`), per-repo post-commit freshness hooks. See §4.4.
5. ✅ **Weekly drafts** (Opus) — Sunday timer, reuse `prompt.txt`. See §4.3.

---

## 8. Build hardening to verify

- Exclude `.git/` from the Syncthing folder (don't replicate git internals mid-op).
- Confirm Graphify **workspace mode** maturity; keep logical-join fallback ready.
- Confirm `headroom wrap claude -p` runs clean under `systemd --user` with `HOME` set.
- Inbox sorter must not race Syncthing (`.sync-conflict-*` files) — managed by move-then-delete + the bot owning daily/project notes.

---

## 9. Open / deferred

- Agentic self-healing of failed runs — `Notes/Agentic Self-Healing (idea).md`.
- Self-healing replaces the passive watchdog escalation path.
