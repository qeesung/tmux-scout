#!/usr/bin/env bash
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key=$(tmux show-option -gqv "@scout-key")
[ -z "$key" ] && key="O"
# Save PATH at load time so run-shell can find node (nvm/fnm/homebrew)
tmux set-environment -g SCOUT_PATH "$PATH"
tmux set-environment -g SCOUT_DIR "$CURRENT_DIR"
tmux bind-key "$key" run-shell -b "$CURRENT_DIR/scripts/picker/picker.sh"
tmux run-shell -b "eval \$(tmux show-environment -g SCOUT_PATH 2>/dev/null) && export PATH=\"\$SCOUT_PATH\" && node $CURRENT_DIR/scripts/setup.js status --quiet 2>/dev/null || tmux display-message 'tmux-scout: hooks not installed. Run: eval \"\$(tmux show-env -g SCOUT_DIR)\" && \"\$SCOUT_DIR/scripts/setup.sh\" install'"

# Status bar widget — users add #($SCOUT_DIR/scripts/status-widget.sh) to their status-right config
