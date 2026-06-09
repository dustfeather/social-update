# ---- builder: compile backend (tsc -> dist/) + frontend (vite -> web/dist) ----
# build-essential + python3 are needed to compile better-sqlite3's native addon.
FROM node:26-bookworm-slim AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Backend deps (full, incl. tsc) + compile.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Frontend: its own lockfile/node_modules, built to static web/dist (no runtime deps).
COPY web ./web
RUN npm --prefix web ci && npm --prefix web run build

# Reduce the backend node_modules to prod-only. `npm ci` wipes + reinstalls, so
# better-sqlite3's compiled .node is rebuilt here (build tools still present) and
# devDependencies (typescript, @types) are dropped before the copy into runtime.
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

# Non-root (matches runAsUser: 10001 in deploy/deployment.yaml). /data is the
# SQLite PVC mount; HOME must be writable for the Claude CLI's config/cache.
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/agent agent \
  && mkdir -p /data \
  && chown -R 10001:10001 /data /home/agent
ENV HOME=/home/agent NODE_ENV=production DB_PATH=/data/social.sqlite
USER 10001
EXPOSE 4000
CMD ["node", "dist/server.js"]
