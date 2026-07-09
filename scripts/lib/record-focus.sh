#!/usr/bin/env bash
# Record a pane access for the picker MRU sort. Invoked by the pane-focus-in
# hook installed by tmux-scout.tmux. Restores PATH (nvm/fnm/brew) from the
# SCOUT_PATH snapshot so node is found inside the tmux server environment.
scout_path=$(tmux show-environment -g SCOUT_PATH 2>/dev/null | sed "s/^SCOUT_PATH=//")
[ -n "$scout_path" ] && export PATH="$scout_path"
dir=$(cd "$(dirname "$0")" && pwd)
exec node "$dir/access-history.js" record "$1"
