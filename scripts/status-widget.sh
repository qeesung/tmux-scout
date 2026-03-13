#!/usr/bin/env bash
# Short wrapper for use in tmux status-right:
#   set -g status-right '#(/path/to/tmux-scout/scripts/status-widget.sh)'
eval $(tmux show-environment -g SCOUT_PATH 2>/dev/null)
export PATH="$SCOUT_PATH"
SCOUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$SCOUT_DIR/scripts/status-bar.js"
