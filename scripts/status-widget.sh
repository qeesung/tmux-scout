#!/usr/bin/env bash
# Short wrapper for use in tmux status-right:
#   set -g status-right '#(/path/to/tmux-scout/scripts/status-widget.sh)'
if scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null); then
  export PATH="${scout_path#SCOUT_PATH=}"
fi
SCOUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCOUT_DIR/scripts/status-bar.js"
