#!/usr/bin/env bash
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
key=$(tmux show-option -gqv "@scout-key")
[ -z "$key" ] && key="O"
# Save PATH at load time so run-shell can find node (nvm/fnm/homebrew)
tmux set-environment -g SCOUT_PATH "$PATH"
tmux set-environment -g SCOUT_DIR "$CURRENT_DIR"
restore_path='scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null | sed "s/^SCOUT_PATH=//"); [ -n "$scout_path" ] && export PATH="$scout_path"'
tmux bind-key "$key" run-shell -b "$CURRENT_DIR/scripts/picker/picker.sh"

status_click=$(tmux show-option -gqv "@scout-status-click")
[ -z "$status_click" ] && status_click="on"
status_click=$(printf '%s' "$status_click" | tr '[:upper:]' '[:lower:]')
status_click_binding=$(tmux list-keys -T root MouseDown1Status 2>/dev/null || true)
status_click_picker_cmd="run-shell -b \"$CURRENT_DIR/scripts/picker/picker.sh\""
status_click_cmd="if-shell -F '#{==:#{mouse_status_range},scout}' '$status_click_picker_cmd' 'switch-client -t ='"
case "$status_click" in
  off|0|false|no|disabled)
    if printf '%s\n' "$status_click_binding" | grep -E "$CURRENT_DIR/scripts/picker/(picker|toggle)\\.sh" >/dev/null 2>&1; then
      tmux bind-key -T root MouseDown1Status switch-client -t =
    fi
    ;;
  force)
    tmux bind-key -T root MouseDown1Status "$status_click_cmd"
    ;;
  *)
    if [ -z "$status_click_binding" ] \
      || printf '%s\n' "$status_click_binding" | grep -Eq 'MouseDown1Status[[:space:]]+switch-client -t =[[:space:]]*$' \
      || printf '%s\n' "$status_click_binding" | grep -E "$CURRENT_DIR/scripts/picker/(picker|toggle)\\.sh" >/dev/null 2>&1; then
      tmux bind-key -T root MouseDown1Status "$status_click_cmd"
    fi
    ;;
esac

tmux run-shell -b "$restore_path; node \"$CURRENT_DIR/scripts/setup.js\" status --quiet --any 2>/dev/null || tmux display-message 'tmux-scout: hooks not installed. Run: \"\$(tmux show-env -g SCOUT_DIR | sed s/^SCOUT_DIR=//)/scripts/setup.sh\" install'"

watchdog=$(tmux show-option -gqv "@scout-watchdog")
case "$watchdog" in
  off|0|false|no|disabled)
    ;;
  *)
    tmux run-shell -b "$restore_path; node \"$CURRENT_DIR/scripts/watcher.js\" start"
    ;;
esac

# Status bar widget — users add #($SCOUT_DIR/scripts/status-widget.sh) to their status-right config
