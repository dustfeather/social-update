#!/usr/bin/env bash
# Install the vault-keeper daily writer as a WSL `systemd --user` timer.
# Idempotent. Does NOT start the timer — shadow-test first
# (scripts/vault-daily.sh --shadow), then enable.
#   Run from the repo root: scripts/install-vault-daily.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. compile dist/vault-daily.js
( cd "$repo" && npm run build >/dev/null )

# 2. wrapper onto PATH
install -D -m 0755 "$repo/scripts/vault-daily.sh" "$HOME/.local/bin/vault-daily.sh"

# 3. systemd --user units
install -D -m 0644 "$repo/scripts/systemd/vault-daily.service" "$HOME/.config/systemd/user/vault-daily.service"
install -D -m 0644 "$repo/scripts/systemd/vault-daily.timer"   "$HOME/.config/systemd/user/vault-daily.timer"

loginctl enable-linger "$USER" || true
systemctl --user daemon-reload

echo "Installed (timer NOT started)."
echo "Shadow test:  $HOME/.local/bin/vault-daily.sh --shadow"
echo "Go live:      systemctl --user enable --now vault-daily.timer"
echo "Logs:         journalctl --user -t vault-daily -f"
