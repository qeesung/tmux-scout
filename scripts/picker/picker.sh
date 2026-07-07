#!/usr/bin/env bash
# tmux-scout picker — fzf popup to browse and jump to agent sessions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUS_FILE="$HOME/.tmux-scout/status.json"
AUTO_PID=""
AUTO_FLAG=""
LINES_FILE=""

# Restore PATH saved at plugin load time (includes nvm/fnm paths)
if scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null); then
  export PATH="${scout_path#SCOUT_PATH=}"
fi

# --generate: called by fzf ctrl-r reload
if [ "${1:-}" = "--generate" ]; then
  node "$SCRIPT_DIR/index.js" "$STATUS_FILE" "${2:-}"
  exit 0
fi

cleanup() {
  if [ -n "$AUTO_PID" ]; then
    kill "$AUTO_PID" 2>/dev/null || true
    wait "$AUTO_PID" 2>/dev/null || true
  fi
  [ -n "$LINES_FILE" ] && rm -f "$LINES_FILE"
  [ -n "$AUTO_FLAG" ] && rm -f "$AUTO_FLAG"
}
trap cleanup EXIT INT TERM HUP

if [ ! -f "$STATUS_FILE" ]; then
  tmux display-message "No tmux-scout sessions found. Start an agent instance first."
  exit 0
fi

CURRENT_PANE=$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)
RELOAD_CMD="bash $(printf '%q' "$0") --generate $(printf '%q' "$CURRENT_PANE")"
AUTO_FLAG="/tmp/tmux-scout-auto-$$"
LISTEN_PORT=$((10000 + RANDOM % 50000))

# Auto-refresh on by default
touch "$AUTO_FLAG"

# Cache lines and compute popup height
LINES_FILE=$(mktemp /tmp/tmux-scout-lines.XXXXXX)
node "$SCRIPT_DIR/index.js" "$STATUS_FILE" "$CURRENT_PANE" > "$LINES_FILE"
lines=$(wc -l < "$LINES_FILE" | tr -d ' ')
# items + header-line + separator + prompt + border(2) + padding
height=$((lines + 6))
[ "$height" -lt 12 ] && height=12
[ "$height" -gt 30 ] && height=30

# Background auto-refresh daemon: polls flag every 2s, sends reload via fzf --listen
(
  trap 'exit 0' TERM
  while true; do
    sleep 2 &
    wait $! || exit 0
    [ -f "$AUTO_FLAG" ] || continue
    T=$(date +%H:%M:%S)
    curl -sS -XPOST "localhost:$LISTEN_PORT" -d "reload($RELOAD_CMD)+change-border-label( tmux-scout · auto-refresh $T )" 2>/dev/null || break
  done
) &
AUTO_PID=$!

fzf_output=$(cat "$LINES_FILE" | fzf \
  --listen=$LISTEN_PORT \
  --tmux "center,85%,$height,border-native" \
  --ansi \
  --expect='ctrl-d' \
  --prompt='> ' \
  --color='border:bright-cyan,label:bright-white' \
  --delimiter='\t' \
  --with-nth=2 \
  --header-lines=1 \
  --bind="double-click:accept" \
  --bind="ctrl-r:reload($RELOAD_CMD)" \
  --bind="ctrl-t:execute-silent(if [ -f $AUTO_FLAG ]; then rm -f $AUTO_FLAG; else touch $AUTO_FLAG; fi)+reload($RELOAD_CMD)+transform:if [ -f $AUTO_FLAG ]; then printf \"change-border-label( tmux-scout · auto-refresh \$(date +%H:%M:%S) )\"; else printf 'change-border-label( tmux-scout )'; fi" \
  --preview='tmux capture-pane -pJ -t {1} 2>/dev/null | tail -40' \
  --preview-window=right:50%:wrap:border-left \
  --preview-label=" pane preview " \
  --layout=reverse-list \
  --border=rounded \
  --border-label=" tmux-scout · auto-refresh " \
  --border-label-pos=3 \
  --highlight-line \
  --info=inline-right \
  --separator="─" \
  --pointer="▶" \
  --no-sort \
  --cycle \
  || true)

[ -z "$fzf_output" ] && exit 0

action="jump"
selected="$fzf_output"
first_line="${fzf_output%%$'\n'*}"
if [ "$first_line" = "ctrl-d" ]; then
  action="details"
  if [ "$fzf_output" = "ctrl-d" ]; then
    selected=""
  else
    selected="${fzf_output#*$'\n'}"
  fi
elif [ -z "$first_line" ] && [ "$fzf_output" != "${fzf_output#*$'\n'}" ]; then
  # fzf --expect prints an empty key line when the default Enter action is used.
  selected="${fzf_output#*$'\n'}"
fi
[ -z "$selected" ] && exit 0

if [ "$action" = "details" ]; then
  session_id=$(printf '%s\n' "$selected" | cut -f3)
  bash "$SCRIPT_DIR/show-details.sh" "$STATUS_FILE" "$session_id" "$CURRENT_PANE"
  cleanup
  exec "$0"
fi

pane_id=$(printf '%s\n' "$selected" | cut -f1)

if [ "$pane_id" = "UNBOUND" ]; then
  tmux display-popup -w 64 -h 16 -T " tmux-scout " -E bash -c '
printf "\n"
printf "   Cannot jump to this session\n"
printf "\n"
printf "   This session is not linked to a live tmux pane.\n"
printf "\n"
printf "   It may have been discovered from transcript files,\n"
printf "   recently ended, or exited before tmux-scout could\n"
printf "   bind it to a pane.\n"
printf "\n"
printf "   \033[1mOpen the agent pane directly if it still exists,\n"
printf "   or start a new agent session.\033[0m\n"
printf "\n"
printf "   \033[2mPress any key to close\033[0m\n"
read -rsn1
'
  exit 0
fi

# Jump to the pane
target=$(tmux display-message -p -t "$pane_id" '#{session_name}:#{window_index}' 2>/dev/null || true)
if [ -z "$target" ]; then
  tmux display-message "tmux-scout: pane $pane_id is no longer available" 2>/dev/null || true
  exit 0
fi

if ! tmux switch-client -t "$target" 2>/dev/null; then
  if ! tmux select-window -t "$target" 2>/dev/null; then
    tmux display-message "tmux-scout: cannot switch to $target" 2>/dev/null || true
    exit 0
  fi
fi

if ! tmux select-pane -t "$pane_id" 2>/dev/null; then
  tmux display-message "tmux-scout: cannot select pane $pane_id" 2>/dev/null || true
fi

# Record this jump so the picker can sort by access order (most recent first)
node "$SCRIPT_DIR/../lib/access-history.js" record "$pane_id" >/dev/null 2>&1 || true
