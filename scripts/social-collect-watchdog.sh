#!/usr/bin/env bash
# Social-update collector, watchdog-style. Invoked by the social-collect.service
# systemd --user unit (see scripts/systemd/). Modeled on the WARP mesh watchdog:
# probe a canary, run the job, self-heal daily, log everything to journald.
# Inspect:  journalctl --user -t social-collect
#
# Replaces the old Windows Scheduled Task SocialJournalCollect, which stopped
# collecting on 2026-06-10 and vanished with no audit trail (TaskScheduler
# op-log was disabled). A user systemd unit is a tracked file, so it can't
# silently disappear the same way.
set -uo pipefail

# systemd runs us non-interactively, so .bashrc (where nvm inits) isn't sourced.
# Load nvm explicitly so `node` resolves to the nvm `default` alias.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

cd "$HOME/projects/social-update" || { echo "ERROR: project dir missing"; exit 1; }

# INGEST_URL only — parsed directly (don't `source` .env: it has quoted paths with spaces).
INGEST="$(grep -E '^INGEST_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
INGEST="${INGEST:-https://social.itguys.ro}"

# 1. ingest reachable? (the canary)
if ! curl -fsS -m 10 -o /dev/null "$INGEST/api/health"; then
  echo "ERROR: ingest $INGEST/api/health unreachable — collection skipped this run"
  exit 1
fi

# 2. run the collector, surface its output to journald
out="$(node dist/collect.js 2>&1)"; rc=$?
echo "$out"
if [ "$rc" -ne 0 ]; then echo "ERROR: collector exited $rc"; exit "$rc"; fi

# 3. a source can fail without failing the whole run (collect.ts catches per-source).
#    Treat that as an alertable condition so it shows up in journalctl.
if grep -q "FAILED" <<<"$out"; then
  echo "ERROR: a collector source reported FAILED (see lines above)"; exit 1
fi

echo "OK: collection run clean"
