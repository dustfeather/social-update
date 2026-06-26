#!/usr/bin/env bash
# vault-keeper slice 6 — repo->Projects backfill + graph refresh wrapper (run by
# the vault-repos timer each evening, after the daily writer). Detects repos under
# ~/projects with no Obsidian Project note, documents them via Opus, and refreshes
# the federated graphify graph + repos<->Projects canvas. See scripts/vault-repos.mjs.
#   journalctl --user -t vault-repos
#   vault-repos.sh            # backfill + refresh (live)
#   vault-repos.sh --dry      # list repos missing a note; no LLM, no write
#   vault-repos.sh --shadow   # write proposed notes to .vault-keeper/, not the vault
set -uo pipefail
cd "$HOME/projects/social-update" || { echo "ERROR: project dir missing"; exit 1; }
[[ -f scripts/vault-repos.mjs ]] || { echo "ERROR: scripts/vault-repos.mjs missing"; exit 1; }
exec node scripts/vault-repos.mjs "$@"
