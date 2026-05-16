# tmux-scout

A tmux plugin for monitoring and navigating [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), Gemini CLI, Kimi CLI, GitHub Copilot CLI, OpenCode, Cursor Agent, Hermes, and Coco CLI sessions. Provides a real-time fzf picker to jump between agent panes, a status bar widget showing session counts, and crash detection for dead sessions.

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

tmux-scout needs hooks installed in the agent CLIs you want to track. Run the setup command after installation:

```bash
# SCOUT_DIR is set automatically when the plugin loads — these commands can be copy-pasted directly
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install

# Other operations
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --claude   # Claude Code only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --codex    # Codex only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --gemini   # Gemini CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --kimi     # Kimi CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --copilot-cli  # GitHub Copilot CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --opencode # OpenCode only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --cursor   # Cursor Agent only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --hermes   # Hermes only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --coco     # Coco CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # Remove all hooks
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # Check installation status
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" doctor             # Run environment diagnostics
```

The installer is **idempotent** — running it multiple times is safe. If you move the repository, re-running install will automatically update hook paths.
Without an agent flag, `install`, `uninstall`, and `status` operate on all supported integrations. Use an agent flag to scope the operation.

### What gets modified

- **Claude Code**: Adds a hook entry to each of the 9 supported Claude hook event types in `~/.claude/settings.json`
- **Codex**: Adds event hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` in `~/.codex/hooks.json`, enables Codex hook features/trust state in `~/.codex/config.toml`, and keeps the legacy `notify` hook as a fallback for older Codex builds (original notify command is backed up and chained)
- **Gemini CLI**: Adds command hooks in `~/.gemini/settings.json`
- **Kimi CLI**: Appends managed `[[hooks]]` blocks to `~/.kimi/config.toml` while preserving unrelated TOML content
- **GitHub Copilot CLI**: Adds command hooks in `~/.copilot/settings.json`
- **OpenCode**: Writes `~/.config/opencode/plugins/tmux-scout-opencode-plugin.js` and registers it in the OpenCode JSON config
- **Cursor Agent**: Adds command hooks in `~/.cursor/hooks.json`
- **Hermes**: Adds command hooks in `~/.hermes/cli-config.yaml` or an existing `~/.hermes/config.yaml`
- **Coco CLI**: Adds command hooks in `~/.trae/traecli.yaml` or an existing Coco config file

## Usage

### Picker

Press `prefix + O` (default) to open the session picker.

| Key | Action |
|---|---|
| `Enter` | Jump to selected session's pane |
| `Ctrl-D` | Show selected session details |
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
- Agent type (claude / codex / gemini / kimi / copilot-cli / opencode / cursor / hermes / coco)
- tmux window name (`-` when no window is linked)
- Project directory name
- Session title (first prompt)
- Current tool details (for working sessions)

### Agent Colors

Agent labels in the picker and session details use terminal colors chosen from each product's brand palette. The `xterm` value is the 256-color foreground code used in tmux/fzf.
Run `npm run agent-colors` to preview the colors in your terminal.

| Agent | Brand color | xterm |
|---|---:|---:|
| claude | `#d97757` | `38;5;173` |
| codex | `#10a37f` | `38;5;36` |
| opencode | `#fab283` | `38;5;216` |
| gemini | `#4285f4` | `38;5;69` |
| copilot | `#8534f3` | `38;5;99` |
| cursor | `#edecec` | `38;5;255` |
| kimi | `#0d0f14` | `38;5;246` |
| hermes | `#e5c07b` | `38;5;180` |
| coco | `#32f08c` | `38;5;84` |

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

When tmux mouse mode is enabled, clicking the tmux-scout status segment opens the same picker as `prefix + O`:

```bash
set -g mouse on
```

tmux-scout does not enable mouse mode for you. The clickable segment is subtly underlined by default. In the picker, single-click selects a row and double-click jumps to it.

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

Placeholders: `{W}` wait, `{B}` busy, `{D}` done, `{I}` idle, `{A}` approval waits, `{Q}` question/answer waits, `{P}` plan waits, `{T}` total active sessions.

Status click behavior:

```bash
set -g @scout-status-click on      # default: clickable status segment
set -g @scout-status-click off     # plain text status segment
set -g @scout-status-click force   # override an existing MouseDown1Status binding
```

With the default `on`, tmux-scout only installs its click binding when `MouseDown1Status` is unset, still tmux's default, or already owned by tmux-scout.

Optional mouse UI tuning:

```bash
set -g @scout-status-click-style underscore   # default clickable hint
set -g @scout-status-click-style off          # disable the underline hint
```

### Watchdog

By default, tmux-scout starts a tmux-managed watchdog so session state stays current even when the picker/status bar is not refreshing. To disable background reconciliation:

```bash
set -g @scout-watchdog off
```

This is not a launchd/systemd daemon. It is a single tmux-owned Node.js process that exits when the option is turned off or tmux is gone. The watchdog uses a hybrid loop:

- fast lifecycle/pane checks and incremental Codex JSONL reads every 2s
- Codex JSONL discovery every 30s
- full reconcile every 60s

When the watchdog is running, it also starts a local single-writer bridge at `~/.tmux-scout/run/bridge.sock`. Agent hooks prefer sending updates to that Unix socket so one process serializes status writes; if the socket is unavailable, hooks fall back to direct atomic file writes.

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

`watcher status` includes the bridge state, latest tick mode, duration, reconcile change count, Codex JSONL files read, parsed event count, and JSONL parse errors when present.

## Data Storage

Session data is stored in `~/.tmux-scout/`:

```
~/.tmux-scout/
├── status.json                      # Aggregated session index
├── sessions/                        # Per-session JSON files
│   ├── {session-id}.json
│   └── ...
├── watcher.pid                      # Watchdog process lock
├── watcher-state.json               # Watchdog JSONL offsets/cache
├── watcher.log                      # Watchdog diagnostics
├── run/bridge.sock                  # Watchdog single-writer Unix socket
├── codex-hooks-manifest.json        # Codex event hook trust keys owned by tmux-scout
└── codex-original-notify.json       # Backup of original Codex notify command
```

Sessions older than 24 hours are automatically cleaned up.

## Agent Compatibility Notes

tmux-scout now prefers Codex's event hook mechanism, which gives near-real-time updates for session start, prompt submission, tool activity, approval waits, and turn completion. This is the same style of lifecycle tracking used by the reference app.

With the default watchdog path, tmux-scout keeps hooks as the primary state source and adds reference-style reconciliation: process/pane lifecycle checks, tail-only Codex transcript reads with cached offsets, lower-frequency JSONL discovery, and periodic full reconcile. It does not repeatedly reread every transcript on the fast path.

Internally, hook, pane, transcript, PID, and stale-timeout observations are reduced through a shared session-state model. Higher-confidence hook/PID events win over lower-confidence pane/transcript observations for short races, while terminal crash/stale events still close dead sessions.

For older Codex versions that only support `notify`, tmux-scout still installs and chains the legacy notify hook. In that fallback mode, first-turn discovery may still depend on JSONL polling until Codex emits a completion notification.

Gemini CLI, Kimi CLI, GitHub Copilot CLI, OpenCode, Cursor Agent, Hermes, and Coco CLI are tracked through a generic hook adapter. It maps their hook/plugin events onto the same session lifecycle model, so support quality depends on the payloads those CLIs expose for prompts, tool calls, approvals, questions, subagents, and completion.

## Development

```bash
npm run check   # Syntax-check project JavaScript files
npm test        # Run focused unit tests
npm run ci      # Run both checks
```

## License

MIT
