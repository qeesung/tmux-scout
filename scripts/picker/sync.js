#!/usr/bin/env node
// Sync session data: reconcile crashed processes and poll Codex JSONL state.
// Writes results back to status.json. Should run before generate-lines.js.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

let statusFile = process.argv[2] || ''
let sessionsDir = statusFile ? path.join(path.dirname(statusFile), 'sessions') : ''
const pidStateCache = new Map()

// --- I/O helpers ---

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function writeJsonAtomic(filePath, data) {
  const tempPath = filePath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function sessionFilePath(sessionId) {
  return path.join(sessionsDir, sessionId.replace(/[/\\:]/g, '_') + '.json')
}

// --- tmux pane snapshot ---

function getPaneSnapshot() {
  const panes = new Map()
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}:#{window_name}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    if (!output) return panes

    for (const line of output.split('\n')) {
      const [paneId, panePid, currentCommand, paneDead] = line.split('\t')
      if (paneId) {
        panes.set(paneId.trim(), {
          paneId: paneId.trim(),
          panePid: Number.parseInt(panePid, 10) || null,
          currentCommand: currentCommand || '',
          paneDead: paneDead === '1'
        })
      }
    }
  } catch (_) {}
  return panes
}

// --- PID helpers ---

function hasTrackedPid(session) {
  return Number.isInteger(session.pid) && session.pid > 0
}

function getPidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  if (pidStateCache.has(pid)) return pidStateCache.get(pid)

  let state = 'unknown'
  try {
    process.kill(pid, 0)
    state = 'alive'
  } catch (error) {
    if (error && error.code === 'ESRCH') state = 'dead'
    else if (error && error.code === 'EPERM') state = 'alive'
  }

  pidStateCache.set(pid, state)
  return state
}

// --- Crash detection ---

function isShellCommand(command) {
  return new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu']).has(command)
}

function canUseShellFallback(session) {
  if (session.agentType === 'codex') return true
  const lastEventType = session && session.lastEvent ? session.lastEvent.type : null
  return session.status === 'working' || lastEventType === 'prompt_submit' || lastEventType === 'tool_use' || Boolean(session.pendingToolUse)
}

function detectCrashReason(session, pane) {
  if (!pane || pane.paneDead) return null

  if (hasTrackedPid(session) && getPidState(session.pid) === 'dead') {
    return `pid ${session.pid} exited while pane ${session.tmuxPane} remained open`
  }

  if (!hasTrackedPid(session) && canUseShellFallback(session) && isShellCommand(pane.currentCommand || '')) {
    return `pane ${session.tmuxPane} returned to shell ${pane.currentCommand}`
  }

  return null
}

function reconcileSessions(status, panes) {
  const now = Date.now()
  const changedSessions = new Map()

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (!session || session.endedAt || !pane) continue

    const crashReason = detectCrashReason(session, pane)
    if (!crashReason) continue

    const updatedSession = Object.assign({}, session, {
      crashReason,
      status: 'crashed',
      endedAt: now,
      needsAttention: null,
      pendingToolUse: null,
      lastEvent: { type: 'process_exit_detected', timestamp: now, details: crashReason },
      lastUpdated: now
    })
    status.sessions[sessionId] = updatedSession
    changedSessions.set(sessionId, updatedSession)
  }

  if (changedSessions.size > 0) {
    status.lastUpdated = now
    for (const [sessionId, session] of changedSessions) {
      writeJsonAtomic(sessionFilePath(sessionId), session)
    }
    writeJsonAtomic(statusFile, status)
  }
}

// --- Codex JSONL helpers ---

function findCodexJsonl(threadId) {
  if (!threadId) return null
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessionsBase)) return null

  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  for (const d of [now, yesterday]) {
    const dir = path.join(sessionsBase, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    if (!fs.existsSync(dir)) continue
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        if (f.endsWith('.jsonl') && f.includes(threadId)) {
          return path.join(dir, f)
        }
      }
    } catch (_) {}
  }
  return null
}

function extractUserMessage(ev) {
  if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'user_message' && ev.payload.message) {
    let msg = String(ev.payload.message)
    const marker = '## My request for Codex:'
    const idx = msg.indexOf(marker)
    if (idx >= 0) msg = msg.slice(idx + marker.length)
    return msg.trim().slice(0, 100).split('\n')[0].trim()
  }
  if (ev.type === 'response_item' && ev.payload && ev.payload.type === 'message' && ev.payload.role === 'user') {
    const content = ev.payload.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if ((part.type === 'input_text' || part.type === 'text') && part.text) {
          let msg = String(part.text)
          const marker = '## My request for Codex:'
          const idx = msg.indexOf(marker)
          if (idx >= 0) msg = msg.slice(idx + marker.length)
          return msg.trim().slice(0, 100).split('\n')[0].trim()
        }
      }
    }
  }
  return null
}

function readCodexJsonl(jsonlPath) {
  if (!jsonlPath) return null
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null

    let lastUserTitle = undefined
    let lastCompletedTs = 0
    let lastUserTs = 0
    let cwd = undefined
    let waitingForPlanConfirmation = false
    const pendingCalls = new Set()

    for (const line of lines) {
      let ev
      try { ev = JSON.parse(line) } catch (_) { continue }

      const userMsg = extractUserMessage(ev)
      if (userMsg) {
        lastUserTitle = userMsg
        lastUserTs = ev.timestamp ? new Date(ev.timestamp).getTime() : 0
        // User responded — no longer waiting for plan confirmation
        waitingForPlanConfirmation = false
      }

      // Only task_complete is a true turn-end signal
      // agent_message fires mid-turn (progress updates) and is NOT completion
      if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'task_complete') {
        lastCompletedTs = ev.timestamp ? new Date(ev.timestamp).getTime() : 0
      }

      // Detect plan mode completion — Codex is waiting for user to confirm/reject
      if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'item_completed'
        && ev.payload.item && ev.payload.item.type === 'Plan') {
        waitingForPlanConfirmation = true
      }

      if (ev.type === 'turn_context' && ev.payload && ev.payload.cwd) {
        cwd = ev.payload.cwd
      }

      if (ev.type === 'response_item' && ev.payload) {
        if (ev.payload.type === 'custom_tool_call' || ev.payload.type === 'function_call') {
          if (ev.payload.call_id) pendingCalls.add(ev.payload.call_id)
        }
        if (ev.payload.type === 'custom_tool_call_output' || ev.payload.type === 'function_call_output') {
          if (ev.payload.call_id) pendingCalls.delete(ev.payload.call_id)
        }
      }
    }

    let status = 'completed'
    const now = Date.now()

    if (waitingForPlanConfirmation && lastCompletedTs > 0) {
      // Plan mode ended, waiting for user to confirm "Implement this plan?"
      status = 'needsAttention'
    } else if (pendingCalls.size > 0) {
      if (now - lastCompletedTs > 30000 && now - lastUserTs > 30000) {
        status = 'needsAttention'
      } else {
        status = 'working'
      }
    } else if (lastUserTs > lastCompletedTs) {
      status = 'working'
    }

    return { status, title: lastUserTitle || undefined, cwd }
  } catch (_) {
    return null
  }
}

// --- Codex session sync ---

function syncCodexSessions(status, panes) {
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessionsBase)) return

  const now = Date.now()
  let changed = false

  // Phase 1: discover new sessions from JSONL directory
  const knownThreadIds = new Set()
  for (const s of Object.values(status.sessions || {})) {
    if (s.agentType === 'codex' && s.threadId) knownThreadIds.add(s.threadId)
  }

  const today = new Date(now)
  const yesterday = new Date(now - 86400000)

  // Shared caches between Phase 1 and Phase 2
  const jsonlPathCache = new Map()   // threadId → jsonlPath
  const jsonlResultCache = new Map() // jsonlPath → result

  for (const d of [today, yesterday]) {
    const dir = path.join(sessionsBase, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    if (!fs.existsSync(dir)) continue
    let files
    try { files = fs.readdirSync(dir) } catch (_) { continue }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue

      const match = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
      if (!match) continue
      const threadId = match[1]

      const fp = path.join(dir, f)

      // Cache path for Phase 2 lookups
      if (!jsonlPathCache.has(threadId)) jsonlPathCache.set(threadId, fp)

      if (knownThreadIds.has(threadId)) continue

      let fstat
      try { fstat = fs.statSync(fp) } catch (_) { continue }
      if (now - fstat.mtimeMs > 300000) continue

      const result = readCodexJsonl(fp)
      if (!result) continue

      // Cache result for Phase 2
      jsonlResultCache.set(fp, result)

      status.sessions[threadId] = {
        sessionId: threadId,
        agentType: 'codex',
        startedAt: fstat.birthtimeMs || now,
        status: result.status,
        endedAt: null,
        needsAttention: result.status === 'needsAttention' ? 'waiting' : null,
        pendingToolUse: null,
        workingDirectory: result.cwd || '',
        sessionTitle: result.title,
        threadId,
        tmuxPane: null,
        pid: null,
        lastEvent: { type: 'discovered', timestamp: now },
        lastUpdated: now
      }
      knownThreadIds.add(threadId)
      changed = true
    }
  }

  // Phase 2: enrich existing sessions from JSONL (using caches)
  for (const session of Object.values(status.sessions || {})) {
    if (session.agentType !== 'codex' || session.endedAt) continue
    const threadId = session.threadId || session.sessionId

    const jsonlPath = jsonlPathCache.get(threadId) || findCodexJsonl(threadId)

    // Unbound sessions (no pane/PID): detect stale JSONL as process death.
    // If the JSONL file hasn't been written to for over 2 minutes, the Codex
    // process is no longer running — mark crashed.
    if (!session.tmuxPane && !hasTrackedPid(session) && jsonlPath) {
      try {
        const mtime = fs.statSync(jsonlPath).mtimeMs
        if (now - mtime > 300000) {
          Object.assign(session, {
            status: 'crashed',
            endedAt: now,
            needsAttention: null,
            pendingToolUse: null,
            crashReason: 'JSONL file inactive — Codex process likely exited before hook fired',
            lastEvent: { type: 'process_exit_detected', timestamp: now, details: 'JSONL stale for unbound session' },
            lastUpdated: now
          })
          writeJsonAtomic(sessionFilePath(session.sessionId), session)
          changed = true
          continue
        }
      } catch (_) {}
    }

    const result = jsonlResultCache.get(jsonlPath) || readCodexJsonl(jsonlPath)
    if (!result) continue

    let sessionChanged = false

    // Recover PID from session file if hook has written it
    // (sync.js reads status.json which may have stale pid: null due to race with hook)
    if (!hasTrackedPid(session)) {
      const fileData = readJson(sessionFilePath(session.sessionId), null)
      if (fileData && hasTrackedPid(fileData)) {
        session.pid = fileData.pid
        sessionChanged = true
      }
    }

    if (result.title && result.title !== session.sessionTitle) {
      session.sessionTitle = result.title
      sessionChanged = true
    }

    let newStatus = session.status
    let newNeedsAttention = session.needsAttention
    if (result.status === 'needsAttention') {
      newStatus = 'working'
      newNeedsAttention = 'waiting for approval'
    } else if (result.status === 'working') {
      newStatus = 'working'
      newNeedsAttention = null
    } else if (result.status === 'completed') {
      newStatus = 'completed'
      newNeedsAttention = null
    }

    if (newStatus !== session.status || newNeedsAttention !== session.needsAttention) {
      session.status = newStatus
      session.needsAttention = newNeedsAttention
      session.lastUpdated = now
      sessionChanged = true
    }

    if (sessionChanged) {
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      changed = true
    }
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

// --- Pane content ground truth ---

function capturePaneContent(paneId) {
  try {
    return execSync(`tmux capture-pane -t ${paneId} -p -S -15`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    })
  } catch (_) {
    return null
  }
}

const CLAUDE_WAIT_STRINGS = [
  'Do you want to proceed?',        // 标准工具/编辑审批
  'Would you like to proceed?',      // 替代措辞
  'Enter plan mode?',                // plan 模式入口
  'Exit plan mode?',                 // plan 模式出口
  'Do you want to allow',            // 网络抓取/连接审批
]

// WAIT strings that coexist with 'esc to interrupt' in the question-answering footer.
// Must be checked BEFORE the 'esc to interrupt' busy check.
const CODEX_WAIT_FOOTER = [
  'enter to submit answer',       // #1 单题问答
  'enter to submit all',          // #2 多题问答
]

// WAIT strings from dialogs that replace the entire UI — 'esc to interrupt' is NOT
// present when these are showing. Checked AFTER the busy check so that model output
// containing these phrases during generation (where 'esc to interrupt' IS present)
// won't cause false positives.
const CODEX_WAIT_DIALOG = [
  'enter to submit',              // #3 字段编辑（无 answer/all 后缀）
  'Implement this plan?',         // #4 Plan 实现确认
  'Approve Once',                 // #5 工具/命令审批
  'approve network access',       // #6 网络访问审批
  'Submit with unanswered',       // #7 提交未答题确认
  'Install MCP servers?',         // #8 MCP 服务安装
  'Enable full access?',          // #9 Full Access 确认
  'Enable multi-agent?',          // #10 Multi-agent 确认
]

const CLAUDE_BUSY_RE = /[↓↑] [\d.,]+[kKmM]? tokens\)|✻ Thinking|∴ Thinking/
const CLAUDE_DONE_RE = /✻ (Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for /
const CLAUDE_IDLE_RE = /✻ Idle/
const CLAUDE_INTERRUPTED_RE = /Interrupted . What should Claude do instead/

function detectPaneState(paneId, agentType) {
  const content = capturePaneContent(paneId)
  if (!content) return null

  const lines = content.trimEnd().split('\n')
  const tail = lines.slice(-8).join('\n')

  if (agentType === 'codex') {
    // Phase 1: footer WAIT strings that coexist with 'esc to interrupt'
    for (const s of CODEX_WAIT_FOOTER) {
      if (tail.includes(s)) return 'needsAttention'
    }
    // Phase 2: if model is actively generating, it's working.
    // This gates Phase 3 — dialog strings in model output won't false-positive.
    if (tail.includes('esc to interrupt')) return 'working'
    // Phase 3: dialog WAIT strings (UI has replaced normal view, no 'esc to interrupt')
    for (const s of CODEX_WAIT_DIALOG) {
      if (tail.includes(s)) return 'needsAttention'
    }
    return 'completed'
  }

  // Claude Code — BUSY/DONE 门控 + WAIT 检测
  //
  // ✻ Thinking 与真实权限提示永不共存（模型先停止生成再弹提示）。
  // ✻ Worked for... 是权威完成信号，此时 tail 中的 WAIT 字符串来自输出文本。

  // Phase 1: BUSY — 模型正在生成
  if (CLAUDE_BUSY_RE.test(tail)) return 'working'

  // Phase 2: DONE — 模型刚完成（短暂 ✻ Worked for... 窗口，门控假阳性）
  if (CLAUDE_DONE_RE.test(tail)) return 'completed'

  // Phase 3: WAIT — 权限/审批提示（BUSY/DONE 已排除，此时检测安全）
  for (const s of CLAUDE_WAIT_STRINGS) {
    if (tail.includes(s)) return 'needsAttention'
  }

  // Phase 4: IDLE
  if (CLAUDE_IDLE_RE.test(tail)) return 'completed'

  // Phase 5: INTERRUPTED
  if (CLAUDE_INTERRUPTED_RE.test(tail)) return 'completed'

  return null
}

function applyPaneGroundTruth(status) {
  let changed = false
  for (const session of Object.values(status.sessions || {})) {
    if (!session.tmuxPane || session.endedAt) continue

    const state = detectPaneState(session.tmuxPane, session.agentType)
    if (state === null) continue

    let sessionChanged = false
    switch (state) {
      case 'needsAttention':
        if (session.needsAttention !== 'waiting for approval') {
          session.needsAttention = 'waiting for approval'
          sessionChanged = true
        }
        break
      case 'working':
        if (session.needsAttention || session.pendingToolUse || session.status !== 'working') {
          session.needsAttention = null
          session.pendingToolUse = null
          if (session.status !== 'working') session.status = 'working'
          sessionChanged = true
        }
        break
      case 'completed':
        if (session.needsAttention || session.pendingToolUse || session.status !== 'completed') {
          session.needsAttention = null
          session.pendingToolUse = null
          session.status = 'completed'
          sessionChanged = true
        }
        break
    }

    if (sessionChanged) {
      session.lastUpdated = Date.now()
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      changed = true
    }
  }

  if (changed) {
    status.lastUpdated = Date.now()
    writeJsonAtomic(statusFile, status)
  }
}

// --- Main ---

function run(file) {
  if (file) {
    statusFile = file
    sessionsDir = path.join(path.dirname(file), 'sessions')
  }
  if (!statusFile) return { status: null, panes: new Map() }
  const status = readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const panes = getPaneSnapshot()
  reconcileSessions(status, panes)
  syncCodexSessions(status, panes)
  applyPaneGroundTruth(status)
  return { status, panes }
}

module.exports = { run }

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
