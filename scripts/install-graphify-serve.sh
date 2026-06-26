#!/usr/bin/env bash
# Install graphify-serve as a WSL `systemd --user` service — a live web view of the
# merged bridged graph at http://localhost:8088 (set PORT= in the unit to change).
# It parses ~/.graphify/bridged/graphify-out/graph.html and streams node/edge deltas
# over SSE, so the browser graph grows in place as graphify-watch re-bridges. Read-only,
# no LLM. Pairs with install-graphify-watch.sh. Idempotent.
#   Run from the repo root: scripts/install-graphify-serve.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

install -D -m 0644 "$repo/scripts/systemd/graphify-serve.service" \
  "$HOME/.config/systemd/user/graphify-serve.service"

loginctl enable-linger "$USER" || true
systemctl --user daemon-reload
systemctl --user enable --now graphify-serve.service

echo "Installed and started graphify-serve.service"
echo "Open:    http://localhost:8088"
echo "Status:  systemctl --user status graphify-serve.service"
echo "Logs:    journalctl --user -t graphify-serve -f"
echo "Stop:    systemctl --user disable --now graphify-serve.service"
