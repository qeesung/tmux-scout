# tmux-scout

![tmux-scout feature overview](https://github.com/user-attachments/assets/d08bc43d-9fbe-40fa-a391-ec9654f9f0d3)

A tmux plugin for monitoring and navigating [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), Gemini CLI, Kimi CLI, GitHub Copilot CLI, OpenCode, Cursor Agent, Hermes, Trae CLI, and Traex CLI sessions. Provides a real-time fzf picker to jump between agent panes, a status bar widget showing session counts, and crash detection for dead sessions.

[中文文档](README_CN.md)

If you prefer a zero-dependency setup without needing a Node.js runtime, check out this awesome Golang port created by [@ianchesal](https://github.com/ianchesal):

👉 **[tmux-scout-golang](https://github.com/ianchesal/tmux-scout-golang)**

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## Features

- **Session picker** — `prefix + O` opens an fzf popup listing all active agent sessions with status tags (`WAIT` / `BUSY` / `DONE` / `IDLE`), tmux session and window names, project names, and live tool details in [columns you choose](#picker-columns), ordered by most recently visited
- **Pane preview** — right-side preview panel shows the last 40 lines of each session's tmux pane
- **Status bar widget** — displays session counts by status (e.g. `0|1|2`) in tmux's status-right, refreshed every 2 seconds
- **Auto-refresh** — `Ctrl-T` toggles automatic picker reload every 2 seconds
- **Crash detection** — dead processes and stale Codex JSONL files are automatically detected and cleaned up
- **Screen-reading mode (optional)** — instead of relying on hook events, read each agent's pane and derive its state from what is on screen right now, so a missed event can no longer leave a session stuck ([details](#pane-state-from-the-screen-optional-off-by-default))

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
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --trae     # Trae CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --traex    # Traex CLI only
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # Remove all hooks
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # Check installation status
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" doctor             # Run environment diagnostics
```

The installer is **idempotent** — running it multiple times is safe. If you move the repository, re-running install will automatically update hook paths.
Without an agent flag, `install`, `uninstall`, and `status` operate on all supported integrations. Use an agent flag to scope the operation.

In [screen-reading mode](#pane-state-from-the-screen-optional-off-by-default), `install` skips the agents whose state comes from the screen; they need no hooks.

### What gets modified

- **Claude Code**: Adds a hook entry to each of the 9 supported Claude hook event types in `~/.claude/settings.json`
- **Codex**: Adds event hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` in `~/.codex/hooks.json`, enables Codex hook features/trust state in `~/.codex/config.toml`, and keeps the legacy `notify` hook as a fallback for older Codex builds (original notify command is backed up and chained)
- **Gemini CLI**: Adds command hooks in `~/.gemini/settings.json`
- **Kimi CLI**: Appends managed `[[hooks]]` blocks to `~/.kimi/config.toml` while preserving unrelated TOML content
- **GitHub Copilot CLI**: Adds command hooks in `~/.copilot/settings.json`
- **OpenCode**: Writes `~/.config/opencode/plugins/tmux-scout-opencode-plugin.js` and registers it in the OpenCode JSON config
- **Cursor Agent**: Adds command hooks in `~/.cursor/hooks.json`
- **Hermes**: Adds command hooks in `~/.hermes/config.yaml` and removes obsolete tmux-scout entries from `~/.hermes/cli-config.yaml`
- **Trae CLI**: Adds command hooks in `~/.trae/traecli.yaml` or an existing legacy config file
- **Traex CLI**: Adds managed TOML hook blocks and enables `[features].hooks = true` in `~/.trae/traecli.toml`

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

Each line shows, by default:

```
* BUSY   claude work    app-window my-project Bash: npm test
```

- `*` — current pane indicator
- `W:APP` / `W:ANS` / `W:PLAN` — waiting for approval, answer, or plan confirmation
- `BUSY` / `DONE` / `IDLE` — session status
- `INT` / `CRASH` / `STALE` — recently interrupted, crashed, or stale sessions
- Agent type (claude / codex / gemini / kimi / copilot-cli / opencode / cursor / hermes / trae / traex)
- tmux session name
- tmux window name (`-` when no window is linked)
- Project directory name
- Detail: what the session is waiting on, why it ended, its subagents, or the tool it is running

The columns can be changed: see [Picker columns](#picker-columns).

Sessions are ordered by access recency: the session you most recently switched
to — via the picker, prefix keys, mouse, or window/session switches — floats to
the top, then the next, and so on. Sessions you haven't visited yet fall below,
ordered by most recent activity. The status tags above still render on every row.

### Supported Agents and Colors

tmux-scout currently supports the agent CLIs below. The color sample is the actual foreground color used for the agent label in tmux/fzf, shown with the standard 256-color terminal palette. Your terminal theme may render the final color slightly differently.
Run `npm run agent-colors` to preview the same colors in your terminal.

| Agent | Picker label | Setup flag | User-visible color |
|---|---|---|---|
| Claude Code | `claude` | `--claude` | ![#d7875f](docs/agent-colors/claude.svg) warm orange (`#d7875f`) |
| Codex | `codex` | `--codex` | ![#00af87](docs/agent-colors/codex.svg) green (`#00af87`) |
| OpenCode | `opencode` | `--opencode` | ![#ffaf87](docs/agent-colors/opencode.svg) peach (`#ffaf87`) |
| Gemini CLI | `gemini` | `--gemini` | ![#5f87ff](docs/agent-colors/gemini.svg) blue (`#5f87ff`) |
| GitHub Copilot CLI | `copilot` | `--copilot-cli` | ![#875fff](docs/agent-colors/copilot.svg) purple (`#875fff`) |
| Cursor Agent | `cursor` | `--cursor` | ![#eeeeee](docs/agent-colors/cursor.svg) near-white (`#eeeeee`) |
| Kimi CLI | `kimi` | `--kimi` | ![#949494](docs/agent-colors/kimi.svg) gray (`#949494`) |
| Hermes | `hermes` | `--hermes` | ![#d7af87](docs/agent-colors/hermes.svg) sand (`#d7af87`) |
| Trae CLI | `trae` | `--trae` | ![#5fff87](docs/agent-colors/trae.svg) bright green (`#5fff87`) |
| Traex CLI | `traex` | `--traex` | ![#00ff87](docs/agent-colors/traex.svg) mint (`#00ff87`) |

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

### Picker columns

```bash
set -g @scout-picker-columns 'status,agent,session,window,project,detail'      # default
set -g @scout-picker-columns 'status,agent,session:10,window:24,title,detail'  # name:width sets a width
```

| Column | Up to | Shows |
|---|---|---|
| `status` | 6 | `BUSY` / `DONE` / `W:APP` and the other status tags |
| `agent` | 9 | Agent type |
| `session` | 40 | tmux session name |
| `window` | 60 | tmux window name |
| `project` | 16 | Project directory name |
| `title` | 50 | Session title (first prompt) |
| `detail` | 55 | What the session is waiting on, why it ended, its subagents, or the tool it is running |
| `source` | 40 | Where the latest state came from and how long ago, e.g. `pane-model · 41s · pane_idle_ready` |

Columns appear in the order given. Each is as wide as the widest thing it shows, up to the width above; `name:width` sets a column's width exactly. Text wider than its column is cut with `~`, and the last column is not padded.

When a row is wider than the picker's list, columns give up width in this order: `detail`, `source`, `title`, `project`, `session`, and `window` last, so window names stay whole for as long as anything can. `status` and `agent` are never shrunk, and neither is a column given an explicit width.

Unknown names are ignored, and a value with no known name falls back to the default. The option is read on every refresh, so a change shows up the next time the picker redraws.

### Status Bar

```bash
set -g @scout-status-format '{W}/{B}/{D}'         # custom separators
set -g @scout-status-format '{W} wait {B} busy'   # with labels
```

Placeholders: `{W}` wait, `{B}` busy, `{D}` done, `{I}` idle, `{A}` approval waits, `{Q}` question/answer waits, `{P}` plan waits, `{T}` total active sessions, `{J}` a warning while screen reading is failing (see [Pane state from the screen](#pane-state-from-the-screen-optional-off-by-default)). A format without `{J}` still gets the warning, in front.

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
- in [screen-reading mode](#pane-state-from-the-screen-optional-off-by-default), agent panes re-read every second between those checks (an unchanged screen costs a string comparison)
- Codex JSONL discovery every 30s
- full reconcile every 60s

The on/off switch and `@scout-watchdog-interval` are re-read every 15s rather than every tick, so turning the watchdog off can take up to 15s to stop it.

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

### Pane state from the screen (optional, off by default)

**Why.** Hooks are edge-triggered: tmux-scout learns a session's state only when the agent CLI announces a change. A missed or missing event — Codex has no `SessionEnd` or `Notification`, and an approval dialog can still be on screen when `Stop` fires — leaves the session wrong until the next one arrives, which is why the hook path carries timeout fallbacks that guess. This mode is level-triggered instead: it reads each agent's pane, and the state becomes a function of what is on the screen right now. A reading that goes wrong is corrected by the next one.

**How it works.**

1. About once a second, the watchdog reads the tail of every agent pane in a single tmux call.
2. It strips what changes on every frame without meaning anything — spinners, elapsed timers, token counts, Codex's background particles — so the same state always produces the same text. A screen whose text has not changed is skipped.
3. A screen seen before reuses its earlier answer. A new one goes to [TypeSafe Jev](https://typesafe.ai), a model that answers structured questions rather than generating text, together with a short description of what that CLI's screen looks like. It is asked: is the agent working, finished, waiting for an approval or asking a question; is it blocked on the person; is anything running; was the turn cancelled.
4. An answer that passes the checks below is translated into the same events the hooks send (`permission_request`, `question_asked`, `turn_complete`, …) and goes through the same session state machine, so the picker and the status bar behave exactly as they do with hooks.

**What keeps it trustworthy.**

- **One writer per agent.** Agents read from the screen get no hooks; every other agent keeps its hooks. Two sources with different latencies never overwrite each other.
- **Answers have to earn it.** Below a confidence bar (0.55 by default) the model is ignored and the session keeps its state. Independent questions cross-check each other: a "waiting for approval" that "is it blocked on the person" contradicts is thrown out. An unreadable screen — an editor, a pager — decides nothing. A screen whose answer was rejected is asked again at most twice.
- **A fixed vocabulary.** The model can only choose among the existing states, and its readings pass the same guards as hook events. It cannot assert an arbitrary state.
- **Leaving a wait is harder than entering one.** `WAIT` clears only after two consecutive readings at 0.75 or above (with the default confidence bar), or about ten seconds of consistent ones, so a single mid-redraw frame cannot dismiss an approval.
- **Self-correcting.** Each reading is compared with the session's actual state, and only a disagreement changes anything.
- **Stale readings are dropped:** one of a screen older than a reading already applied, or of a pane whose process has since been replaced. A new session in a reused pane does not inherit the previous process's prompt.
- **Facts outrank the model.** Process and pane liveness are probed directly and take priority: a session whose process exited is closed, and text left on its screen cannot revive it. A plain shell prompt is left to the liveness probe. The timeout fallbacks stay in place for when readings stop — no key, rate limited — and stand down while the model is actively confirming a session, so a long command on a frozen screen is not completed by mistake.
- **Traceable.** Every change records its source and reason: `node scripts/debug.js evidence <session-id>`.
- **Measured before it ships.** Every change to what the model is told is scored against labelled real screens; a confidently wrong answer is a failure, not a trade-off.

**Speed and cost**, measured on a machine with about 25 agent panes:

| | |
|---|---|
| Turn finished → `DONE` | 1.5–4.5 s |
| Work starts → `BUSY` | under 1 s |
| Watchdog CPU | about 2% of one core |
| One model call | about $0.0001 (input tokens only; output is free) |
| Screens answered from cache | 97–98% |
| Spend | a few cents per hour while agents work; an idle session costs about one call a day |

**Turning it on.**

1. Start with `shadow`: it reads screens and records what the model concluded, without touching any session. After a day or so, compare what it saw against what the hooks decided:

   ```bash
   set -g @scout-pane-model shadow   # off (default) | shadow
   node scripts/debug.js pane-agreement --since 24h
   ```

2. Meet the requirements, all checked by `scripts/setup.sh doctor`:
   - **Node 20+** and `npm install` in the plugin directory. TPM installs do not run `npm install`, so the SDK is an optional dependency: without it the feature stays off and everything else works unchanged, and on an older Node `npm install` skips it rather than failing.
   - **An API key.** The watchdog is started by `tmux run-shell` and inherits the environment the tmux *server* started with, not your shell's — exporting it in `.zshrc` is not enough. Use either:

     ```bash
     tmux set-environment -g TYPESAFE_API_KEY sk-...
     # or
     install -m 600 /dev/null ~/.tmux-scout/typesafe.key && $EDITOR ~/.tmux-scout/typesafe.key
     ```

     To rotate the key, run the same `set-environment` with the new one. A running watchdog picks it up within about 15 seconds of the old key being refused; no restart is needed.

3. Switch over, and remove the hooks those agents already have:

   ```bash
   set -g @scout-state-source jev    # hook (default) | jev
   scripts/setup.sh uninstall --claude --codex --gemini
   ```

   The switch is **either/or per agent**, not a blend: the agents in `@scout-pane-model-agents` are read from the screen, every other agent keeps its hooks. `setup.sh install` skips hooks for the screen-read agents, and `doctor` warns if it finds some anyway. Settings changes reach a running watchdog within 15 seconds; no restart is needed.

**Options.**

```bash
set -g @scout-pane-model-agents claude,codex,gemini # which CLIs to read from the screen
set -g @scout-pane-model-confidence 0.55            # below this the model is ignored
set -g @scout-pane-model-interval 6                 # seconds between paid calls per session while its screen
                                                    # keeps changing; backs off to 30s on a repeated verdict
set -g @scout-pane-model-lines 40                   # how much of the pane tail to send
```

The interval applies only to a screen that keeps changing. One that has just stopped changing, or whose bottom changed (a dialog appeared), is read as soon as 2 seconds have passed since that session's last call: that is when a turn has finished or needs you.

**Watching it.**

```bash
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher status
```

That prints a `pane-model` line — calls, cache hits and hit rate, re-asked screens, readings applied — and a `jev` line with p50/p95/max latency, input tokens, spend so far and a per-hour rate. A hit rate that stays low while everything is idle means animation is leaking through normalization and being paid for.

For history across watchdog restarts, turn on per-call logging and read it back; to see what the model makes of one pane right now, classify it directly:

```bash
tmux set -g @scout-jev-log-calls on
node scripts/debug.js jev-metrics --since 24h
node scripts/debug.js classify %39 --state
```

**When it stops working.** With the screen as the state source, a pane model that gets no answers leaves every session showing whatever it last showed. So the status bar leads with a red `⚠ jev <code>` and the picker's header row says what is wrong, for as long as it lasts:

| Code | Meaning |
|---|---|
| `451` | the API refuses this network (not available in your region) |
| `401` | the API key was rejected |
| `429` | the API is rate limiting |
| `offline` / `timeout` | the API cannot be reached, or does not answer in time |
| `503` and other statuses | the API answers with that HTTP error |
| `no key` / `no sdk` / `node` | the client cannot be built: see the prerequisites above |
| `down` / `stopped` | the watchdog is not running, so nothing reads the screens |

A request failing is not enough: it takes three in a row with no success between them, and one success clears it. A refusal of one particular screen does not count. Only `@scout-state-source jev` is reported; in `shadow` the hooks still drive state. `watcher status` shows the same as `failing(<code>)`.

**Limits.**

- The screen does not show everything a hook payload carries: exact tool arguments, turn and request ids, and the transcript path are given up for the agents read from it. `shadow` exists to measure that trade before you take it.
- The description of each CLI's screen is written only from real screens. Claude Code and Codex are fully described; Traex's running turn and Gemini CLI's running and finished turns are not yet, so the model falls back on generic criteria for those.

### Pane access tracking

The picker orders sessions by how recently you looked at them. By default tmux-scout records every pane you focus — via the picker, prefix keys, mouse, or window/session switches — using a `pane-focus-in` hook, so the ordering reflects real recency rather than only picker jumps. To disable:

```bash
set -g @scout-track-focus off
```

The hook is installed at a fixed slot (`pane-focus-in[9909]`), so it stays idempotent across config reloads and coexists with your own `pane-focus-in` hook. History is stored (capped) in `~/.tmux-scout/access-history.json`.

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
├── codex-original-notify.json       # Backup of original Codex notify command
├── access-history.json              # Pane access history for the picker MRU sort
├── typesafe.key                     # Screen-reading mode: API key, if kept in a file
├── pane-cache.json                  # Screen-reading mode: answers per screen, kept 24h
├── pane-observed.json               # Screen-reading mode: when each session was last confirmed
├── pane-agreement.jsonl             # Shadow mode: model vs. hooks, for pane-agreement
└── pane-metrics.jsonl               # Per-call latency and cost, when @scout-jev-log-calls is on
```

tmux-scout keeps live and recently visible sessions in the registry. Hidden
internal sessions and terminal `STALE` / `CRASH` rows are removed after their
short display window, while snapshots with an explicit `endedAt` are retained
for up to 24 hours before cleanup.

## Agent Compatibility Notes

tmux-scout now prefers Codex's event hook mechanism, which gives near-real-time updates for session start, prompt submission, tool activity, approval waits, and turn completion. This is a hook-driven style of lifecycle tracking rather than polling.

With the default watchdog path, tmux-scout keeps hooks as the primary state source and adds a reconciliation pass: process/pane lifecycle checks, tail-only Codex transcript reads with cached offsets, registry pruning, and periodic full reconcile. It does not repeatedly reread every transcript on the fast path.

With `@scout-state-source jev`, the agents read from the screen have no hooks at all: their state comes from the screen, with process and pane liveness and the timeout fallbacks underneath it. See [Pane state from the screen](#pane-state-from-the-screen-optional-off-by-default).

Internally, hook, pane, transcript, PID, and stale-timeout observations are reduced through a shared session-state model. Higher-confidence hook/PID events win over lower-confidence pane/transcript observations for short races, while terminal crash/stale events still close dead sessions.

For older Codex versions that only support `notify`, tmux-scout still installs and chains the legacy notify hook. In that fallback mode, first-turn discovery may still depend on JSONL polling until Codex emits a completion notification.

Gemini CLI, Kimi CLI, GitHub Copilot CLI, OpenCode, Cursor Agent, Hermes, Trae CLI, and Traex CLI are tracked through a generic hook adapter. It maps their hook/plugin events onto the same session lifecycle model, so support quality depends on the payloads those CLIs expose for prompts, tool calls, approvals, questions, subagents, and completion.

## Development

Project internals:

- [Agent Integration Guide](docs/agent-integration.md) explains how to add or maintain an agent integration.
- [Session State Contract](docs/session-contract.md) documents the persisted session/event contract.

```bash
npm run check   # Syntax-check project JavaScript files
npm test        # Run focused unit tests
npm run ci      # Run both checks
```

### Flow Fixtures and Debugging

Agent lifecycle regressions can be captured as JSON flow fixtures under `tests/fixtures/flow/<agent>/`.
Each fixture replays real hook entrypoints into an isolated `HOME` and asserts the final session snapshot,
state contract, and expected evidence stream.

Useful debug commands:

```bash
node scripts/debug.js list
node scripts/debug.js show <session-id> --plain
node scripts/debug.js evidence <session-id>
node scripts/debug.js inject --session-id debug-wait --agent codex --phase waitingForApproval
node scripts/debug.js replay tests/fixtures/flow/claude/approval.json --show
```

The same commands are available through `scripts/setup.sh debug ...` when you want tmux-scout to restore
the PATH captured from tmux.

## License

MIT
