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

# Collection summarizes each new or changed session with `claude -p` on Haiku (see
# src/llm.ts), using this box's logged-in Claude Code — no API key, no GPU.
#
# Checked, not assumed: without a working CLI every session fails one after another
# and the run exits having written nothing, which reads in the log much like "no new
# sessions". A one-token call proves the binary, the login and the model together.
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
# Bounded, and with the env src/llm.ts gives its calls (no CLAUDE_CODE_PLUGIN_DIRS).
probe="$(printf 'Reply with exactly: OK' | timeout 120 env -u CLAUDE_CODE_PLUGIN_DIRS "$CLAUDE_BIN" -p --model "${LLM_MODEL:-haiku}" \
  --output-format json --tools "" --setting-sources "" --strict-mcp-config \
  --no-session-persistence 2>&1)"
printf '%s' "$probe" | grep -q '"is_error":false' || {
  echo "ERROR: claude -p probe failed — collection cannot run: $(printf '%s' "$probe" | head -c 300)"; exit 1; }

# INGEST_URL only — parsed directly (don't `source` .env: it has quoted paths with spaces).
INGEST="$(grep -E '^INGEST_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
INGEST="${INGEST:-https://social.itguys.ro}"

# 1. ingest reachable? (the canary)
if ! curl -fsS -m 10 -o /dev/null "$INGEST/api/health"; then
  echo "ERROR: ingest $INGEST/api/health unreachable — collection skipped this run"
  exit 1
fi

# 2. run the collector, surface its output to journald
#    Through `npm run` rather than `node dist/collect.js`: the `precollect` hook
#    compiles first, so a src/ change that was never built by hand cannot leave
#    this unit silently running the previous build. dist/ is gitignored, so there
#    is no committed artifact to fall back on.
#    Output is NOT captured or piped. It used to be `out="$(npm run ... 2>&1)"` so the
#    next step could grep it, which meant a three-hour run printed nothing until it
#    ended — and, because a captured command has no TTY, the progress bar could not
#    render either. Inheriting our stdout is what makes both work; under systemd that
#    stdout is the journal, where the bar is inert by design (see progress-bar.ts).
npm run --silent collect
rc=$?

# 3. a source can fail without failing the whole run (collect.ts catches per-source),
#    and that must still page. It reports this as exit 2 rather than a line of prose:
#    grepping our own output for "FAILED" made a log message load-bearing, so
#    rewording it would have disabled the alert silently.
if [ "$rc" -eq 2 ]; then
  echo "ERROR: a collector source reported FAILED (see lines above)"; exit 1
fi
if [ "$rc" -ne 0 ]; then echo "ERROR: collector exited $rc"; exit "$rc"; fi

echo "OK: collection run clean"
