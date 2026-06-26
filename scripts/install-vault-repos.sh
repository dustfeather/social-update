#!/usr/bin/env bash
# Install the vault-keeper repo->Projects backfill as a WSL `systemd --user` timer.
# Idempotent. Does NOT start the timer — shadow-test first
# (scripts/vault-repos.sh --shadow), then enable.
#   Run from the repo root: scripts/install-vault-repos.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. wrappers onto PATH (vault-repos.mjs + graphify-bridge.mjs run uncompiled)
install -D -m 0755 "$repo/scripts/vault-repos.sh" "$HOME/.local/bin/vault-repos.sh"

# 2. systemd --user units
install -D -m 0644 "$repo/scripts/systemd/vault-repos.service" "$HOME/.config/systemd/user/vault-repos.service"
install -D -m 0644 "$repo/scripts/systemd/vault-repos.timer"   "$HOME/.config/systemd/user/vault-repos.timer"

loginctl enable-linger "$USER" || true
systemctl --user daemon-reload

echo "Installed (timer NOT started)."
echo "Dry run:      $HOME/.local/bin/vault-repos.sh --dry"
echo "Shadow test:  $HOME/.local/bin/vault-repos.sh --shadow"
echo "Go live:      systemctl --user enable --now vault-repos.timer"
echo "Logs:         journalctl --user -t vault-repos -f"
