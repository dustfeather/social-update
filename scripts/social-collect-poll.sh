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

# Do not start a run while something else owns the GPU. The collector's model takes
# ~7.9 GiB of this box's 8 GiB card and pegs 6 of 8 cores for the hours a run lasts, so
# a run and a game are mutually exclusive here rather than merely slow together. Nothing
# downstream notices: the watchdog probes only the router and ingest, and llama.cpp reacts
# to a full card by dying on the allocation or crawling at a fraction of a token a second.
#
# The check sits BEFORE the claim on purpose. Claiming first would consume the queued run
# and then abandon it; deferring leaves it pending and the poll timer retries every few
# seconds, so the run starts by itself once the card is free.
#
# VRAM being in use is NOT the test — our own resident model is the usual occupant, and a
# run that reuses it allocates nothing. The card counts as taken only when the router does
# not have the model loaded and the memory is gone anyway, which means someone else has it.
# Known gap: a game started while our model is already resident is invisible to this, since
# the VRAM reads the same either way.
# Escape hatch: SOCIAL_COLLECT_GPU_GUARD=0. Threshold: SOCIAL_COLLECT_GPU_MAX_USED_MIB.
gpu_taken_by_someone_else() {
  [ "${SOCIAL_COLLECT_GPU_GUARD:-1}" = "0" ] && return 1
  command -v nvidia-smi >/dev/null 2>&1 || return 1

  local used
  used="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')"
  # Anything unreadable fails OPEN. A guard that blocks collection because it could not
  # parse a number would be a worse outage than the contention it exists to prevent.
  case "$used" in ''|*[!0-9]*) return 1 ;; esac
  [ "$used" -le "${SOCIAL_COLLECT_GPU_MAX_USED_MIB:-2000}" ] && return 1

  local router="${LLM_BASE_URL:-http://127.0.0.1:1921/v1}"
  router="${router%/v1}"
  # An unreachable router with the memory gone counts as taken: we cannot confirm the
  # occupant is ours, and a run against a dead router fails in the watchdog anyway.
  curl -fsS -m 5 "$router/models" 2>/dev/null | grep -q "\"value\":\"loaded\"" && return 1

  GPU_USED_MIB="$used"
  return 0
}

if gpu_taken_by_someone_else; then
  # One line per ten minutes, not one per poll tick: this runs every few seconds and the
  # deferral can last a whole evening.
  stamp="$HOME/.cache/social-update/gpu-deferred.stamp"
  mkdir -p "$(dirname "$stamp")"
  if [ ! -f "$stamp" ] || [ "$(( $(date +%s) - $(stat -c %Y "$stamp") ))" -ge 600 ]; then
    echo "deferred: ${GPU_USED_MIB} MiB of VRAM held by something other than the model — leaving any queued run pending"
    : > "$stamp"
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

# The watchdog does the ingest health-check, the router probe and the run itself.
# Output is streamed to a file rather than held in a variable: a multi-hour run
# accumulates megabytes that only exist in this shell's memory until it exits, so a
# power cut takes the whole log with it. (The RUN survives either way — the durable
# state is progress.jsonl and the summaries on disk — but the log is what tells you
# how far it got, and that is exactly what you want after an unclean stop.)
log="$HOME/.cache/social-update/claude/last-run.log"
mkdir -p "$(dirname "$log")"
"$HOME/.local/bin/social-collect-watchdog.sh" > "$log" 2>&1; rc=$?
cat "$log"

# How many items landed comes from the collector's own result file, not from its
# prose. The previous grep looked for "N new items total", a phrasing collect.ts does
# not print (it says "N items written"), so `inserted` was 0 on every successful run
# and the UI recorded every collection as having found nothing.
run_json="$HOME/.cache/social-update/claude/last-run.json"
inserted="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).inserted??0))}catch{process.stdout.write("0")}' "$run_json" 2>/dev/null)"
inserted="${inserted:-0}"

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
