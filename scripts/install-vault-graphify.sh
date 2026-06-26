#!/usr/bin/env bash
#
# Install vault-keeper slice 4 — Graphify (VAULT-KEEPER.md §4.4).
# Idempotent. Does NOT ingest anything — run the worker afterwards
# (shadow first: vault-graphify.sh --shadow), then go live.
#
# Run from the repo root:  scripts/install-vault-graphify.sh
#
#   1. ensure the graphifyy CLI (+ anthropic extra) via pipx
#   2. register the global /graphify Claude Code skill  (graphify install)
#   3. drop the federation worker onto PATH
#
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"

# 1. graphifyy CLI ---------------------------------------------------------
if ! command -v graphify >/dev/null 2>&1; then
  echo "Installing graphifyy via pipx..."
  pipx install graphifyy
fi
# anthropic extra: needed by the 'claude'/'claude-cli' label+semantic backends
pipx inject graphifyy anthropic >/dev/null 2>&1 || true
echo "graphify: $(graphify --version 2>/dev/null || echo present)"

# 1b. MCP-off patch (idempotent) ------------------------------------------
# graphify's claude-cli backend shells `claude -p`, which otherwise boots the
# user's FULL MCP stack (serena/context-mode/headroom/code-review-graph) on
# EVERY chunk — ~80s/call and it stalls under repeated invocation. Extraction
# needs no MCP, so we inject --strict-mcp-config. Cuts a call ~80s -> ~3s.
# Re-apply after every `pipx upgrade graphifyy` (the venv file is overwritten).
# Opt out at runtime with GRAPHIFY_KEEP_MCP=1.
python3 - <<'PY' || echo "WARN: MCP-off patch skipped (graphify internals changed?)"
from pathlib import Path
import glob, os
hits = glob.glob(os.path.expanduser("~/.local/share/pipx/venvs/graphifyy/lib/python*/site-packages/graphify/llm.py"))
if not hits:
    print("llm.py not found"); raise SystemExit(0)
f = Path(hits[0]); s = f.read_text()
marker = "vault-keeper: graphify extraction needs no MCP"
if marker in s:
    print("MCP-off patch already present"); raise SystemExit(0)
needle = '        "--no-session-persistence",\n        *add_dir_args,'
if needle not in s:
    print("needle absent — graphify internals changed; patch NOT applied"); raise SystemExit(0)
repl = ('        "--no-session-persistence",\n'
        '        # ' + marker + ': disable the user MCP stack so each\n'
        '        # claude -p does not boot serena/context-mode (stalls under repeated\n'
        '        # invocation). Set GRAPHIFY_KEEP_MCP=1 to opt out.\n'
        '        *([] if os.environ.get("GRAPHIFY_KEEP_MCP", "").strip() == "1"\n'
        '          else ["--strict-mcp-config", "--mcp-config", \'{"mcpServers":{}}\']),\n'
        '        *add_dir_args,')
f.write_text(s.replace(needle, repl, 1)); print("MCP-off patch applied")
PY

# 2. global /graphify skill ------------------------------------------------
# Writes ~/.claude/skills/graphify/, a CLAUDE.md directive, and a PreToolUse
# hook that consults graphify-out before Glob/Grep. Edits the curated global
# ~/.claude/CLAUDE.md — back it up first (restore from .vault-keeper/backups/).
mkdir -p "$repo/.vault-keeper/backups"
cp -n "$HOME/.claude/CLAUDE.md"     "$repo/.vault-keeper/backups/CLAUDE.md.pre-graphify"     2>/dev/null || true
cp -n "$HOME/.claude/settings.json" "$repo/.vault-keeper/backups/settings.json.pre-graphify" 2>/dev/null || true
graphify install --platform claude

# 3. worker onto PATH ------------------------------------------------------
install -D -m 0755 "$repo/scripts/vault-graphify.sh" "$HOME/.local/bin/vault-graphify.sh"

cat <<EOF

Installed (nothing ingested yet).
Shadow (AST-only, no LLM/quota):  vault-graphify.sh --shadow
Go live (federated, claude-cli):  vault-graphify.sh
Single repo:                      vault-graphify.sh --repo social-update
Query the federated graph:        graphify query "<question>" --graph \$HOME/.graphify/global-graph.json
Freshness:                        per-repo post-commit hooks (installed by the worker)
EOF
