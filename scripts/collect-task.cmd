@echo off
REM Windows Task Scheduler entry point for the daily collector.
REM Runs inside WSL via a login shell so PATH / node (nvm etc.) resolve,
REM cd's into the project so dotenv picks up .env, and appends to collect.log.
REM Fires even with no WSL shell open.
wsl.exe -d Ubuntu-24.04 -- bash -lic "cd ~/projects/social-update && node dist/collect.js >> collect.log 2>&1"
