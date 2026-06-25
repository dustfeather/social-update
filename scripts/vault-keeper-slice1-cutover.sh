#!/usr/bin/env bash
#
# vault-keeper slice 1 — cutover.
# De-numbers the vault folders, merges Areas into Projects, rewrites all
# absolute-path links/configs to match, and tears down the legacy watcher /
# CI Action / Mermaid pre-commit hook (VAULT-KEEPER.md §3, §6).
#
# Idempotent. Default mode is DRY-RUN (prints what it would do, mutates
# nothing). Pass --apply to execute against the live vault.
#
#   scripts/vault-keeper-slice1-cutover.sh            # dry-run
#   scripts/vault-keeper-slice1-cutover.sh --apply    # do it
#
set -euo pipefail

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

VAULT="$(realpath "$HOME/obsidian.md")"
[[ -d "$VAULT/.git" ]] || { echo "FATAL: $VAULT is not a git repo" >&2; exit 1; }
gv() { git -C "$VAULT" "$@"; }

say()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
# run CMD...  -> echo in dry-run, execute on --apply
run()  { if (( APPLY )); then "$@"; else printf '  would: %s\n' "$*"; fi; }

# move SRC DST (dirs), idempotent, dry-run aware
mvdir() {
  local src="$VAULT/$1" dst="$VAULT/$2"
  if [[ -e "$dst" && ! -d "$src" ]]; then say "  skip (already): $1 -> $2"; return; fi
  if [[ ! -e "$src" ]];               then say "  skip (missing): $1"; return; fi
  run mv "$src" "$dst"
}

# delete a path from disk if it exists (tracked or not); final `git add -A`
# stages the deletion. Plain rm — `git rm` no-ops on paths untracked after mv.
rmpath() {
  local p="$VAULT/$1"
  if [[ -e "$p" ]]; then run rm -f -- "$p"; else say "  skip (gone): $1"; fi
}

say "VAULT  = $VAULT"
say "MODE   = $([[ $APPLY == 1 ]] && echo APPLY || echo DRY-RUN)"

# ---------------------------------------------------------------------------
step "0. Baseline checkpoint (rollback point)"
if (( APPLY )); then
  if [[ -n "$(gv status --porcelain)" ]]; then
    gv add -A
    gv commit -q -m "checkpoint: pre vault-keeper slice 1 cutover" || true
    say "  committed checkpoint @ $(gv rev-parse --short HEAD)"
  else
    say "  tree clean; checkpoint = HEAD $(gv rev-parse --short HEAD)"
  fi
else
  say "  would commit current tree as 'checkpoint: pre vault-keeper slice 1 cutover'"
fi

# ---------------------------------------------------------------------------
step "1. Stop & delete Windows 'Obsidian Watcher' task (§6.1)"
run schtasks.exe /End    /TN "Obsidian Watcher"      || true
run schtasks.exe /Delete /TN "Obsidian Watcher" /F   || true
[[ -e "$VAULT/.watcher.lock" ]] && rmpath ".watcher.lock" || say "  no .watcher.lock"

# ---------------------------------------------------------------------------
step "2. De-number folders + merge Areas -> Projects (§3)"
mvdir "00 Inbox"      "_Inbox"
mvdir "10 Daily Notes" "Daily Notes"
mvdir "40 Resources"  "Resources"
mvdir "20 Projects"   "Projects"
# merge: each Areas subfolder becomes a Projects subfolder (no name collisions verified)
if [[ -d "$VAULT/30 Areas" ]]; then
  shopt -s nullglob
  for d in "$VAULT/30 Areas"/*; do
    base="$(basename "$d")"
    if [[ -e "$VAULT/Projects/$base" ]]; then
      say "  COLLISION: Projects/$base exists — leaving 30 Areas/$base in place"
    else
      run mv "$d" "$VAULT/Projects/$base"
    fi
  done
  shopt -u nullglob
  run rmdir "$VAULT/30 Areas" || say "  30 Areas not empty; left in place"
else
  say "  skip (gone): 30 Areas"
fi
mvdir "99 System"     "System"

# ---------------------------------------------------------------------------
step "3. Rewrite link/path prefixes in notes (md + canvas)"
# Absolute-format wikilinks & canvas node paths embed the old folder prefix.
# Literal numbered prefixes never occur except as folder refs, so a literal
# replace is safe. Skip prose docs (README/CLAUDE/Home) — hand-edited after.
REWRITE='
  s{\Q00 Inbox\E}{_Inbox}g;
  s{\Q10 Daily Notes\E}{Daily Notes}g;
  s{\Q20 Projects\E}{Projects}g;
  s{\Q30 Areas\E}{Projects}g;
  s{\Q40 Resources\E}{Resources}g;
  s{\Q99 System\E}{System}g;
'
mapfile -d '' -t FILES < <(
  find "$VAULT" -type f \( -name '*.md' -o -name '*.canvas' \) \
    -not -path '*/.git/*' -not -path '*/.trash/*' -not -path '*/.obsidian/*' \
    ! -samefile "$VAULT/README.md" ! -samefile "$VAULT/CLAUDE.md" ! -samefile "$VAULT/Home.md" \
    -print0
)
HITS=0
for f in "${FILES[@]}"; do
  grep -qE '00 Inbox|10 Daily Notes|20 Projects|30 Areas|40 Resources|99 System' "$f" && HITS=$((HITS+1))
done
say "  $HITS / ${#FILES[@]} note files contain old folder refs"
if (( APPLY )); then
  printf '%s\0' "${FILES[@]}" | xargs -0 -r perl -i -pe "$REWRITE"
  say "  rewritten"
else
  say "  would: perl -i rewrite the $HITS file(s)"
fi

# ---------------------------------------------------------------------------
step "4. Fix .obsidian config path references"
for cfg in app.json daily-notes.json templates.json canvas.json \
           workspace.json workspace-mobile.json \
           plugins/templater-obsidian/data.json; do
  p="$VAULT/.obsidian/$cfg"
  [[ -f "$p" ]] || { say "  skip (missing): $cfg"; continue; }
  if grep -qE '00 Inbox|10 Daily Notes|20 Projects|30 Areas|40 Resources|99 System' "$p"; then
    if (( APPLY )); then perl -i -pe "$REWRITE" "$p"; say "  fixed: $cfg"
    else say "  would fix: $cfg"; fi
  else
    say "  clean: $cfg"
  fi
done

# ---------------------------------------------------------------------------
step "5. Drop Mermaid pre-commit hook (§6.3)"
rmpath "System/Hooks/pre-commit"
if (( APPLY )); then
  gv config --unset core.hooksPath 2>/dev/null || true
  say "  core.hooksPath unset -> '$(gv config --get core.hooksPath || echo '(none)')'"
else
  say "  would: git -C VAULT config --unset core.hooksPath"
fi

# ---------------------------------------------------------------------------
step "6. Retire CI Action + remove dead scripts (§6.2, §6.4)"
rmpath ".github/workflows/github-to-vault.yml"
rmpath "System/Scripts/github-fetch-delta.sh"
rmpath "System/Scripts/graph-to-mermaid.sh"
rmpath "System/Scripts/install-hooks.sh"
rmpath "System/Scripts/Watch-Inbox.ps1"
rmpath "System/Scripts/Watch-Inbox.vbs"
rmpath "System/Scripts/watcher.log"

# ---------------------------------------------------------------------------
step "7. Stage migration (NOT committed — review then commit by hand)"
if (( APPLY )); then
  gv add -A
  say "  staged. Review:  git -C \"\$VAULT\" status --short | head"
  say "  rollback:        git -C \"\$VAULT\" reset --hard HEAD  (checkpoint commit)"
else
  say "  would: git -C VAULT add -A"
fi

say ""
say "DONE ($([[ $APPLY == 1 ]] && echo APPLIED || echo dry-run))."
