# tmux-scout

![tmux-scout 功能总览](https://github.com/user-attachments/assets/4305c4ed-bc1e-4f36-848d-3ebb76cc4dd4)

一个用于监控和导航 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、Gemini CLI、Kimi CLI、GitHub Copilot CLI、OpenCode、Cursor Agent、Hermes、Trae CLI 和 Traex CLI 会话的 tmux 插件。提供实时 fzf 选择器在 agent 面板间快速跳转，状态栏组件显示会话计数，以及自动检测崩溃的会话。

[English](README.md)

如果你更喜欢零依赖的安装方式，不想在系统里额外配置 Node.js 运行环境，推荐试试由 [@ianchesal](https://github.com/ianchesal) 开发的优秀 Go 语言重写版本：

👉 **[tmux-scout-golang](https://github.com/ianchesal/tmux-scout-golang)**

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## 功能特性

- **会话选择器** — `prefix + O` 打开 fzf 弹窗，列出所有活跃的 agent 会话，显示状态标签（`WAIT` / `BUSY` / `DONE` / `IDLE`）、tmux window 名称、项目名、提示标题和实时工具详情，并按最近访问顺序排列
- **面板预览** — 右侧预览面板显示每个会话 tmux 面板的最后 40 行内容
- **状态栏组件** — 在 tmux 的 status-right 中显示按状态分类的会话计数（如 `0|1|2`），每 2 秒刷新
- **自动刷新** — `Ctrl-T` 切换每 2 秒自动刷新选择器
- **崩溃检测** — 自动检测死亡进程和过期的 Codex JSONL 文件并清理
- **读屏模式（可选）** — 不再依赖 hook 事件，而是直接读取每个 agent 的终端画面，按屏幕上此刻显示的内容判断状态；漏掉一个事件不会再让会话卡住（[详情](#从屏幕读取状态可选默认关闭)）

## 依赖

- [tmux](https://github.com/tmux/tmux) >= 3.2
- [Node.js](https://nodejs.org/) >= 16
- [fzf](https://github.com/junegunn/fzf) >= 0.51（需要 `--listen` 和 `--tmux` 支持）

## 安装

### 使用 [TPM](https://github.com/tmux-plugins/tpm)

在 `~/.tmux.conf` 中添加：

```bash
set -g @plugin 'qeesung/tmux-scout'
```

然后按 `prefix + I` 安装。

### 手动安装

```bash
git clone https://github.com/qeesung/tmux-scout.git ~/.tmux/plugins/tmux-scout
```

在 `~/.tmux.conf` 中添加：

```bash
run-shell ~/.tmux/plugins/tmux-scout/tmux-scout.tmux
```

重载 tmux：`tmux source ~/.tmux.conf`

## Hook 配置

tmux-scout 需要在要追踪的 agent CLI 中安装 hook。安装插件后运行配置命令：

```bash
# 插件加载后会设置 SCOUT_DIR 环境变量，以下命令可直接复制执行
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install

# 其他操作
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --claude   # 仅 Claude Code
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --codex    # 仅 Codex
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --gemini   # 仅 Gemini CLI
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --kimi     # 仅 Kimi CLI
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --copilot-cli  # 仅 GitHub Copilot CLI
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --opencode # 仅 OpenCode
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --cursor   # 仅 Cursor Agent
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --hermes   # 仅 Hermes
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --trae     # 仅 Trae CLI
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --traex    # 仅 Traex CLI
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # 卸载所有 hook
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # 查看安装状态
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" doctor             # 运行环境诊断
```

安装命令是**幂等**的 — 重复运行不会重复添加。如果你移动了仓库位置，重新运行 install 会自动更新 hook 路径。
不带 agent 参数时，`install`、`uninstall` 和 `status` 会作用于所有支持的集成；可以通过 agent 参数限定范围。

开启[读屏模式](#从屏幕读取状态可选默认关闭)后，`install` 会跳过状态由读屏负责的 agent，它们不需要 hook。

### 修改了什么

- **Claude Code**：在 `~/.claude/settings.json` 的 9 个 Claude 支持事件类型中各添加一条 hook
- **Codex**：在 `~/.codex/hooks.json` 中添加 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` 事件 hook，并在 `~/.codex/config.toml` 中启用 hooks feature / trust state；同时保留 legacy `notify` 作为旧版 Codex 的兜底（原有 notify 命令会被备份并串联调用）
- **Gemini CLI**：在 `~/.gemini/settings.json` 中添加 command hook
- **Kimi CLI**：在 `~/.kimi/config.toml` 中追加受管理的 `[[hooks]]` block，同时保留无关 TOML 内容
- **GitHub Copilot CLI**：在 `~/.copilot/settings.json` 中添加 command hook
- **OpenCode**：写入 `~/.config/opencode/plugins/tmux-scout-opencode-plugin.js`，并在 OpenCode JSON 配置中注册该插件
- **Cursor Agent**：在 `~/.cursor/hooks.json` 中添加 command hook
- **Hermes**：在 `~/.hermes/config.yaml` 中添加 command hook，并从 `~/.hermes/cli-config.yaml` 清理旧的 tmux-scout 条目
- **Trae CLI**：在 `~/.trae/traecli.yaml` 或已有的旧版配置文件中添加 command hook
- **Traex CLI**：在 `~/.trae/traecli.toml` 中添加受管理的 TOML hook block，并启用 `[features].hooks = true`

## 使用方法

### 选择器

按 `prefix + O`（默认）打开会话选择器。

| 按键 | 操作 |
|---|---|
| `Enter` | 跳转到选中会话的面板 |
| `Ctrl-D` | 查看选中会话详情 |
| `Ctrl-R` | 刷新会话列表 |
| `Ctrl-T` | 切换自动刷新（每 2 秒） |
| `Esc` | 关闭选择器 |

每行显示内容：

```
* BUSY   claude app-window            my-project       "implement the login page"  Bash: npm test
```

- `*` — 当前面板指示器
- `W:APP` / `W:ANS` / `W:PLAN` — 等待审批、回答或计划确认
- `BUSY` / `DONE` / `IDLE` — 会话状态
- `INT` / `CRASH` / `STALE` — 最近被打断、异常退出或过期的会话
- Agent 类型（claude / codex / gemini / kimi / copilot-cli / opencode / cursor / hermes / trae / traex）
- tmux window 名称（未关联 window 时显示 `-`）
- 项目目录名
- 会话标题（首条提示）
- 当前工具详情（工作中的会话）

会话按访问顺序排列：最近一次切换过去的会话置顶（无论是通过 picker、prefix 快捷键、鼠标，还是 window/session 切换），其次是次近的，依此类推；
尚未访问过的会话排在下方，按最近活跃时间排序。每行上方的状态标签仍会照常显示。

### 支持的 Agent 和颜色

tmux-scout 目前支持下表中的 agent CLI。颜色示例是 tmux/fzf 中 agent 标签实际使用的前景色，按标准 256 色终端调色板展示；不同终端主题可能会有轻微差异。
运行 `npm run agent-colors` 可以在当前终端中预览同一组颜色。

| Agent | 选择器显示 | 安装参数 | 用户看到的颜色 |
|---|---|---|---|
| Claude Code | `claude` | `--claude` | ![#d7875f](docs/agent-colors/claude.svg) 暖橙色 (`#d7875f`) |
| Codex | `codex` | `--codex` | ![#00af87](docs/agent-colors/codex.svg) 绿色 (`#00af87`) |
| OpenCode | `opencode` | `--opencode` | ![#ffaf87](docs/agent-colors/opencode.svg) 桃色 (`#ffaf87`) |
| Gemini CLI | `gemini` | `--gemini` | ![#5f87ff](docs/agent-colors/gemini.svg) 蓝色 (`#5f87ff`) |
| GitHub Copilot CLI | `copilot` | `--copilot-cli` | ![#875fff](docs/agent-colors/copilot.svg) 紫色 (`#875fff`) |
| Cursor Agent | `cursor` | `--cursor` | ![#eeeeee](docs/agent-colors/cursor.svg) 近白色 (`#eeeeee`) |
| Kimi CLI | `kimi` | `--kimi` | ![#949494](docs/agent-colors/kimi.svg) 灰色 (`#949494`) |
| Hermes | `hermes` | `--hermes` | ![#d7af87](docs/agent-colors/hermes.svg) 沙色 (`#d7af87`) |
| Trae CLI | `trae` | `--trae` | ![#5fff87](docs/agent-colors/trae.svg) 亮绿色 (`#5fff87`) |
| Traex CLI | `traex` | `--traex` | ![#00ff87](docs/agent-colors/traex.svg) 薄荷色 (`#00ff87`) |

### 状态栏

状态栏组件不会自动注入，需要手动添加。插件加载时会设置 `SCOUT_DIR` 环境变量，可以用 `$SCOUT_DIR` 引用组件脚本，无需关心安装路径。

**不使用主题插件时**，在 `~/.tmux.conf` 中添加：

```bash
set -g status-right '#($SCOUT_DIR/scripts/status-widget.sh) #S'
set -g status-interval 2
```

**使用主题插件时**（如 `minimal-tmux-status`），直接设置 `status-right` 会被主题覆盖，需要使用主题提供的选项：

```bash
# minimal-tmux-status
set -g @minimal-tmux-status-right '#($SCOUT_DIR/scripts/status-widget.sh) #S'
```

显示格式：

```
W|B|D
```

其中 `W` = 等待关注（红色），`B` = 工作中（黄色），`D` = 已完成（绿色）。当存在空闲会话时会额外显示 `I` = 空闲（蓝色）。

启用 tmux 鼠标模式后，点击 tmux-scout 状态栏片段会打开和 `prefix + O` 相同的 picker：

```bash
set -g mouse on
```

tmux-scout 不会主动替你开启鼠标模式。可点击片段默认会有轻量下划线提示。picker 里单击选择行，双击跳转。

## 配置选项

### 快捷键

```bash
set -g @scout-key "O"    # 默认: O (prefix + O)
```

### 状态栏

```bash
set -g @scout-status-format '{W}/{B}/{D}'         # 自定义分隔符
set -g @scout-status-format '{W} wait {B} busy'   # 带标签
```

占位符：`{W}` 等待，`{B}` 工作中，`{D}` 已完成，`{I}` 空闲，`{A}` 审批等待，`{Q}` 问题/回答等待，`{P}` 计划确认等待，`{T}` 活跃会话总数。

状态栏点击行为：

```bash
set -g @scout-status-click on      # 默认：状态栏片段可点击
set -g @scout-status-click off     # 纯文本状态栏片段
set -g @scout-status-click force   # 覆盖已有 MouseDown1Status 绑定
```

默认 `on` 时，只有在 `MouseDown1Status` 未设置、仍是 tmux 默认绑定，或已经由 tmux-scout 管理时，tmux-scout 才会安装点击绑定。

可选鼠标 UI 调整：

```bash
set -g @scout-status-click-style underscore   # 默认：可点击下划线提示
set -g @scout-status-click-style off          # 关闭下划线提示
```

### Watchdog

默认情况下，tmux-scout 会启动由 tmux 管理的 watchdog，即使不打开 picker、不刷新状态栏，也会持续维护会话状态。如需关闭后台校正：

```bash
set -g @scout-watchdog off
```

这不是 launchd/systemd daemon，而是一个由 tmux 拥有的单实例 Node.js 进程；关闭选项或 tmux 不可用时会退出。watchdog 使用混合循环：

- 每 2 秒做进程/pane 生命周期检查和 Codex JSONL 增量读取
- [读屏模式](#从屏幕读取状态可选默认关闭)下，在两次检查之间每秒重新读取一次 agent pane（画面没变时只是一次字符串比较）
- 每 30 秒做 Codex JSONL 发现
- 每 60 秒做一次全量 reconcile

开关和 `@scout-watchdog-interval` 每 15 秒重新读取一次，而不是每轮都读，所以关闭 watchdog 后最多需要 15 秒它才会退出。

watchdog 运行时还会在 `~/.tmux-scout/run/bridge.sock` 启动本地 single-writer bridge。agent hook 会优先把更新发送到这个 Unix socket，由同一个进程串行写状态；如果 socket 不可用，则回退到直接原子写文件。

可选间隔，单位为秒：

```bash
set -g @scout-watchdog-interval 2
set -g @scout-watchdog-discovery-interval 30
set -g @scout-watchdog-full-interval 60
```

watchdog 诊断命令：

```bash
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher status
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher once --full
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher stop
```

`watcher status` 会包含 bridge 状态、最近一次 tick 的模式、耗时、reconcile 变更数、读取的 Codex JSONL 文件数、解析事件数，以及出现时的 JSONL 解析错误数。

### 从屏幕读取状态（可选，默认关闭）

**为什么需要。** hook 是边缘触发的：只有 agent CLI 主动报告变化时，tmux-scout 才知道会话状态变了。一旦某个事件漏掉或者根本没有（Codex 没有 `SessionEnd` 和 `Notification`；`Stop` 触发时审批框可能还在屏幕上），会话就会一直错到下一个事件到来，所以 hook 路径里才需要靠超时去猜的兜底。读屏模式是水平触发的：直接读每个 agent 的 pane，状态就是屏幕上此刻显示的内容。某一次读错了，下一次读屏会纠正回来。

**工作方式。**

1. watchdog 大约每秒一次，用一次 tmux 调用读取所有 agent pane 的底部内容。
2. 去掉每一帧都在变、但不代表状态变化的内容（转圈动画、计时器、token 计数、Codex 背景粒子），保证同一个状态总是得到同一份文字。文字没变的画面直接跳过。
3. 以前见过的画面直接复用上次的答案。新画面连同"这个 CLI 的界面长什么样"的说明，一起发给 [TypeSafe Jev](https://typesafe.ai)：一个回答结构化问题、而不是生成文字的模型。问它：agent 是在工作、已完成、在等审批还是在提问；是否卡在等人操作；是否有东西在运行；这一轮是否被取消。
4. 通过下面各项检查的答案，被翻译成和 hook 完全相同的事件（`permission_request`、`question_asked`、`turn_complete` 等），走同一套会话状态机。picker 和状态栏的表现与 hook 模式完全一样。

**如何保证状态可信。**

- **每个 agent 只有一个写入方。** 由读屏负责的 agent 不装 hook，其他 agent 继续用 hook。两个延迟不同的来源不会互相覆盖。
- **答案要过关才采纳。** 置信度低于门槛（默认 0.55）时忽略模型，会话保持原状态。几个独立的问题互相校验：模型说"在等审批"，但"是否卡在等人操作"的答案是否定的，就不采纳。看不懂的画面（编辑器、分页器）不下结论。被拒的画面最多重问 2 次。
- **只能从已有状态里选。** 模型只能在现有的几种状态里选择，读屏结果要经过和 hook 事件相同的守卫，不能随意指定状态。
- **进入等待容易，离开等待难。** `WAIT` 要连续两次置信度达到 0.75 以上（默认门槛下），或者连续约 10 秒判断一致才会解除。重绘时的一帧误读清不掉审批状态。
- **自动纠错。** 每次读屏都和会话的真实状态对比，不一致才改。
- **过期的读数作废：** 比已应用读数更早的画面，以及进程已经被替换的 pane 上的读数，都会丢弃。复用的 pane 里新开的会话，不会继承上一个进程留下的提问。
- **客观事实优先于模型。** 进程和 pane 是否存活由系统直接探测，优先级最高：进程退出了，会话就结束，屏幕上的残留文字不能让它"复活"。屏幕上是普通 shell 提示符时，交给存活探测判断。超时兜底仍然保留，用于读屏失效的情况（没有 key、被限流）；模型正在正常确认某个会话时，兜底会让位，所以画面长时间不动的长命令不会被误判为已完成。
- **可追溯。** 每次状态变化都记录来源和原因：`node scripts/debug.js evidence <session-id>`。
- **先测量再上线。** 每次调整给模型的说明，都要用一批标注好的真实画面打分。"很确定但判错"一律算失败，没有商量余地。

**速度与成本**（在约 25 个 agent pane 的机器上实测）：

| | |
|---|---|
| 回合结束 → 显示 `DONE` | 1.5–4.5 秒 |
| 开始工作 → 显示 `BUSY` | 1 秒以内 |
| watchdog CPU 占用 | 约单核 2% |
| 每次调用模型 | 约 $0.0001（只按输入计费，输出免费） |
| 画面命中缓存的比例 | 97–98% |
| 花费 | agent 工作时每小时几美分；空闲会话大约每天一次调用 |

**开启步骤。**

1. 先用 `shadow` 模式试运行：只读屏并记录模型的判断，不改任何会话。跑一天左右，对比它和 hook 的判断是否一致：

   ```bash
   set -g @scout-pane-model shadow   # off（默认）| shadow
   node scripts/debug.js pane-agreement --since 24h
   ```

2. 满足以下条件（都可以用 `scripts/setup.sh doctor` 检查）：
   - **Node 20+**，并在插件目录执行 `npm install`。TPM 安装不会执行 `npm install`，所以 SDK 是可选依赖：没装时这个功能保持关闭，其他功能照常；Node 版本太旧时 `npm install` 会跳过它，不会报错。
   - **API key。** watchdog 由 `tmux run-shell` 启动，继承的是 tmux *服务端*启动时的环境变量，不是你的 shell 的，所以只在 `.zshrc` 里 export 没用。用下面任一方式：

     ```bash
     tmux set-environment -g TYPESAFE_API_KEY sk-...
     # 或者
     install -m 600 /dev/null ~/.tmux-scout/typesafe.key && $EDITOR ~/.tmux-scout/typesafe.key
     ```

     换 key 时，用新 key 再执行一次同样的 `set-environment`。旧 key 被拒后约 15 秒内，运行中的 watchdog 会自动换用新 key，不需要重启。

3. 切换过去，并卸掉这些 agent 已有的 hook：

   ```bash
   set -g @scout-state-source jev    # hook（默认）| jev
   scripts/setup.sh uninstall --claude --codex --gemini
   ```

   这是**按 agent 二选一**，不是混用：`@scout-pane-model-agents` 里的 agent 由读屏负责，其他 agent 继续用 hook。`setup.sh install` 会跳过读屏 agent 的 hook，`doctor` 发现残留时会提示。配置修改 15 秒内就会生效，不需要重启 watchdog。

**可选配置。**

```bash
set -g @scout-pane-model-agents claude,codex,gemini # 哪些 CLI 由读屏负责
set -g @scout-pane-model-confidence 0.55            # 低于这个置信度时忽略模型
set -g @scout-pane-model-interval 6                 # 画面持续变化时，同一会话两次付费调用的间隔（秒）；
                                                    # 结论一直不变时逐步退避到 30 秒
set -g @scout-pane-model-lines 40                   # 发送 pane 底部多少行
```

这个间隔只对持续变化的画面生效。画面刚静止下来，或者底部变了（比如弹出了审批框），只要距离该会话上次调用满 2 秒就会立刻去读：这正是回合结束或需要你操作的时刻。

**观察运行情况。**

```bash
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" watcher status
```

会输出一行 `pane-model`（调用次数、缓存命中数和命中率、重问次数、已应用的读数），和一行 `jev`（p50/p95/max 延迟、输入 token、累计花费和每小时花费）。如果所有 agent 都空闲时命中率还一直很低，说明有动画没被过滤掉，正在被重复付费。

想看跨重启的历史，打开逐次调用日志再读取；想看模型此刻怎么判断某个 pane，直接对它分类：

```bash
tmux set -g @scout-jev-log-calls on
node scripts/debug.js jev-metrics --since 24h
node scripts/debug.js classify %39 --state
```

**局限。**

- 屏幕上看不到 hook 事件携带的全部信息：对读屏的 agent，精确的工具参数、turn 和 request id、transcript 路径都拿不到了。`shadow` 模式就是用来在切换前衡量这个取舍的。
- 每个 CLI 的界面说明只根据真实画面来写。Claude Code 和 Codex 已完整描述；Traex 运行中的样子、Gemini CLI 运行中和已完成的样子还没有，这些情况下模型只能依据通用判断标准。

### 面板访问追踪

picker 按你最近查看会话的时间排序。默认情况下 tmux-scout 会用 `pane-focus-in` hook 记录你聚焦的每个 pane——无论是通过 picker、prefix 快捷键、鼠标，还是 window/session 切换——因此排序反映真实的访问时间，而不只是 picker 跳转。关闭：

```bash
set -g @scout-track-focus off
```

hook 安装在固定槽位（`pane-focus-in[9909]`），因此在 config 重载时保持幂等，并能与你自己的 `pane-focus-in` hook 共存。访问历史（有上限）存储在 `~/.tmux-scout/access-history.json`。

## 数据存储

会话数据存储在 `~/.tmux-scout/` 目录下：

```
~/.tmux-scout/
├── status.json                      # 聚合的会话索引
├── sessions/                        # 每个会话的 JSON 文件
│   ├── {session-id}.json
│   └── ...
├── watcher.pid                      # watchdog 进程锁
├── watcher-state.json               # watchdog JSONL offset/cache
├── watcher.log                      # watchdog 诊断日志
├── run/bridge.sock                  # watchdog single-writer Unix socket
├── codex-hooks-manifest.json        # tmux-scout 管理的 Codex event hook trust key
├── codex-original-notify.json       # 备份的原始 Codex notify 命令
├── access-history.json              # picker MRU 排序用的 pane 访问历史
├── typesafe.key                     # 读屏模式：API key（如果用文件保存）
├── pane-cache.json                  # 读屏模式：每个画面的答案，保留 24 小时
├── pane-observed.json               # 读屏模式：每个会话最近一次被确认的时间
├── pane-agreement.jsonl             # shadow 模式：模型与 hook 的对比记录，供 pane-agreement 使用
└── pane-metrics.jsonl               # 每次调用的延迟和花费（开启 @scout-jev-log-calls 时）
```

tmux-scout 会保留当前仍可见或近期可见的会话。隐藏的内部会话以及终端态的 `STALE` / `CRASH` 行会在短暂展示窗口后移除；带有明确 `endedAt` 的快照最多保留 24 小时后清理。

## Agent 兼容说明

tmux-scout 现在优先使用 Codex event hook，可以近实时同步会话开始、提示提交、工具执行、审批等待和回合完成状态。这是一套基于事件钩子的近实时生命周期跟踪方式，而非轮询。

在默认 watchdog 路径下，tmux-scout 仍以 hook 作为主状态源，并增加一套校正机制：进程/pane 生命周期检查、带 offset 缓存的 Codex transcript 尾部增量读取、registry 清理，以及周期性全量 reconcile。快速路径不会反复全量读取所有 transcript。

设置 `@scout-state-source jev` 后，由读屏负责的 agent 完全不使用 hook：它们的状态来自屏幕，底层仍有进程/pane 存活探测和超时兜底。详见[从屏幕读取状态](#从屏幕读取状态可选默认关闭)。

内部会把 hook、pane、transcript、PID、stale timeout 等观察结果统一交给 session-state reducer。短时间竞态里，高置信度的 hook/PID 事件会压过低置信度的 pane/transcript 观察；但 crash/stale 这类终止事件仍会关闭已经死亡的会话。

如果使用的是只支持 `notify` 的旧版 Codex，tmux-scout 仍会安装并串联 legacy notify hook。在该兜底模式下，首轮完成前的新会话发现仍可能依赖 JSONL 轮询。

Gemini CLI、Kimi CLI、GitHub Copilot CLI、OpenCode、Cursor Agent、Hermes、Trae CLI 和 Traex CLI 通过 generic hook adapter 接入。它会把各自的 hook/plugin 事件映射到同一套 session lifecycle model，因此支持质量取决于这些 CLI 暴露的 prompt、工具调用、审批、提问、subagent 和完成事件 payload。

## 开发

项目内部文档：

- [Agent Integration Guide](docs/agent-integration.md)：说明如何新增或维护 agent 集成。
- [Session State Contract](docs/session-contract.md)：说明持久化 session/event 契约。

```bash
npm run check   # 检查项目 JavaScript 语法
npm test        # 运行聚焦单元测试
npm run ci      # 同时运行以上检查
```

### Flow Fixture 与调试

Agent 生命周期回归可以沉淀为 `tests/fixtures/flow/<agent>/` 下的 JSON fixture。
每个 fixture 都会把真实 hook 入口回放到隔离的 `HOME` 中，并校验最终 session snapshot、
状态契约以及期望的 evidence stream。

常用调试命令：

```bash
node scripts/debug.js list
node scripts/debug.js show <session-id> --plain
node scripts/debug.js evidence <session-id>
node scripts/debug.js inject --session-id debug-wait --agent codex --phase waitingForApproval
node scripts/debug.js replay tests/fixtures/flow/claude/approval.json --show
```

如果希望沿用 tmux 加载插件时捕获的 PATH，也可以通过 `scripts/setup.sh debug ...` 调用同一组命令。

## 许可证

MIT
