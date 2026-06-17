#!/usr/bin/env bash
# Install the collector as a WSL `systemd --user` timer. Idempotent; re-run after
# editing the units. Run inside WSL from the repo root: scripts/install-collector-systemd.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. watchdog script onto PATH
install -D -m 0755 "$repo/scripts/social-collect-watchdog.sh" "$HOME/.local/bin/social-collect-watchdog.sh"

# 2. systemd --user units
install -D -m 0644 "$repo/scripts/systemd/social-collect.service" "$HOME/.config/systemd/user/social-collect.service"
install -D -m 0644 "$repo/scripts/systemd/social-collect.timer"   "$HOME/.config/systemd/user/social-collect.timer"

# 3. let user units run without an active login session (WSL background)
loginctl enable-linger "$USER" || true

# 4. enable + start the timer
systemctl --user daemon-reload
systemctl --user enable --now social-collect.timer

echo "Installed. Next runs:"
systemctl --user list-timers social-collect.timer --no-pager
echo "Logs: journalctl --user -t social-collect"
