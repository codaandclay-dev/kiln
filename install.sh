#!/usr/bin/env bash
# Installs kiln for Claude Code: links this folder to ~/.claude/kiln and the
# /kiln command into ~/.claude/commands. Re-run after moving the folder.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

command -v node >/dev/null || { echo "kiln needs Node.js 20 or newer (https://nodejs.org)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "kiln needs Node.js 20 or newer; found $(node --version)"; exit 1; }

mkdir -p "$CLAUDE_DIR/commands"
for target in "$CLAUDE_DIR/kiln" "$CLAUDE_DIR/commands/kiln.md"; do
  if [ -e "$target" ] && [ ! -L "$target" ]; then echo "$target already exists and is not a link made by kiln. Move it away and re-run."; exit 1; fi
done
ln -sfn "$HERE" "$CLAUDE_DIR/kiln"
ln -sfn "$HERE/commands/kiln.md" "$CLAUDE_DIR/commands/kiln.md"

echo "Installing dependencies and browsers (first time only: a few minutes)…"
(cd "$HERE" && npm install --no-audit --no-fund && npx playwright install chromium webkit firefox)

if command -v codex >/dev/null && codex login status 2>&1 | grep -qi "logged in"; then
  echo "Codex: installed and logged in."
else
  echo "Codex: NOT ready. Install the Codex CLI and run 'codex login' before using /kiln."
fi
echo "Done. In Claude Code, run:  /kiln https://example.com"
