# social-update

## Goal

Turn sporadic posting into a weekly habit. Daily collectors log my real activity
(GitHub, Obsidian, Claude Code sessions, claude.ai chats) into a SQLite DB; a web
UI generates copy-ready LinkedIn drafts on demand. **Nothing is auto-published** —
no posting APIs, drafts are copy/pasted by hand. Also hosts the **vault-keeper**
automations that distill activity back into the Obsidian vault.

## Stack

- **TypeScript** (CommonJS), **Node 22+**. Web UI built separately under `web/`.
- **Express** + **SQLite** (`/data` PVC) for ingest + storage; deduped by
  `UNIQUE(source, external_id)`.
- **Playwright** + **Chrome DevTools Protocol** for the `claude-web` collector
  (attaches to a real logged-in Chrome — Cloudflare Turnstile blocks automated
  browsers).
- **claude CLI** in-cluster for draft generation (`--model opus`, auth via
  `CLAUDE_CODE_OAUTH_TOKEN`); vault-keeper writers use Opus (daily/weekly) and
  Haiku (inbox sorter).

## Repo

`dustfeather/social-update` (remote `git@github.com:dustfeather/social-update.git`).

Layout:
- `src/collect.ts` + per-source collectors (`github.ts`, `obsidian.ts`,
  `claude.ts`, `claude-web.ts`), `db.ts`, `generate.ts`, `server.ts`.
- `src/vault-daily.ts`, `src/vault-weekly.ts` — vault-keeper writers (Opus).
- `scripts/` — systemd `--user` timers + watchdog + vault-keeper wrappers,
  `graphify-bridge.mjs` (joins the federated graph to vault Projects).
- `k8s/deploy/` — namespace, deployment, service, PVC, TLS proxy, CI RBAC.

## Deploy

- DB + web UI + generation run on the **k3s cluster** at
  [social.itguys.ro](https://social.itguys.ro) (**WARP-only**, no public route).
- **Collectors stay local** (need `gh`, the vault, `~/.claude/projects`) and POST
  to `/api/ingest` over WARP. Driven by a WSL `systemd --user` timer
  (`social-collect.timer`, daily 18:00) → watchdog wrapper.
- vault-keeper timers (`vault-daily`, `vault-weekly`, `vault-inbox-sort`,
  `vault-repos`) and the graphify vault bridge are disabled: the Obsidian vault is
  being decommissioned.

## Status

Active and deployed. Collector cutover from the old Windows Scheduled Task to the
WSL systemd timer is done; vault-keeper slices 1–5 complete (rename/teardown,
inbox sorter, daily writer, graphify federation, weekly drafter).

## Notes

- The Obsidian vault is **read-only input** to the collectors; only vault-keeper
  writes to it, through a capability-removal write-guard.
- `claude-web` does not run inference — it scrapes my own claude.ai chat history
  over CDP.
- **CI runners:** PR checks run on the k3s ARC runner family, built from
  [shared-workflows](https://github.com/dustfeather/shared-workflows/blob/main/docs/OVERVIEW.md) and hosted in [Homelab](https://github.com/ITGuys-RO/k3s-cluster/blob/main/docs/homelab.md).
- Area: Software Engineering

## Log

- **2026-06-26** — Note created from repo scan.
