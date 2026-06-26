#!/usr/bin/env bash
# Install graphify-watch as a WSL `systemd --user` service — the repo-scope driver
# for graphify-bridge. Watches ~/.graphify/global-graph.json (refreshed by every
# repo's post-commit hook) and re-bridges on change. The VAULT side is the separate
# vault-repos timer (see install-vault-repos.sh); the vault is on /mnt/c and can't
# be watched. Idempotent. Safe to start immediately (no LLM, read-only inputs).
#   Run from the repo root: scripts/install-graphify-watch.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

install -D -m 0644 "$repo/scripts/systemd/graphify-watch.service" \
  "$HOME/.config/systemd/user/graphify-watch.service"

loginctl enable-linger "$USER" || true
systemctl --user daemon-reload
systemctl --user enable --now graphify-watch.service

echo "Installed and started graphify-watch.service"
echo "Status:  systemctl --user status graphify-watch.service"
echo "Logs:    journalctl --user -t graphify-watch -f"
echo "Stop:    systemctl --user disable --now graphify-watch.service"
