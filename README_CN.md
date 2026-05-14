# tmux-scout

一个用于监控和导航 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex](https://github.com/openai/codex)、Gemini CLI、Kimi CLI、GitHub Copilot CLI 和 OpenCode 会话的 tmux 插件。提供实时 fzf 选择器在 agent 面板间快速跳转，状态栏组件显示会话计数，以及自动检测崩溃的会话。

[English](README.md)

如果你更喜欢零依赖的安装方式，不想在系统里额外配置 Node.js 运行环境，推荐试试由 [@ianchesal](https://github.com/ianchesal) 开发的优秀 Go 语言重写版本：

👉 **[tmux-scout-golang](https://github.com/ianchesal/tmux-scout-golang)**

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## 功能特性

- **会话选择器** — `prefix + O` 打开 fzf 弹窗，列出所有活跃的 agent 会话，显示状态标签（`WAIT` / `BUSY` / `DONE` / `IDLE`）、tmux window 名称、项目名、提示标题和实时工具详情
- **面板预览** — 右侧预览面板显示每个会话 tmux 面板的最后 40 行内容
- **状态栏组件** — 在 tmux 的 status-right 中显示按状态分类的会话计数（如 `0|1|2`），每 2 秒刷新
- **自动刷新** — `Ctrl-T` 切换每 2 秒自动刷新选择器
- **崩溃检测** — 自动检测死亡进程和过期的 Codex JSONL 文件并清理

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
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # 卸载所有 hook
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # 查看安装状态
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" doctor             # 运行环境诊断
```

安装命令是**幂等**的 — 重复运行不会重复添加。如果你移动了仓库位置，重新运行 install 会自动更新 hook 路径。
不带 agent 参数时，`install`、`uninstall` 和 `status` 会作用于所有支持的集成；可以通过 agent 参数限定范围。

### 修改了什么

- **Claude Code**：在 `~/.claude/settings.json` 的 9 个 Claude 支持事件类型中各添加一条 hook
- **Codex**：在 `~/.codex/hooks.json` 中添加 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` 事件 hook，并在 `~/.codex/config.toml` 中启用 hooks feature / trust state；同时保留 legacy `notify` 作为旧版 Codex 的兜底（原有 notify 命令会被备份并串联调用）
- **Gemini CLI**：在 `~/.gemini/settings.json` 中添加 command hook
- **Kimi CLI**：在 `~/.kimi/config.toml` 中追加受管理的 `[[hooks]]` block，同时保留无关 TOML 内容
- **GitHub Copilot CLI**：在 `~/.copilot/settings.json` 中添加 command hook
- **OpenCode**：写入 `~/.config/opencode/plugins/tmux-scout-opencode-plugin.js`，并在 OpenCode JSON 配置中注册该插件

## 使用方法

### 选择器

按 `prefix + O`（默认）打开会话选择器。

| 按键 | 操作 |
|---|---|
| `Enter` | 跳转到选中会话的面板 |
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
- Agent 类型（claude / codex / gemini / kimi / copilot-cli / opencode）
- tmux window 名称（未关联 window 时显示 `-`）
- 项目目录名
- 会话标题（首条提示）
- 当前工具详情（工作中的会话）

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

占位符：`{W}` 等待，`{B}` 工作中，`{D}` 已完成，`{I}` 空闲。

### 可选 Watchdog

默认情况下，tmux-scout 是被动的：hook 更新状态，picker / 状态栏刷新时做一次校正。如果希望即使不打开 picker、不刷新状态栏，也持续维护会话状态，可以启用 tmux 管理的 watchdog：

```bash
set -g @scout-watchdog on
```

这不是 launchd/systemd daemon，而是一个由 tmux 拥有的单实例 Node.js 进程；关闭选项或 tmux 不可用时会退出。watchdog 使用混合循环：

- 每 2 秒做进程/pane 生命周期检查和 Codex JSONL 增量读取
- 每 30 秒做 Codex JSONL 发现
- 每 60 秒做一次全量 reconcile

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

## 数据存储

会话数据存储在 `~/.tmux-scout/` 目录下：

```
~/.tmux-scout/
├── status.json                      # 聚合的会话索引
├── sessions/                        # 每个会话的 JSON 文件
│   ├── {session-id}.json
│   └── ...
├── watcher.pid                      # 可选 watchdog 进程锁
├── watcher-state.json               # 可选 watchdog JSONL offset/cache
├── watcher.log                      # 可选 watchdog 诊断日志
├── run/bridge.sock                  # 可选 watchdog single-writer Unix socket
├── codex-hooks-manifest.json        # tmux-scout 管理的 Codex event hook trust key
└── codex-original-notify.json       # 备份的原始 Codex notify 命令
```

超过 24 小时的会话会被自动清理。

## Agent 兼容说明

tmux-scout 现在优先使用 Codex event hook，可以近实时同步会话开始、提示提交、工具执行、审批等待和回合完成状态。这套生命周期跟踪方式参考了 Flux Desktop App 的实现。

开启 `@scout-watchdog` 后，tmux-scout 仍以 hook 作为主状态源，并增加 Flux 风格的校正机制：进程/pane 生命周期检查、带 offset 缓存的 Codex transcript 尾部增量读取、较低频的 JSONL 发现，以及周期性全量 reconcile。快速路径不会反复全量读取所有 transcript。

内部会把 hook、pane、transcript、PID、stale timeout 等观察结果统一交给 session-state reducer。短时间竞态里，高置信度的 hook/PID 事件会压过低置信度的 pane/transcript 观察；但 crash/stale 这类终止事件仍会关闭已经死亡的会话。

如果使用的是只支持 `notify` 的旧版 Codex，tmux-scout 仍会安装并串联 legacy notify hook。在该兜底模式下，首轮完成前的新会话发现仍可能依赖 JSONL 轮询。

Gemini CLI、Kimi CLI、GitHub Copilot CLI 和 OpenCode 通过 generic hook adapter 接入。它会把各自的 hook/plugin 事件映射到同一套 session lifecycle model，因此支持质量取决于这些 CLI 暴露的 prompt、工具调用、审批和完成事件 payload。

## 开发

```bash
npm run check   # 检查项目 JavaScript 语法
npm test        # 运行聚焦单元测试
npm run ci      # 同时运行以上检查
```

## 许可证

MIT
