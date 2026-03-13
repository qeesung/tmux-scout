# tmux-scout

一个用于监控和导航 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 与 [Codex](https://github.com/openai/codex) 会话的 tmux 插件。提供实时 fzf 选择器在 agent 面板间快速跳转，状态栏组件显示会话计数，以及自动检测崩溃的会话。

[English](README.md)

<video src="https://github.com/user-attachments/assets/01ab8cdb-b3da-43de-8082-545879817ce3" controls="controls" style="max-width: 100%;">
  Your browser does not support the video tag.
</video>

## 功能特性

- **会话选择器** — `prefix + O` 打开 fzf 弹窗，列出所有活跃的 agent 会话，显示状态标签（`WAIT` / `BUSY` / `DONE` / `IDLE`）、项目名、提示标题和实时工具详情
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

tmux-scout 需要在 Claude Code 和/或 Codex 中安装 hook 来追踪会话。安装插件后运行配置命令：

```bash
# 插件加载后会设置 SCOUT_DIR 环境变量，以下命令可直接复制执行
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install

# 其他操作
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --claude   # 仅 Claude Code
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" install --codex    # 仅 Codex
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" uninstall          # 卸载所有 hook
eval "$(tmux show-env -g SCOUT_DIR)" && "$SCOUT_DIR/scripts/setup.sh" status             # 查看安装状态
```

安装命令是**幂等**的 — 重复运行不会重复添加。如果你移动了仓库位置，重新运行 install 会自动更新 hook 路径。

### 修改了什么

- **Claude Code**：在 `~/.claude/settings.json` 的 6 个事件类型中各添加一条 hook
- **Codex**：设置 `~/.codex/config.toml` 中的 `notify` 字段（原有的 notify 命令会被备份并串联调用）

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
* [ BUSY ] claude  my-project                "implement the login page"  Bash: npm test
```

- `*` — 当前面板指示器
- `[ WAIT ]` / `[ BUSY ]` / `[ DONE ]` / `[ IDLE ]` — 会话状态
- Agent 类型（claude / codex）
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

## 数据存储

会话数据存储在 `~/.tmux-scout/` 目录下：

```
~/.tmux-scout/
├── status.json                      # 聚合的会话索引
├── sessions/                        # 每个会话的 JSON 文件
│   ├── {session-id}.json
│   └── ...
└── codex-original-notify.json       # 备份的原始 Codex notify 命令
```

超过 24 小时的会话会被自动清理。

## 已知问题

Codex 的 hook 机制极其糟糕 — 只提供了一个 `notify` hook，且仅在每轮 agent 响应完成后触发（`agent-turn-complete`）。没有会话开始、没有会话结束、没有工具调用事件，什么都没有。这导致了两个问题：

- **新会话无法跳转** — 在 Codex 完成第一次响应之前，tmux-scout 无法知道会话运行在哪个面板中。这些会话在选择器中显示为"未绑定"状态，在第一轮响应完成前无法跳转。
- **会话信息不一致** — 会话开始、提示提交、工具调用、会话结束等关键事件在 Codex 的 hook 中完全缺失。这意味着会话状态可能是完全错误的 — 一个会话可能显示为"已完成"但 Codex 正在处理中，或者显示为"工作中"但实际早已结束。

这些是 Codex hook 设计的根本性缺陷，而非 tmux-scout 的 bug。我们实现了多种补偿机制：通过轮询 JSONL 日志文件提前发现会话、通过进程存活检测识别崩溃、通过文件过期检测清理死亡会话、以及从 JSONL 中解析 pending tool call 状态。不过不用担心，tmux-scout 会将状态最终收敛到正确的状态。

## 许可证

MIT
