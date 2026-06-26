#!/usr/bin/env bash
# vault-keeper slice 5 — weekly LinkedIn drafter wrapper (run by the vault-weekly
# timer Sunday evening, after the daily writer). Turns the ISO week's daily
# digests + git activity + the author's manual items into LinkedIn drafts in the
# weekly note. See src/vault-weekly.ts.
#   journalctl --user -t vault-weekly
#   vault-weekly.sh            # drafts for the current ISO week
#   vault-weekly.sh --shadow   # dry-run; proposed output to .vault-keeper/shadow-<week>.md
set -uo pipefail
cd "$HOME/projects/social-update" || { echo "ERROR: project dir missing"; exit 1; }
[[ -f dist/vault-weekly.js ]] || { echo "ERROR: dist/vault-weekly.js missing — run npm run build"; exit 1; }
exec node dist/vault-weekly.js "$@"
