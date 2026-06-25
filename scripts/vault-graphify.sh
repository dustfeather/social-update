#!/usr/bin/env bash
#
# vault-keeper slice 4 — Graphify federation worker (VAULT-KEEPER.md §4.4).
#
# Builds a per-repo Graphify knowledge graph for every local git repo under
# ~/projects + the Obsidian vault, federating them all into ONE global graph
# (~/.graphify/global-graph.json) via `graphify extract --global --as <tag>`.
# Installs a post-commit freshness hook in each repo so the graph rebuilds on
# every commit (no background watcher — 9p has no inotify; see spec §2).
#
# Backend = `claude-cli`: graphify shells `claude -p --output-format json`,
# which authenticates via the existing Claude subscription login (~/.claude),
# NOT a metered ANTHROPIC_API_KEY. This is the load-bearing reason vault-keeper
# can run LLM extraction at all (HANDOFF landmine: subscription, no metered key).
# GRAPHIFY_CLAUDE_CLI_MODEL=haiku keeps the structured-JSON extraction cheap.
#
# NOTE: graphify's CLI has NO workspace/federation mode (spec §4.4 assumed one,
# Issue #425 — does not exist in v0.8.x). `--global` IS the federation: each
# repo's graph merges into ~/.graphify/global-graph.json. This supersedes the
# logical-join-via-repo-map fallback the spec held in reserve.
#
# Idempotent: graphify keeps a SHA256 cache per repo (graphify-out/cache/), so
# re-runs only reprocess changed files. Safe to run repeatedly.
#
# Usage:
#   vault-graphify.sh                # full federated ingest (LLM via claude-cli)
#   vault-graphify.sh --shadow       # AST-only (no LLM, no --global, no hooks) dry pass
#   vault-graphify.sh --repo NAME    # single repo (dir name under ~/projects, or 'vault')
#   vault-graphify.sh --no-hooks     # skip post-commit hook install
#
set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
export GRAPHIFY_CLAUDE_CLI_MODEL="${GRAPHIFY_CLAUDE_CLI_MODEL:-haiku}"

REPOS_DIR="$HOME/projects"
VAULT="$(readlink -f "$HOME/obsidian.md" 2>/dev/null)"
VAULT_OUT="$HOME/.graphify/vaultgraph"   # keep graph internals OUT of the synced vault (spec §8)
BACKEND="claude-cli"
TAG_PREFIX=""                            # global tags are bare dir names

SHADOW=0
NO_HOOKS=0
ONLY_REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shadow)   SHADOW=1 ;;
    --no-hooks) NO_HOOKS=1 ;;
    --repo)     ONLY_REPO="${2:-}"; shift ;;
    *) echo "vault-graphify: unknown arg '$1'" >&2; exit 2 ;;
  esac
  shift
done

log() { logger -t vault-graphify "$*" 2>/dev/null; echo "[vault-graphify] $*"; }

command -v graphify >/dev/null 2>&1 || { log "FATAL: graphify not on PATH (run install-vault-graphify.sh)"; exit 1; }
if [[ $SHADOW -eq 0 ]]; then
  command -v claude >/dev/null 2>&1 || { log "FATAL: claude CLI not on PATH (needed for --backend claude-cli)"; exit 1; }
fi

# Ingest one directory. $1=path  $2=tag  $3=is_git(0/1)
ingest() {
  local path="$1" tag="$2" is_git="$3"
  [[ -d "$path" ]] || { log "skip $tag: $path missing"; return; }

  if [[ $SHADOW -eq 1 ]]; then
    log "shadow (AST-only) $tag"
    graphify update "$path" 2>&1 | sed "s/^/  [$tag] /"
    return
  fi

  log "ingest $tag (backend=$BACKEND model=$GRAPHIFY_CLAUDE_CLI_MODEL)"
  local extra=()
  [[ "$tag" == "vault" ]] && extra+=(--out "$VAULT_OUT")
  graphify extract "$path" --backend "$BACKEND" --global --as "$tag" "${extra[@]}" 2>&1 \
    | sed "s/^/  [$tag] /"
  local rc=${PIPESTATUS[0]}
  [[ $rc -ne 0 ]] && { log "WARN $tag: extract exit $rc"; }

  # Freshness: post-commit rebuild hook (git repos only).
  if [[ $is_git -eq 1 && $NO_HOOKS -eq 0 ]]; then
    ( cd "$path" && graphify hook install >/dev/null 2>&1 ) \
      && log "  hook installed $tag" || log "  WARN hook install failed $tag"
    # keep graph artifacts out of git without touching the tracked .gitignore
    local excl="$path/.git/info/exclude"
    if [[ -f "$excl" ]] && ! grep -qx 'graphify-out/' "$excl" 2>/dev/null; then
      printf 'graphify-out/\n' >> "$excl"
    fi
  fi
}

# --- repos under ~/projects (git only) ---
run_repos() {
  for d in "$REPOS_DIR"/*/; do
    [[ -d "$d/.git" ]] || continue
    local name; name="$(basename "$d")"
    [[ -n "$ONLY_REPO" && "$ONLY_REPO" != "$name" ]] && continue
    ingest "${d%/}" "$name" 1
  done
}

# --- vault ---
run_vault() {
  [[ -z "$ONLY_REPO" || "$ONLY_REPO" == "vault" ]] || return
  [[ -n "$VAULT" ]] || { log "skip vault: ~/obsidian.md unresolved"; return; }
  local is_git=0; [[ -d "$VAULT/.git" ]] && is_git=1
  ingest "$VAULT" "vault" "$is_git"
}

log "start (shadow=$SHADOW repo='${ONLY_REPO:-all}')"
run_repos
run_vault
log "done. global graph: $HOME/.graphify/global-graph.json"
[[ $SHADOW -eq 0 ]] && log "query it: graphify query \"<question>\" --graph $HOME/.graphify/global-graph.json"
