#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
# Installs dependencies, builds the CLI, links `agentcms` onto PATH and points previews at the
# container's Chromium, so tests, lint and the CLI work from the first prompt.
set -euo pipefail

# Local sessions already have a working checkout; only cloud containers need this.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# pnpm is the package manager (see packageManager in package.json).
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
  else
    npm install -g pnpm@10
  fi
fi

echo "[session-start] installing dependencies"
pnpm install --frozen-lockfile

echo "[session-start] building"
pnpm build

# Make the `agentcms` command available for manual testing (npm symlinks the checkout, so
# `pnpm build` after a change is enough to refresh it).
if ! command -v agentcms >/dev/null 2>&1; then
  npm install -g . >/dev/null 2>&1 || echo "[session-start] could not link agentcms globally; use: node bin/agentcms.js"
fi

# Preview screenshots: reuse the Chromium that Claude Code cloud containers ship with.
chrome="$(ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$chrome" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export AGENTCMS_CHROMIUM_PATH=\"$chrome\"" >> "$CLAUDE_ENV_FILE"
  echo "[session-start] screenshots will use $chrome"
fi

echo "[session-start] ready: pnpm test | pnpm lint | pnpm typecheck | agentcms --help"
