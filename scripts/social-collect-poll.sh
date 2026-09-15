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

# Do not start a run while something else owns the GPU. The collector's model takes
# ~7.9 GiB of this box's 8 GiB card and pegs 6 of 8 cores for the hours a run lasts, so
# two GPU jobs here are mutually exclusive rather than merely slow together. Nothing
# downstream notices: the watchdog probes only the router and ingest, and llama.cpp
# answers a contended card by crawling at a fraction of a token a second.
#
# The check sits BEFORE the claim on purpose. Claiming first would consume the queued run
# and then abandon it; deferring leaves it pending and the poll timer retries every few
# seconds, so the run starts by itself once the card is free.
#
# The model being LOADED proves nothing either way. It is loaded whenever anything has
# used it recently, and most of all while another job is mid-run — so "loaded" is as
# consistent with "a backfill owns the card" as with "idle and ours to take". The three
# tests below ask who is actually using it instead. Escape hatch: SOCIAL_COLLECT_GPU_GUARD=0.
WORK_DIR="${CLAUDE_WORK_DIR:-$HOME/.cache/social-update/claude}"
BUSY_STAMP="$HOME/.cache/social-update/gpu-busy.stamp"
DEFER_STAMP="$HOME/.cache/social-update/gpu-deferred.stamp"

# Sets DEFER_WHY and returns 0 when this tick must not claim.
should_defer() {
  [ "${SOCIAL_COLLECT_GPU_GUARD:-1}" = "0" ] && return 1

  # 1. Another job of ours holds the card. collect.lock is taken by the collector and,
  #    since it is the same kind of GPU work, by the tag backfill. This is the test the
  #    "is the model loaded" check could never be: an in-repo job is either holding a
  #    live lock or it is not.
  local lock="$WORK_DIR/collect.lock" pid
  if [ -f "$lock" ]; then
    pid="$(grep -oE '"pid":[0-9]+' "$lock" 2>/dev/null | head -1 | grep -oE '[0-9]+')"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      DEFER_WHY="collect.lock held by live pid $pid"
      return 0
    fi
  fi

  local router="${LLM_BASE_URL:-http://127.0.0.1:1921/v1}"
  router="${router%/v1}"
  # slots stays EMPTY when the model is unloaded and the probe below is skipped. It is
  # initialised here rather than merely declared because this script runs under `set -u`:
  # a bare `local slots` leaves it unbound, and the `[ -n "$slots" ]` test then aborts the
  # whole poller — which fails CLOSED, claiming nothing, ever, with only an "unbound
  # variable" line in the journal to say so.
  local models slots=""
  models="$(curl -fsS -m 5 "$router/models" 2>/dev/null)"

  # ONLY ask about slots when /models already says the model is loaded, and never the
  # other way round. `/slots?model=` is a REQUEST FOR THAT MODEL: on an unloaded one the
  # router spawns the child to serve it, which takes ~10s and pins ~7.9 GiB. Polling it
  # every few seconds made this guard the thing holding the card it exists to keep free —
  # measured 2026-09-14: unloaded and idle at 567 MiB, one /slots call later, loaded at
  # 7912 MiB. /models is the router's own state and spawns nothing, so it is safe to poll.
  #
  # Nothing needs asking when the model is unloaded anyway: nothing can be generating on a
  # model that is not resident, so the only question left is test 4, whether some other
  # application has the memory.
  if printf '%s' "$models" | grep -q "\"value\":\"loaded\""; then
    # /slots must be asked through the router WITH ?model=, which is how it finds the child
    # to proxy to; bare /slots is a 400 ("model name is missing from the request"). Reading
    # the child's own port out of the argv the router reports does NOT work — /models carries
    # both the requested port and the real one ("--port","0" and "--port","52180"), and
    # nothing in the JSON says which is which.
    slots="$(curl -fsS -m 5 "$router/slots?model=${LLM_MODEL:-qwen3.6-35b-a3b}" 2>/dev/null)"
  fi

  if [ -n "$slots" ]; then
    # 2. The model is generating for SOMEONE — a job outside this repo, another session,
    #    a hand-run script. /slots is the only thing that knows; the lock cannot see them.
    if printf '%s' "$slots" | grep -q '"is_processing":true'; then
      mkdir -p "$(dirname "$BUSY_STAMP")"; : > "$BUSY_STAMP"
      DEFER_WHY="model busy — a slot is processing"
      return 0
    fi
    # 3. Slots go idle for a beat between one chunk and the next, and a poll tick landing
    #    in that gap would read a busy model as free. Require a quiet stretch first.
    local quiet="${SOCIAL_COLLECT_GPU_QUIET_S:-120}" idle_for
    if [ -f "$BUSY_STAMP" ]; then
      idle_for="$(( $(date +%s) - $(stat -c %Y "$BUSY_STAMP") ))"
      if [ "$idle_for" -lt "$quiet" ]; then
        DEFER_WHY="model idle for only ${idle_for}s of the ${quiet}s quiet period"
        return 0
      fi
    fi
  fi

  # 4. The memory is gone and the router is not the one holding it: a Windows-side game
  #    or any other GPU application. Anything unreadable fails OPEN — a guard that stopped
  #    collection because it could not parse a number would be a worse outage than the
  #    contention it exists to prevent.
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  local used
  used="$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')"
  case "$used" in ''|*[!0-9]*) return 1 ;; esac
  [ "$used" -le "${SOCIAL_COLLECT_GPU_MAX_USED_MIB:-2000}" ] && return 1
  printf '%s' "$models" | grep -q "\"value\":\"loaded\"" && return 1
  DEFER_WHY="${used} MiB of VRAM held by something outside the router"
  return 0
}

if should_defer; then
  # One line per ten minutes, not one per poll tick: this runs every few seconds and a
  # deferral can last a whole evening.
  mkdir -p "$(dirname "$DEFER_STAMP")"
  if [ ! -f "$DEFER_STAMP" ] || [ "$(( $(date +%s) - $(stat -c %Y "$DEFER_STAMP") ))" -ge 600 ]; then
    echo "deferred: $DEFER_WHY — leaving any queued run pending"
    : > "$DEFER_STAMP"
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
