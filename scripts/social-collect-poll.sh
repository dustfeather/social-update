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

# Default mode: claim the oldest pending run. 204 (empty body) = nothing queued.
claim="$(curl -fsS -m 10 -X POST "$INGEST/api/collect/next" 2>/dev/null)" || exit 0
[ -z "$claim" ] && exit 0

# Pull the run id out without a jq dependency.
id="$(printf '%s' "$claim" | grep -oE '"id":[0-9]+' | head -1 | grep -oE '[0-9]+')"
[ -z "$id" ] && exit 0
echo "claimed run $id — running collector"

# The watchdog does the Chrome/CDP setup, ingest health-check, and per-source run.
out="$("$HOME/.local/bin/social-collect-watchdog.sh" 2>&1)"; rc=$?
echo "$out"

# collect.ts prints "[collect] done — N new items total"; pull N back out.
inserted="$(printf '%s' "$out" | grep -oE '[0-9]+ new items? total' | grep -oE '^[0-9]+' | tail -1)"
inserted="${inserted:-0}"

if [ "$rc" -eq 0 ]; then
  body="$(printf '{"inserted":%s}' "$inserted")"
else
  # Keep the reported error short and JSON-safe (strip quotes/backslashes/newlines).
  msg="$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | tr -d '"\\' | cut -c1-200)"
  body="$(printf '{"error":"run failed (rc=%s): %s"}' "$rc" "$msg")"
fi

curl -fsS -m 10 -X POST -H 'content-type: application/json' -d "$body" \
  "$INGEST/api/collect/$id/done" >/dev/null || echo "WARN: failed to report run $id result"
echo "reported run $id (inserted=$inserted rc=$rc)"
