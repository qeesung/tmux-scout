#!/usr/bin/env bash
# tmux-scout hook setup wrapper — restores PATH for nvm/fnm support
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null); then
  export PATH="${scout_path#SCOUT_PATH=}"
fi
node "$SCRIPT_DIR/setup.js" "$@"
