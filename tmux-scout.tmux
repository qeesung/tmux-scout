#!/usr/bin/env bash
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key=$(tmux show-option -gqv "@scout-key")
[ -z "$key" ] && key="O"
# Save PATH at load time so run-shell can find node (nvm/fnm/homebrew)
tmux set-environment -g SCOUT_PATH "$PATH"
tmux set-environment -g SCOUT_DIR "$CURRENT_DIR"
restore_path='scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null | sed "s/^SCOUT_PATH=//"); [ -n "$scout_path" ] && export PATH="$scout_path"'
tmux bind-key "$key" run-shell -b "$CURRENT_DIR/scripts/picker/picker.sh"
tmux run-shell -b "$restore_path; node \"$CURRENT_DIR/scripts/setup.js\" status --quiet --any 2>/dev/null || tmux display-message 'tmux-scout: hooks not installed. Run: \"\$(tmux show-env -g SCOUT_DIR | sed s/^SCOUT_DIR=//)/scripts/setup.sh\" install'"

watchdog=$(tmux show-option -gqv "@scout-watchdog")
case "$watchdog" in
  on|1|true|yes|enabled)
    tmux run-shell -b "$restore_path; node \"$CURRENT_DIR/scripts/watcher.js\" start"
    ;;
esac

# Status bar widget — users add #($SCOUT_DIR/scripts/status-widget.sh) to their status-right config
