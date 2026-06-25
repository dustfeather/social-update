#!/usr/bin/env bash
#
# vault-keeper slice 2 — inbox sorter.
# Drains the vault `_Inbox`: a read-only Haiku pass classifies each pending note
# and emits a JSON routing plan; this script then performs the moves itself,
# confined to the vault. The model never touches the filesystem — capability
# removal is the write-guard (see VAULT-KEEPER.md §4.1, §5).
#
# Invoked every 30s by the vault-inbox-sort systemd --user timer (drain-on-run).
#   journalctl --user -t vault-inbox-sort
#
#   vault-inbox-sorter.sh             # classify + move (live)
#   vault-inbox-sorter.sh --shadow    # classify + print plan, move nothing
#
set -uo pipefail

SHADOW=0
[[ "${1:-}" == "--shadow" ]] && SHADOW=1

VAULT="$(realpath "$HOME/obsidian.md" 2>/dev/null)" || { echo "ERROR: vault symlink missing"; exit 1; }
INBOX="$VAULT/_Inbox"
[[ -d "$INBOX" ]] || { echo "ERROR: $INBOX missing"; exit 1; }

HEADROOM="$HOME/.local/bin/headroom"
SETTINGS="$HOME/.local/bin/vault-keeper-sorter-settings.json"   # write-guard hook (defense in depth)
MAX_NOTES=20          # drain at most N per run; the rest go next cycle
MIN_AGE_S=15          # skip notes touched < this many seconds ago (mid-write / mid-Syncthing)
EXCERPT_CHARS=1500    # per-note text handed to the classifier

# --- collect pending notes (flat _Inbox, *.md, settled, not sync-conflicts) ----
mapfile -d '' -t PENDING < <(
  find "$INBOX" -maxdepth 1 -type f -name '*.md' \
    ! -name '.*' ! -name '*.sync-conflict-*' \
    -print0 2>/dev/null
)
# filter by age (mtime) and cap count
now="$(date +%s)"
FILES=()
for f in "${PENDING[@]}"; do
  m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
  (( now - m >= MIN_AGE_S )) && FILES+=("$f")
  (( ${#FILES[@]} >= MAX_NOTES )) && break
done

if (( ${#FILES[@]} == 0 )); then
  exit 0   # nothing settled to sort; stay quiet (timer runs every 30s)
fi
echo "sorting ${#FILES[@]} note(s) from _Inbox $([[ $SHADOW == 1 ]] && echo '(SHADOW)')"

# --- build the classifier prompt (notes inlined; model gets NO tools) ----------
PROMPT=$'You are an Obsidian vault inbox sorter. Classify each note below into exactly one action.\n\n'
PROMPT+=$'Actions:\n'
PROMPT+=$'- project  : goal-driven work OR an ongoing life domain (software engineering, software business, homelab, gaming, car tuning, health, trading). dest under Projects/\n'
PROMPT+=$'- resource : evergreen reference / how-to / external spec. dest = Resources/\n'
PROMPT+=$'- note     : a standalone atomic idea or thought. dest = Notes/\n'
PROMPT+=$'- tasklog  : a dated activity or task-log jotting. dest = Notes/\n'
PROMPT+=$'- leave    : unclear, mixed, or needs a human. Stays in the inbox.\n\n'
PROMPT+=$'Rules:\n'
PROMPT+=$'- If you are not confident, use action "leave". Never guess.\n'
PROMPT+=$'- "dest" is a vault-relative directory and MUST start with Projects/, Resources/, or Notes/ (omit for leave).\n'
PROMPT+=$'- "title" = a clean human title for the note. "tags" = 1-4 lowercase tags. "status" only for projects (active|ongoing|planned|done), else "".\n'
PROMPT+=$'- Do not invent or summarize content; you only classify.\n\n'
PROMPT+=$'Respond with ONLY a JSON array, one object per note, no prose, no code fences:\n'
PROMPT+=$'[{"file":"<exact filename>","action":"project|resource|note|tasklog|leave","dest":"<dir or empty>","title":"...","tags":["..."],"status":"..."}]\n\n'
PROMPT+=$'Existing destination folders (prefer the most specific existing match; you may name a new subfolder under Projects/, Resources/, or Notes/ when none fits):\n'
DESTS="$(cd "$VAULT" && find Projects Resources Notes -maxdepth 2 -type d 2>/dev/null | sort)"
PROMPT+="$DESTS"
PROMPT+=$'\n\n=== NOTES ===\n'
for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  PROMPT+=$'\n--- FILE: '"$base"$' ---\n'
  PROMPT+="$(head -c "$EXCERPT_CHARS" "$f" 2>/dev/null)"
  PROMPT+=$'\n'
done

# --- classify (read-only; no tools granted to the model) -----------------------
GUARD=()
[[ -f "$SETTINGS" ]] && GUARD=(--settings "$SETTINGS")
# NB: `headroom wrap claude` parses -p as its own --port, so pass claude's args
# after `--`. The headroom banner prints to stdout before the JSON, so pull out
# the single {"type":"result",...} envelope line.
raw="$(HOME="$HOME" "$HEADROOM" wrap claude -- -p "$PROMPT" \
        --model haiku \
        --permission-mode bypassPermissions \
        --disallowed-tools Bash Edit Write MultiEdit NotebookEdit Read Glob Grep WebFetch WebSearch Task \
        --output-format json \
        "${GUARD[@]}" 2>/dev/null)" || { echo "ERROR: classifier invocation failed"; exit 1; }

envelope="$(printf '%s' "$raw" | grep -E '\{"type":"result"' | tail -1)"
result="$(printf '%s' "$envelope" | jq -r '.result // empty' 2>/dev/null)"
[[ -z "$result" ]] && result="$raw"
# the model is told to emit ONLY the array; just strip any ``` fences (don't
# slice on the first ] — that would cut at an inner tags[] array).
plan="$(printf '%s' "$result" | grep -v '^[[:space:]]*```' | tr -d '\000')"
if ! printf '%s' "$plan" | jq -e 'type=="array"' >/dev/null 2>&1; then
  echo "ERROR: classifier did not return a JSON array; left inbox untouched"
  echo "---- raw (first 400 chars) ----"; printf '%s' "$raw" | head -c 400; echo
  exit 1
fi

(( SHADOW )) && { echo "---- plan ----"; printf '%s' "$plan" | jq .; echo "--------------"; }

# --- execute the plan (deterministic, vault-confined) --------------------------
today="$(LC_TIME=C TZ=Europe/Bucharest date +%F)"
moved=0; left=0; skipped=0
n="$(printf '%s' "$plan" | jq 'length')"
for ((i=0; i<n; i++)); do
  obj="$(printf '%s' "$plan" | jq -c ".[$i]")"
  file="$(printf '%s' "$obj" | jq -r '.file // empty')"
  action="$(printf '%s' "$obj" | jq -r '.action // "leave"')"
  dest="$(printf '%s' "$obj" | jq -r '.dest // empty')"; dest="${dest%/}"
  title="$(printf '%s' "$obj" | jq -r '.title // empty')"
  status="$(printf '%s' "$obj" | jq -r '.status // empty')"
  tags="$(printf '%s' "$obj" | jq -r '(.tags // []) | join(", ")')"

  # filename must be a bare name that exists in the inbox (no path tricks)
  if [[ -z "$file" || "$file" == */* || "$file" == .* || ! -f "$INBOX/$file" ]]; then
    echo "  skip (bad/missing file): '$file'"; skipped=$((skipped+1)); continue
  fi
  if [[ "$action" == "leave" || -z "$dest" ]]; then
    echo "  leave: $file"; left=$((left+1)); continue
  fi
  # dest whitelist + no escape outside vault
  case "$dest" in
    Projects|Projects/*|Resources|Resources/*|Notes|Notes/*) : ;;
    *) echo "  skip (dest not allowed): $file -> '$dest'"; skipped=$((skipped+1)); continue ;;
  esac
  destdir="$VAULT/$dest"
  real="$(realpath -m "$destdir")"
  case "$real/" in "$VAULT/"*) : ;; *) echo "  skip (dest escapes vault): $file"; skipped=$((skipped+1)); continue ;; esac

  if (( SHADOW )); then
    echo "  would route: $file -> $dest/  [${action}; tags: ${tags:-none}]"
    moved=$((moved+1)); continue
  fi

  mkdir -p "$destdir"
  # light-touch: prepend frontmatter only if the note has none; body verbatim
  src="$INBOX/$file"
  if ! head -1 "$src" | grep -q '^---$'; then
    fmtags="$(printf '%s' "$obj" | jq -c '(.tags // [])')"
    tmp="$(mktemp)"
    {
      echo "---"
      echo "date: $today"
      echo "tags: $fmtags"
      [[ -n "$status" ]] && echo "status: $status"
      [[ -n "$title"  ]] && echo "title: \"${title//\"/\\\"}\""
      echo "---"
      echo
      cat "$src"
    } > "$tmp"
    mv "$tmp" "$src"
  fi
  if mv -n "$src" "$destdir/$file"; then
    echo "  moved: $file -> $dest/  [${action}]"
    moved=$((moved+1))
  else
    echo "  WARN: mv failed (clobber?): $file"; skipped=$((skipped+1))
  fi
done

echo "done: routed=$moved left=$left skipped=$skipped $([[ $SHADOW == 1 ]] && echo '(SHADOW — nothing moved)')"
