#!/usr/bin/env bash
# vault-keeper slice 3 — daily writer wrapper (run by the vault-daily timer,
# after the daily collector). Distills the day's local git + transcript activity
# into the vault. See src/vault-daily.ts.
#   journalctl --user -t vault-daily
#   vault-daily.sh            # apply for today
#   vault-daily.sh --shadow   # dry-run; proposed output to .vault-keeper/shadow-<date>.md
set -uo pipefail
cd "$HOME/projects/social-update" || { echo "ERROR: project dir missing"; exit 1; }
[[ -f dist/vault-daily.js ]] || { echo "ERROR: dist/vault-daily.js missing — run npm run build"; exit 1; }
exec node dist/vault-daily.js "$@"
