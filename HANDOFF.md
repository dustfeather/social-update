# Handoff — vault-keeper

## What this is
Design for an automated, Claude-Code-driven pipeline that keeps the Obsidian vault
current (inbox sort, per-project updates + decision logs, daily digest, weekly LinkedIn
drafts). Extends the `social-update` repo. Design fully resolved via `grill-me` on
2026-06-25. **Nothing built yet.**

## Primary artifact — READ FIRST
**Full spec & runbook:** `VAULT-KEEPER.md` (this repo, on `main`).
Every decision, env fact, teardown step, build order, and hardening item is there.
Do not re-derive — read it.

## Also written (in the vault)
- `Notes/Agentic Self-Healing (idea).md` — backlog idea note, links `[[Social Update]]`.

## State of play
- Grill complete; all 10 decision branches resolved (Q1–Q10). Answers captured in the spec.
- Repo `social-update` on `main`; pre-existing modified file `scripts/social-collect-watchdog.sh`
  (not ours — leave unless asked).
- No code written. Next work = **build slice 1** per spec §7 (vault rename + teardown of
  Windows watcher / CI Action / Mermaid hook).

## Open / unresolved
- User has NOT chosen a next action (start slice 1 / refine). Reconfirm intent before building.

## Landmines (full detail in spec §2, §8)
- `/mnt/c` is **9p → no inotify**. Anything "watch" must poll. Don't waste time on inotify.
- `claude` is a shell **alias** (`headroom wrap claude`) — won't expand in systemd. Call
  `~/.local/bin/headroom wrap claude` explicitly + set `HOME` in the unit.
- bypassPermissions is on globally → **no `--allowedTools`** needed.
- **Git = backup only**; Syncthing is the sync layer; OneDrive deprecating. Write plain
  files, never `git add -A`.
- Vault write-guard `PreToolUse` hook is the ONLY real blast-radius cap on the bypass agent.

## Suggested skills (invoke as relevant)
- `branch-hygiene-before-coding` — before any code edit (default: direct to `main`, no PR unless asked).
- `research-before-edit` — before editing existing repo/vault files (read + grep callers first).
- `bash-first-scripting` — the systemd watchdog/poll wrappers are new standalone scripts (bash default).
- `prefer-githook-checks` — if adding typecheck/lint to the TS writer stage.
- `obsidian-markdown` — when writing vault notes (wikilinks, callouts, frontmatter).
- `workflow-script-authoring` — only if slice 3 grows to per-repo parallel subagents (spec §4.2 scale path).
- `infra-access` — creds for GitHub/Syncthing/Windows-task ops exist locally; check before claiming no access.
