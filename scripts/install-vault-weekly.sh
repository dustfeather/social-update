#!/usr/bin/env bash
# Install the vault-keeper weekly drafter as a WSL `systemd --user` timer.
# Idempotent. Does NOT start the timer — shadow-test first
# (scripts/vault-weekly.sh --shadow), then enable.
#   Run from the repo root: scripts/install-vault-weekly.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. compile dist/vault-weekly.js
( cd "$repo" && npm run build >/dev/null )

# 2. wrapper onto PATH
install -D -m 0755 "$repo/scripts/vault-weekly.sh" "$HOME/.local/bin/vault-weekly.sh"

# 3. systemd --user units
install -D -m 0644 "$repo/scripts/systemd/vault-weekly.service" "$HOME/.config/systemd/user/vault-weekly.service"
install -D -m 0644 "$repo/scripts/systemd/vault-weekly.timer"   "$HOME/.config/systemd/user/vault-weekly.timer"

loginctl enable-linger "$USER" || true
systemctl --user daemon-reload

echo "Installed (timer NOT started)."
echo "Shadow test:  $HOME/.local/bin/vault-weekly.sh --shadow"
echo "Go live:      systemctl --user enable --now vault-weekly.timer"
echo "Logs:         journalctl --user -t vault-weekly -f"
