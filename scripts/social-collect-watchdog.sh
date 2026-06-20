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

# The claude-web collector attaches to a real Chrome over CDP (claude.ai's
# Cloudflare Turnstile blocks launched/automated browsers — see README). Under
# WSLg the browser needs a display; systemd --user doesn't inherit one.
export DISPLAY="${DISPLAY:-:0}"

# Helper: read a single key from .env (don't `source` it — quoted paths w/ spaces).
envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

# If CLAUDE_CDP_URL is set, make sure a logged-in Chrome is listening on that
# port before collecting. If WE have to launch it, we also close the whole
# browser when the run ends (see the EXIT trap below) instead of leaving a window
# open. Trade-off: each run that launches Chrome re-hits Cloudflare Turnstile, so
# the profile must already hold a valid login/clearance for it to pass unattended.
CDP="$(envval CLAUDE_CDP_URL)"
if [ -n "$CDP" ]; then
  PORT="${CDP##*:}"
  PROFILE="$(envval CLAUDE_CHROME_PROFILE)"; PROFILE="${PROFILE:-$HOME/.cache/social-update/chrome-profile}"
  PROFILE="$(eval echo "$PROFILE")" # expand $HOME/~ (envval greps, doesn't source)
  if ! curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
    CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || echo /snap/bin/chromium)"
    echo "claude-web: starting $CHROME on :$PORT (profile $PROFILE)"
    setsid "$CHROME" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check >/tmp/social-collect-chrome.log 2>&1 &
    CHROME_LEADER=$!   # setsid makes this the session/process-group leader
    disown 2>/dev/null || true
    # Close the entire browser (not just the claude-web tab) when this run ends,
    # on ANY exit path. Negative PID targets the whole process group. Guarded so
    # we only ever kill a Chrome WE launched, never one the user already had open.
    trap 'if [ -n "${CHROME_LEADER:-}" ]; then echo "claude-web: closing collector Chrome"; kill -- -"$CHROME_LEADER" 2>/dev/null || kill "$CHROME_LEADER" 2>/dev/null; fi' EXIT
    for _ in $(seq 1 20); do
      curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/json/version" && break
      sleep 1
    done
  fi
  if ! curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
    # Not fatal: collect.ts catches per-source, so other sources still run; the
    # FAILED grep below will flag claude-web so it surfaces in journald.
    echo "WARN: claude-web CDP Chrome unreachable on :$PORT (may need a manual re-login)"
  fi
fi

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
