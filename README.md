# tmux-scout

A tmux plugin for monitoring and navigating [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) sessions. Provides a real-time fzf picker to jump between agent panes, a status bar widget showing session counts, and crash detection for dead sessions.

[中文文档](README_CN.md)

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## Features

- **Session picker** — `prefix + O` opens an fzf popup listing all active agent sessions with status tags (`WAIT` / `BUSY` / `DONE` / `IDLE`), project names, prompt titles, and live tool details
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
```

The installer is **idempotent** — running it multiple times is safe. If you move the repository, re-running install will automatically update hook paths.

### What gets modified

- **Claude Code**: Adds a hook entry to each of the 6 event types in `~/.claude/settings.json`
- **Codex**: Sets the `notify` field in `~/.codex/config.toml` (original notify command is backed up and chained)

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
* [ BUSY ] claude  my-project                "implement the login page"  Bash: npm test
```

- `*` — current pane indicator
- `[ WAIT ]` / `[ BUSY ]` / `[ DONE ]` / `[ IDLE ]` — session status
- Agent type (claude / codex)
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

## Data Storage

Session data is stored in `~/.tmux-scout/`:

```
~/.tmux-scout/
├── status.json                      # Aggregated session index
├── sessions/                        # Per-session JSON files
│   ├── {session-id}.json
│   └── ...
└── codex-original-notify.json       # Backup of original Codex notify command
```

Sessions older than 24 hours are automatically cleaned up.

## Known Issues

Codex has an extremely poor hook mechanism — it only provides a single `notify` hook that fires after each agent turn completes (`agent-turn-complete`). No session start, no session end, no tool use events, nothing. This causes two issues:

- **Unable to jump to new sessions** — Before Codex completes its first response, tmux-scout has no way to know which pane the session is running in. These sessions appear as "unbound" in the picker and cannot be jumped to until the first turn finishes.
- **Inconsistent session info** — Critical events like session start, prompt submission, tool use, and session end are completely missing from Codex's hook. This means session status can be outright wrong — a session may show as "completed" while Codex is actively processing, or show as "working" long after it has finished.

These are fundamental limitations of Codex's hook design, not bugs in tmux-scout. We have implemented several workarounds to compensate: JSONL log file polling for early session discovery, crash detection via process liveness checks, file staleness detection for dead sessions, and pending tool call tracking from JSONL parsing. But don't worry — tmux-scout will eventually converge to the correct state.

## License

MIT
