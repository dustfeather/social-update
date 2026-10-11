#!/usr/bin/env bash
# Local poller for collection runs requested from the UI button or the daily timer.
# Invoked every few seconds by the social-collect-poll.timer systemd --user unit.
# Claims one pending run from the server queue, runs the watchdog, then reports the
# result back so the UI can notify on completion.
#   Inspect: journalctl --user -t social-collect-poll
#
# Collectors must run here (they need this box's browser/vault/gh+claude CLIs), so
# the cluster UI can't run them directly — it enqueues, this claims and runs.
set -uo pipefail

cd "$HOME/projects/social-update" || { echo "ERROR: project dir missing"; exit 1; }

# systemd runs us non-interactively, so .bashrc — where nvm inits — is never sourced
# and `node` is not on PATH. The watchdog loads nvm for itself; this script needs it
# too, for the one `node -e` below that reads the collector's result file. Without it
# that call failed silently and every successful run reported inserted=0 to the UI.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

# INGEST_URL only — parsed directly (don't `source` .env: it has quoted paths with spaces).
INGEST="$(grep -E '^INGEST_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
INGEST="${INGEST:-https://social.itguys.ro}"

# --enqueue [source]: ask the server to queue a run (used by the daily timer).
# Single-flight is enforced server-side, so a redundant enqueue is a harmless no-op.
if [ "${1:-}" = "--enqueue" ]; then
  src="${2:-daily}"
  if curl -fsS -m 15 -X POST -H 'content-type: application/json' \
       -d "{\"source\":\"$src\"}" "$INGEST/api/collect" >/dev/null; then
    echo "enqueued $src run"
  else
    echo "WARN: enqueue ($src) failed — $INGEST/api/collect unreachable"
  fi
  exit 0
fi

# Do not claim while a collection or tag backfill of ours is already running: the
# collector would find collect.lock held, return at once, and the claimed run would be
# reported as having found nothing. Deferring leaves it pending and the poll timer
# retries every few seconds.
WORK_DIR="${CLAUDE_WORK_DIR:-$HOME/.cache/social-update/claude}"
lock="$WORK_DIR/collect.lock"
if [ -f "$lock" ]; then
  pid="$(grep -oE '"pid":[0-9]+' "$lock" 2>/dev/null | head -1 | grep -oE '[0-9]+')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
fi

# Default mode: claim the oldest pending run. 204 (empty body) = nothing queued.
claim="$(curl -fsS -m 10 -X POST "$INGEST/api/collect/next" 2>/dev/null)" || exit 0
[ -z "$claim" ] && exit 0

# Pull the run id out without a jq dependency.
id="$(printf '%s' "$claim" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')"
[ -z "$id" ] && exit 0
echo "claimed run $id — running collector"

# The watchdog does the ingest health-check, the claude -p probe and the run itself.
# Output is streamed to a file rather than held in a variable: a multi-hour run
# accumulates megabytes that only exist in this shell's memory until it exits, so a
# power cut takes the whole log with it. (The RUN survives either way — the durable
# state is progress.jsonl and the summaries on disk — but the log is what tells you
# how far it got, and that is exactly what you want after an unclean stop.)
log="$HOME/.cache/social-update/claude/last-run.log"
mkdir -p "$(dirname "$log")"
# COLLECT_RUN_ID tells the collector which queue row its progress reports belong to
# (see src/run-progress.ts); it passes through the watchdog and npm untouched.
COLLECT_RUN_ID="$id" "$HOME/.local/bin/social-collect-watchdog.sh" > "$log" 2>&1; rc=$?
cat "$log"

# How many items landed comes from the collector's own result file, not from its
# prose. The previous grep looked for "N new items total", a phrasing collect.ts does
# not print (it says "N items written"), so `inserted` was 0 on every successful run
# and the UI recorded every collection as having found nothing.
run_json="$HOME/.cache/social-update/claude/last-run.json"
# Errors are kept and inspected, not sent to /dev/null. The previous version discarded
# them and defaulted to 0, so "node is not on PATH" and "the run genuinely inserted
# nothing" produced the same number — which is how the grep bug this replaced survived
# so long. Anything that is not a plain integer is reported and then treated as 0, so a
# bad read degrades the count without losing the run.
inserted="$(node -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).inserted;if(!Number.isInteger(v))throw new Error("inserted is not an integer: "+JSON.stringify(v));process.stdout.write(String(v))' "$run_json" 2>&1)"
case "$inserted" in
  *[!0-9]*|'') echo "WARN: could not read inserted from $run_json — ${inserted:-<empty>}"; inserted=0 ;;
esac

if [ "$rc" -eq 0 ]; then
  body="$(printf '{"inserted":%s}' "$inserted")"
else
  # Keep the reported error short and JSON-safe (strip quotes/backslashes/newlines).
  msg="$(tail -3 "$log" | tr '\n' ' ' | tr -d '"\\' | cut -c1-200)"
  body="$(printf '{"error":"run failed (rc=%s): %s"}' "$rc" "$msg")"
fi

curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "$body" \
  "$INGEST/api/collect/$id/done" >/dev/null || echo "WARN: failed to report run $id result"
echo "reported run $id (inserted=$inserted rc=$rc)"
