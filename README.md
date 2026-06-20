# Social Journal

Turn sporadic posting into a weekly habit. Daily collectors log your activity into a
SQLite DB; a web UI generates copy-ready LinkedIn drafts on demand.

**Nothing is auto-published.** No posting APIs — you copy/paste the drafts yourself. The
Obsidian vault is read-only input; no journal note is ever written.

## How it works

The DB + web UI + generation run on the k3s cluster (`https://social.itguys.ro`, WARP-only).
The collectors stay on your machine (they need local `gh`, the Obsidian vault, and
`~/.claude/projects`) and **push** what they find to the cluster over the WARP network:

```
 local machine                          │  k3s (social-update ns, acer-laptop)
 ─────────────                          │  ────────────────────────────────────
 collectors ──POST /api/ingest──────────┼──► Express ──► SQLite (/data PVC)
  github   (INGEST_URL)                 │       ▲              │
  obsidian                              │       │   web UI ──► POST /api/generate
  claude code                           │       │              │
                                        │       │     in-pod `claude` CLI ──► drafts
 browser (WARP) ──https://social.itguys.ro──────┘                            (copy/paste)
```

- **Collectors** map source records → `items` rows, deduped by `UNIQUE(source, external_id)`.
  With `INGEST_URL` set they POST to `/api/ingest`; unset, they write a local DB (dev).
- **Generate** sends a week's items + your manual notes + `prompt.txt` to the `claude` CLI
  running **in the cluster pod** (auth via `CLAUDE_CODE_OAUTH_TOKEN`), which returns a JSON
  array of drafts. Each generation is saved to `drafts`.

## Prerequisites (collector machine)

- Node.js (run inside WSL).
- **`gh` CLI**, authenticated (the GitHub collector reuses its auth → includes private events).
- `~/.claude/projects` present (Claude Code session logs).
- WARP connected (so the collector can reach `INGEST_URL` on the cluster).

The `claude` CLI is **no longer needed locally** — generation runs in the cluster pod.

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
| `CLAUDE_SESSION_KEY` | `sessionKey` cookie from a logged-in claude.ai session, used to collect web conversations. Unset = web collection skipped. |
| `CLAUDE_WEB_BASE` | claude.ai API base (default `https://claude.ai`). Rarely changed. |
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

The collector runs from a **WSL `systemd --user` timer** (`social-collect.timer`, daily at
18:00). It calls a watchdog wrapper (`scripts/social-collect-watchdog.sh`, modeled on the WARP
mesh watchdog) that probes ingest health, runs the collector, flags any failed source, and logs
everything to journald. `Persistent=true` makes a missed run (WSL down at 18:00) fire on the
next boot instead of being silently skipped.

Install / update (run inside WSL from the repo root):

```bash
scripts/install-collector-systemd.sh
```

Inspect:

```bash
systemctl --user list-timers social-collect.timer   # next/last fire
systemctl --user start social-collect.service        # run now
journalctl --user -t social-collect -n 30            # run logs
```

> Requires `systemd=true` in `/etc/wsl.conf` and `loginctl enable-linger` (the installer sets
> linger). The unit files live under `scripts/systemd/` so they're version-controlled and can't
> silently disappear the way the old Windows Scheduled Task did.

### Legacy: Windows Task Scheduler (deprecated)

`scripts/collect-task.cmd` + a `SocialJournalCollect` task was the old mechanism. It is
**disabled** in favor of the systemd timer (avoid running both — harmless duplicate inserts via
the dedup constraint, but confusing). To fall back: `schtasks /Change /TN "SocialJournalCollect"
/ENABLE` and disable the systemd timer with `systemctl --user disable --now social-collect.timer`.

## Deployment (k3s)

The app (DB + UI + generation) runs on the itguys k3s cluster, deployed by GitHub Actions
(`.github/workflows/deploy.yml`) on push to `main`. The workflow runs on the in-cluster
`arc-df-social-update` ARC runner and `kubectl apply`s `deploy/` using the runner SA.

Exposure mirrors the cluster convention (e.g. `grafana.itguys.ro`): a per-app
`nginx-tls-proxy` pinned to `acer-laptop` binds that node's `:443` and reverse-proxies to
the app; a cert-manager `Certificate` (`social.itguys.ro`, DNS-01 via
`letsencrypt-cloudflare`) provides TLS; a Cloudflare **DNS-only** A record
`social.itguys.ro → 100.96.0.4` (acer Mesh IP) makes it reachable **only inside WARP**.
SQLite lives on a node-local `local-path` PVC, so the app + proxy + PVC all pin to
`acer-laptop`.

### One-time bootstrap (cluster-admin)

```bash
# 1. Provision the ARC runner scale set for this repo. Clone a sibling's values
#    (prebaked runner image + privileged dind for `docker build` + acer nodeSelector)
#    and swap only the repo URL — siblings reuse the dustfeather App secret.
helm -n arc-runners get values arc-df-uninsta -a | tail -n +2 > /tmp/vals.yaml
sed -i 's#github.com/dustfeather/uninsta#github.com/dustfeather/social-update#' /tmp/vals.yaml
helm -n arc-runners install arc-df-social-update \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set \
  --version 0.14.1 -f /tmp/vals.yaml

# 2. RBAC: namespace + runner-SA deploy grants + refresher SA/Role.
kubectl apply -f deploy/ci-rbac.yaml
kubectl apply -f deploy/ghcr-pull-refresher/00-rbac.yaml

# 3. Copy the GitHub App secret so the refresher can mint ghcr pull tokens here.
kubectl get secret github-app-dustfeather -n arc-runners -o yaml \
  | sed 's/namespace: arc-runners/namespace: social-update/' \
  | kubectl apply -n social-update -f -

# 4. Actions secret for in-pod generation.
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R dustfeather/social-update

# 5. Cloudflare DNS-only A record: social.itguys.ro -> 100.96.0.4 (proxied=false).
```

After that, every push to `main` builds the image (`ghcr.io/dustfeather/social-update`),
refreshes the `ghcr-pull` credential, and applies the workload. The private image is pulled
via `ghcr-pull`, kept fresh by the in-namespace `ghcr-pull-refresher` CronJob (GitHub App,
no human PAT).

### Pointing collectors at the cluster

Set `INGEST_URL="https://social.itguys.ro"` in the collector machine's `.env`. The collectors
then POST to `/api/ingest` instead of opening a local DB (no token — WARP is the gate). The
`GITHUB_EXCLUDE_REPOS` filter is set in the UI and stored in the cluster DB; the collector
reads it back via `GET /api/settings`.

## Data model

- **`items`** — `source, external_id, title, body, url, occurred_at, iso_week, collected_at,
  raw_json`. `iso_week` is the ISO week of `occurred_at`, so late collection files items into
  the week they actually happened.
- **`drafts`** — `created_at, iso_week, input_snapshot, prompt_used, output` (JSON draft array).

## Voice

`prompt.txt` holds the generation voice instruction (first-person, concrete, no marketing
hype). It is backend-only — edit it by hand; it is not surfaced in the UI.
