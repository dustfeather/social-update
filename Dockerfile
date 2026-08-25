# ---- builder: compile backend (tsc -> dist/) + frontend (vite -> web/dist) ----
# No native toolchain: SQLite is the built-in node:sqlite module, nothing to compile.
# That is also why this tracks Node 26 rather than waiting for its October 2026
# LTS date -- the usual reason to hold a major back is native addons compiling
# against removed V8 APIs, and there is nothing here to compile.
FROM node:26-bookworm-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# The web collector's Playwright dep is only run on the local collector box,
# never in the cluster server — skip its ~150MB browser download in the image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Backend deps (full, incl. tsc) + compile.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Frontend: its own lockfile/node_modules, built to static web/dist (no runtime deps).
COPY web ./web
RUN npm --prefix web ci && npm --prefix web run build

# Reduce the backend node_modules to prod-only: drop devDependencies (typescript,
# @types) before the copy into runtime. No native modules to rebuild.
RUN npm ci --omit=dev

# ---- runtime: node + prod deps + static UI + Claude CLI, no toolchain, non-root ----
FROM node:26-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — the Generate endpoint spawns `claude -p --output-format json`.
# Auth is non-interactive via CLAUDE_CODE_OAUTH_TOKEN (injected from a k8s Secret).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY prompt.txt ./prompt.txt

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Non-root (matches runAsUser: 10001 in deploy/deployment.yaml). /data is the
# SQLite PVC mount; HOME must be writable for the Claude CLI's config/cache.
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/agent agent \
  && mkdir -p /data \
  && chown -R 10001:10001 /data /home/agent
# node:sqlite is stable as of Node 26, so there is no experimental warning left to
# silence. The NODE_OPTIONS suppression that used to live here is deliberately
# gone rather than kept "just in case": it muted EVERY ExperimentalWarning, so
# leaving it would hide the next module that starts emitting one.
#
# DOTENV_CONFIG_QUIET is for dotenv 17, whose sole breaking change was defaulting
# `quiet` to false. Nine modules call config() at import time and `.env` is
# dockerignored, so without this each one logs `injected env (0) from .env` on
# startup -- accurate, but it reads like a config failure when prod config
# actually comes from ENV above and the k8s Secret. One variable covers all nine
# call sites, and 16.x simply ignores it, so it is safe in either version.
ENV HOME=/home/agent NODE_ENV=production DB_PATH=/data/social.sqlite \
    DOTENV_CONFIG_QUIET=true
USER 10001
EXPOSE 4000
CMD ["node", "dist/server.js"]
