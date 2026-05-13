# tmux-scout

A tmux plugin for monitoring and navigating [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) sessions. Provides a real-time fzf picker to jump between agent panes, a status bar widget showing session counts, and crash detection for dead sessions.

[中文文档](README_CN.md)

If you prefer a zero-dependency setup without needing a Node.js runtime, check out this awesome Golang port created by [@ianchesal](https://github.com/ianchesal):

👉 **[tmux-scout-golang](https://github.com/ianchesal/tmux-scout-golang)**

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## Features

- **Session picker** — `prefix + O` opens an fzf popup listing all active agent sessions with status tags (`WAIT` / `BUSY` / `DONE` / `IDLE`), tmux window names, project names, prompt titles, and live tool details
- **Pane preview** — right-side preview panel shows the last 40 lines of each session's tmux pane
- **Status bar widget** — displays session counts by status (e.g. `0|1|2`) in tmux's status-right, refreshed every 2 seconds
- **Auto-refresh** — `Ctrl-T` toggles automatic picker reload every 2 seconds
- **Crash detection** — dead processes and stale Codex JSONL files are automatically detected and cleaned up

## Requirements

- [tmux](https://github.com/tmux/tmux) >= 3.2
- [Node.js](https://nodejs.org/) >= 16
- [fzf](https://github.com/junegunn/fzf) >= 0.51 (with `--listen` and `--tmux` support)

## Installation

### With [TPM](https://github.com/tmux-plugins/tpm)

Add to `~/.tmux.conf`:

```bash
set -g @plugin 'qeesung/tmux-scout'
```

Then press `prefix + I` to install.

### Manual

```bash
git clone https://github.com/qeesung/tmux-scout.git ~/.tmux/plugins/tmux-scout
```

Add to `~/.tmux.conf`:

```bash
run-shell ~/.tmux/plugins/tmux-scout/tmux-scout.tmux
```

Reload tmux: `tmux source ~/.tmux.conf`

## Hook Setup

tmux-scout needs hooks installed in Claude Code and/or Codex to track sessions. Run the setup command after installation:

```bash
# SCOUT_DIR is set automatically when the plugin loads — these commands can be copy-pasted directly
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install

# Other operations
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --claude   # Claude Code only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --codex    # Codex only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # Remove all hooks
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # Check installation status
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" doctor             # Run environment diagnostics
```

The installer is **idempotent** — running it multiple times is safe. If you move the repository, re-running install will automatically update hook paths.

### What gets modified

- **Claude Code**: Adds a hook entry to each of the 9 supported Claude hook event types in `~/.claude/settings.json`
- **Codex**: Adds event hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` in `~/.codex/hooks.json`, enables Codex hook features/trust state in `~/.codex/config.toml`, and keeps the legacy `notify` hook as a fallback for older Codex builds (original notify command is backed up and chained)

## Usage

### Picker

Press `prefix + O` (default) to open the session picker.

| Key | Action |
|---|---|
| `Enter` | Jump to selected session's pane |
| `Ctrl-R` | Refresh session list |
| `Ctrl-T` | Toggle auto-refresh (every 2s) |
| `Esc` | Close picker |

Each line shows:

```
* BUSY   claude app-window            my-project       "implement the login page"  Bash: npm test
```

- `*` — current pane indicator
- `W:APP` / `W:ANS` / `W:PLAN` — waiting for approval, answer, or plan confirmation
- `BUSY` / `DONE` / `IDLE` — session status
- `INT` / `CRASH` / `STALE` — recently interrupted, crashed, or stale sessions
- Agent type (claude / codex)
- tmux window name (`-` when no window is linked)
- Project directory name
- Session title (first prompt)
- Current tool details (for working sessions)

### Status Bar

The status widget is not automatically injected — you need to add it manually. The plugin sets a `SCOUT_DIR` environment variable at load time, so you can use `$SCOUT_DIR` to reference the widget script regardless of install location.

**Without a theme plugin**, add to `~/.tmux.conf`:

```bash
set -g status-right '#($SCOUT_DIR/scripts/status-widget.sh) #S'
set -g status-interval 2
```

**With a theme plugin** (e.g. `minimal-tmux-status`), directly setting `status-right` won't work because the theme overrides it. Use the theme's own option instead:

```bash
# minimal-tmux-status
set -g @minimal-tmux-status-right '#($SCOUT_DIR/scripts/status-widget.sh) #S'
```

The widget shows:

```
W|B|D
```

Where `W` = waiting for attention (red), `B` = busy/working (yellow), `D` = done/completed (green). An optional `I` = idle (blue) appears when idle sessions exist.

## Configuration

### Keybinding

```bash
set -g @scout-key "O"    # default: O (prefix + O)
```

### Status Bar

```bash
set -g @scout-status-format '{W}/{B}/{D}'         # custom separators
set -g @scout-status-format '{W} wait {B} busy'   # with labels
```

Placeholders: `{W}` wait, `{B}` busy, `{D}` done, `{I}` idle.

### Optional Watchdog

By default, tmux-scout stays passive: hooks update state, while the picker/status widget reconcile on refresh. To keep session state current even when the picker/status bar is not refreshing, enable the tmux-managed watchdog:

```bash
set -g @scout-watchdog on
```

This is not a launchd/systemd daemon. It is a single tmux-owned Node.js process that exits when the option is turned off or tmux is gone. The watchdog uses a hybrid loop:

- fast lifecycle/pane checks and incremental Codex JSONL reads every 2s
- Codex JSONL discovery every 30s
- full reconcile every 60s

Optional intervals, in seconds:

```bash
set -g @scout-watchdog-interval 2
set -g @scout-watchdog-discovery-interval 30
set -g @scout-watchdog-full-interval 60
```

Watchdog diagnostics:

```bash
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher status
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher once --full
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher stop
```

`watcher status` includes the latest tick mode, duration, reconcile change count, Codex JSONL files read, parsed event count, and JSONL parse errors when present.

## Data Storage

Session data is stored in `~/.tmux-scout/`:

```
~/.tmux-scout/
├── status.json                      # Aggregated session index
├── sessions/                        # Per-session JSON files
│   ├── {session-id}.json
│   └── ...
├── watcher.pid                      # Optional watchdog process lock
├── watcher-state.json               # Optional watchdog JSONL offsets/cache
├── watcher.log                      # Optional watchdog diagnostics
├── codex-hooks-manifest.json        # Codex event hook trust keys owned by tmux-scout
└── codex-original-notify.json       # Backup of original Codex notify command
```

Sessions older than 24 hours are automatically cleaned up.

## Codex Compatibility Notes

tmux-scout now prefers Codex's event hook mechanism, which gives near-real-time updates for session start, prompt submission, tool activity, approval waits, and turn completion. This is the same style of lifecycle tracking used by Flux Desktop App.

When `@scout-watchdog` is enabled, tmux-scout keeps hooks as the primary state source and adds Flux-style reconciliation: process/pane lifecycle checks, tail-only Codex transcript reads with cached offsets, lower-frequency JSONL discovery, and periodic full reconcile. It does not repeatedly reread every transcript on the fast path.

Internally, hook, pane, transcript, PID, and stale-timeout observations are reduced through a shared session-state model. Higher-confidence hook/PID events win over lower-confidence pane/transcript observations for short races, while terminal crash/stale events still close dead sessions.

For older Codex versions that only support `notify`, tmux-scout still installs and chains the legacy notify hook. In that fallback mode, first-turn discovery may still depend on JSONL polling until Codex emits a completion notification.

## Development

```bash
npm run check   # Syntax-check project JavaScript files
npm test        # Run focused unit tests
npm run ci      # Run both checks
```

## License

MIT
