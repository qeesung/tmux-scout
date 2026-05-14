#!/usr/bin/env bash
# Open a scrollable tmux popup sized to the selected session details.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--page" ]; then
  CONTENT_FILE="${2:-}"
  if [ -n "$CONTENT_FILE" ] && [ -f "$CONTENT_FILE" ] && command -v less >/dev/null 2>&1; then
    LESS= less -R "$CONTENT_FILE"
  elif [ -n "$CONTENT_FILE" ] && [ -f "$CONTENT_FILE" ]; then
    cat "$CONTENT_FILE"
    printf "\nPress any key to close"
    if [ -r /dev/tty ]; then
      read -rsn1 _ < /dev/tty 2>/dev/null || true
    else
      read -rsn1 _ 2>/dev/null || true
    fi
  else
    printf "No session details available.\n"
    read -rsn1 _ 2>/dev/null || true
  fi
  exit 0
fi

STATUS_FILE="${1:-}"
SESSION_ID="${2:-}"
TARGET_PANE="${3:-}"
MIN_WIDTH=72
MAX_WIDTH=120
MIN_HEIGHT=12
MAX_HEIGHT=34

if [ -z "$STATUS_FILE" ] || [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "_" ]; then
  tmux display-message "tmux-scout: no session selected"
  exit 0
fi

CONTENT_FILE=$(mktemp /tmp/tmux-scout-details.XXXXXX)
cleanup_parent=1
cleanup() {
  if [ "$cleanup_parent" = "1" ]; then
    rm -f "$CONTENT_FILE"
  fi
}
trap cleanup EXIT

node "$SCRIPT_DIR/session-details.js" "$STATUS_FILE" "$SESSION_ID" > "$CONTENT_FILE"

client_size=$(tmux display-message -p '#{client_width} #{client_height}' 2>/dev/null || printf "100 30")
client_width=${client_size%% *}
client_height=${client_size##* }

case "$client_width" in
  ''|*[!0-9]*) client_width=100 ;;
esac
case "$client_height" in
  ''|*[!0-9]*) client_height=30 ;;
esac

max_client_width=$((client_width - 4))
max_client_height=$((client_height - 4))
[ "$max_client_width" -lt 1 ] && max_client_width=1
[ "$max_client_height" -lt 1 ] && max_client_height=1
[ "$MAX_WIDTH" -gt "$max_client_width" ] && MAX_WIDTH="$max_client_width"
[ "$MAX_HEIGHT" -gt "$max_client_height" ] && MAX_HEIGHT="$max_client_height"
[ "$MIN_WIDTH" -gt "$MAX_WIDTH" ] && MIN_WIDTH="$MAX_WIDTH"
[ "$MIN_HEIGHT" -gt "$MAX_HEIGHT" ] && MIN_HEIGHT="$MAX_HEIGHT"

content_width=$(awk '{ line = $0; gsub(/\033\[[0-9;]*m/, "", line); if (length(line) > max) max = length(line) } END { print max + 0 }' "$CONTENT_FILE")
content_height=$(wc -l < "$CONTENT_FILE" | tr -d ' ')

width=$((content_width + 4))
height=$((content_height + 3))

[ "$width" -lt "$MIN_WIDTH" ] && width="$MIN_WIDTH"
[ "$width" -gt "$MAX_WIDTH" ] && width="$MAX_WIDTH"
[ "$height" -lt "$MIN_HEIGHT" ] && height="$MIN_HEIGHT"
[ "$height" -gt "$MAX_HEIGHT" ] && height="$MAX_HEIGHT"

PAGER_CMD="bash $(printf '%q' "$SCRIPT_DIR/show-details.sh") --page $(printf '%q' "$CONTENT_FILE"); rm -f $(printf '%q' "$CONTENT_FILE")"
if [ -n "$TARGET_PANE" ]; then
  popup_args=(display-popup -t "$TARGET_PANE" -w "$width" -h "$height" -T " tmux-scout | session " -E "$PAGER_CMD")
else
  popup_args=(display-popup -w "$width" -h "$height" -T " tmux-scout | session " -E "$PAGER_CMD")
fi
if tmux "${popup_args[@]}"; then
  cleanup_parent=0
  exit 0
else
  bash "$SCRIPT_DIR/show-details.sh" --page "$CONTENT_FILE"
fi
