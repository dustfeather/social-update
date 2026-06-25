#!/usr/bin/env bash
# Install the vault-keeper inbox sorter as a WSL `systemd --user` timer.
# Idempotent; re-run after editing the script or units. Does NOT start the timer
# — shadow-test first (scripts/vault-inbox-sorter.sh --shadow), then enable.
#   Run from the repo root: scripts/install-vault-inbox-sorter.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. sorter + write-guard onto PATH, plus the guard's settings file
install -D -m 0755 "$repo/scripts/vault-inbox-sorter.sh"            "$HOME/.local/bin/vault-inbox-sorter.sh"
install -D -m 0755 "$repo/scripts/vault-write-guard.sh"             "$HOME/.local/bin/vault-write-guard.sh"
install -D -m 0644 "$repo/scripts/vault-keeper-sorter-settings.json" "$HOME/.local/bin/vault-keeper-sorter-settings.json"

# 2. systemd --user units
install -D -m 0644 "$repo/scripts/systemd/vault-inbox-sort.service" "$HOME/.config/systemd/user/vault-inbox-sort.service"
install -D -m 0644 "$repo/scripts/systemd/vault-inbox-sort.timer"   "$HOME/.config/systemd/user/vault-inbox-sort.timer"

# 3. background user units without an active login (WSL)
loginctl enable-linger "$USER" || true
systemctl --user daemon-reload

echo "Installed (timer NOT started)."
echo "Shadow test:  $HOME/.local/bin/vault-inbox-sorter.sh --shadow"
echo "Go live:      systemctl --user enable --now vault-inbox-sort.timer"
echo "Logs:         journalctl --user -t vault-inbox-sort -f"
