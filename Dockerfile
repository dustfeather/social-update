# ---- builder: compile backend (tsc -> dist/) + frontend (vite -> web/dist) ----
# No native toolchain: SQLite is the built-in node:sqlite module, nothing to compile.
FROM node:24-bookworm-slim AS builder
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
FROM node:24-bookworm-slim
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
# node:sqlite is still flagged experimental; silence its one-line startup warning.
ENV HOME=/home/agent NODE_ENV=production DB_PATH=/data/social.sqlite \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
USER 10001
EXPOSE 4000
CMD ["node", "dist/server.js"]
