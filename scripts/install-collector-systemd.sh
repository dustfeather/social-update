#!/usr/bin/env bash
# Install the collector as a WSL `systemd --user` timer. Idempotent; re-run after
# editing the units. Run inside WSL from the repo root: scripts/install-collector-systemd.sh
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

# 1. watchdog + poller scripts onto PATH
install -D -m 0755 "$repo/scripts/social-collect-watchdog.sh" "$HOME/.local/bin/social-collect-watchdog.sh"
install -D -m 0755 "$repo/scripts/social-collect-poll.sh"     "$HOME/.local/bin/social-collect-poll.sh"

# 2. systemd --user units. The daily timer enqueues a run; the poll timer claims it
#    and runs the collectors (single execution path).
install -D -m 0644 "$repo/scripts/systemd/social-collect.service"      "$HOME/.config/systemd/user/social-collect.service"
install -D -m 0644 "$repo/scripts/systemd/social-collect.timer"        "$HOME/.config/systemd/user/social-collect.timer"
install -D -m 0644 "$repo/scripts/systemd/social-collect-poll.service" "$HOME/.config/systemd/user/social-collect-poll.service"
install -D -m 0644 "$repo/scripts/systemd/social-collect-poll.timer"   "$HOME/.config/systemd/user/social-collect-poll.timer"

# 3. let user units run without an active login session (WSL background)
loginctl enable-linger "$USER" || true

# 4. enable + start the timers
systemctl --user daemon-reload
systemctl --user enable --now social-collect.timer
systemctl --user enable --now social-collect-poll.timer

echo "Installed. Next runs:"
systemctl --user list-timers social-collect.timer social-collect-poll.timer --no-pager
echo "Logs: journalctl --user -t social-collect  (daily enqueue)"
echo "      journalctl --user -t social-collect-poll  (claim + run)"
