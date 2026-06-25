#!/usr/bin/env bash
#
# vault-keeper PreToolUse write-guard (VAULT-KEEPER.md §5).
# Hard blast-radius cap for headless vault-keeper agents running under
# bypassPermissions: denies Write/Edit/MultiEdit/NotebookEdit whose target path
# resolves outside the Obsidian vault (+ the collector SQLite ledger).
#
# Wired via --settings vault-keeper-sorter-settings.json. Reads the PreToolUse
# JSON event on stdin; exit 0 = allow, exit 2 = deny (reason on stderr).
#
# NOTE: slice 2's sorter grants the model NO tools, so this never fires there —
# it is defense-in-depth and the load-bearing guard for slice 3's daily writer.
# Mutating-Bash guarding is intentionally deferred to slice 3.
#
set -uo pipefail

VAULT="$(realpath "$HOME/obsidian.md" 2>/dev/null)" || exit 0   # no vault → don't block
LEDGER="$HOME/projects/social-update/.vault-keeper/ledger.sqlite"  # slice 3 ledger (allowed)

event="$(cat)"
tool="$(printf '%s' "$event" | jq -r '.tool_name // empty' 2>/dev/null)"

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;   # only guard file-writing tools here
esac

path="$(printf '%s' "$event" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)"
[[ -z "$path" ]] && exit 0

real="$(realpath -m "$path" 2>/dev/null)"
case "$real" in
  "$VAULT"/*|"$VAULT") exit 0 ;;
  "$LEDGER")           exit 0 ;;
  *) echo "vault-write-guard: DENY $tool to '$real' (outside vault $VAULT)" >&2; exit 2 ;;
esac
