#!/usr/bin/env node
// Sync session data: reconcile crashed processes and poll Codex JSONL state.
// Writes results back to status.json. Should run before rendering picker/status lines.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { applySessionEvent, currentPhase } = require('../lib/session-state')
const { DEFAULT_TAIL_BYTES, readJsonlFile, readJsonlIncremental: readJsonlTailIncremental } = require('../lib/jsonl-tail-reader')
const { readProcessTable, findAgentProcessFromPane } = require('../lib/process-tree')
const { classifyCodexSession, cleanCodexPrompt, isHiddenCodexSession } = require('../lib/codex-session-classifier')

let statusFile = process.argv[2] || ''
let sessionsDir = statusFile ? path.join(path.dirname(statusFile), 'sessions') : ''
const pidStateCache = new Map()
const CODEX_TAIL_BYTES = DEFAULT_TAIL_BYTES
const CODEX_STUCK_TOOL_MS = 180000
const CLAUDE_TRANSCRIPT_TAIL_BYTES = DEFAULT_TAIL_BYTES
const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user]'

function createStats(options = {}) {
  return {
    startedAt: Date.now(),
    mode: options.codexMode === 'incremental'
      ? (options.discoverCodex ? 'incremental+discover' : 'incremental')
      : options.codexMode === 'none' ? 'none' : 'full',
    reconcile: {
      processExits: 0,
      paneShellExits: 0,
      pidBindings: 0
    },
    codex: {
      discovered: 0,
      updated: 0,
      stale: 0,
      filesRead: 0,
      eventsParsed: 0,
      parseErrors: 0
    },
    paneGroundTruth: {
      updates: 0
    },
    stuckTools: {
      interrupted: 0
    },
    claudeTranscript: {
      interrupted: 0,
      filesRead: 0,
      parseErrors: 0
    }
  }
}

function ensureStats(options = {}) {
  const defaults = createStats(options)
  const stats = options.stats || defaults
  for (const key of ['reconcile', 'codex', 'paneGroundTruth', 'stuckTools', 'claudeTranscript']) {
    stats[key] = Object.assign({}, defaults[key], stats[key] || {})
  }
  if (!stats.mode) stats.mode = defaults.mode
  return stats
}

function recordJsonlRead(stats, parsed) {
  if (!stats || !parsed) return
  stats.codex.filesRead++
  stats.codex.eventsParsed += parsed.parsed || 0
  stats.codex.parseErrors += parsed.parseErrors || 0
}

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
    const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t#{window_index}\t#{window_name}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    if (!output) return panes

    for (const line of output.split('\n')) {
      const [paneId, panePid, currentCommand, paneDead, sessionName, windowIndex, windowName] = line.split('\t')
      if (paneId) {
        panes.set(paneId.trim(), {
          paneId: paneId.trim(),
          panePid: Number.parseInt(panePid, 10) || null,
          currentCommand: currentCommand || '',
          paneDead: paneDead === '1',
          sessionName: sessionName || '',
          windowIndex: Number.parseInt(windowIndex, 10) || 0,
          windowName: windowName || ''
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

function clearPidStateCache() {
  pidStateCache.clear()
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

function applySessionUpdate(status, sessionId, session, event) {
  const result = applySessionEvent(session, event)
  if (!result.changed) return false
  status.sessions[sessionId] = session
  writeJsonAtomic(sessionFilePath(sessionId), session)
  return true
}

function sweepPidBindings(status, panes, processTable, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (!session || session.endedAt || !pane) continue

    const phase = currentPhase(session)
    if (phase !== 'running' && phase !== 'waitingForApproval' && phase !== 'waitingForAnswer') continue

    const agentProcess = findAgentProcessFromPane(pane.panePid, session.agentType, processTable)
    if (!agentProcess || agentProcess.pid === session.pid) continue

    session.pid = agentProcess.pid
    session.pidSource = 'process-tree'
    session.pidCommand = agentProcess.command
    session.pidBoundAt = now
    session.lastUpdated = now
    writeJsonAtomic(sessionFilePath(sessionId), session)
    if (stats) stats.reconcile.pidBindings++
    changed = true
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

function exitEventForSession(session, reason, source, now) {
  const phase = currentPhase(session)
  const active = phase === 'running' || phase === 'waitingForApproval' || phase === 'waitingForAnswer'
  if (active) {
    session.crashReason = reason
    return {
      type: 'process_exit_detected',
      source,
      timestamp: now,
      reason,
      details: reason,
      force: true
    }
  }

  session.staleReason = reason
  return {
    type: 'stale',
    source,
    timestamp: now,
    reason,
    details: reason,
    force: true
  }
}

function sweepDeadProcesses(status, panes, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (!session || session.endedAt || !pane || !hasTrackedPid(session)) continue
    if (getPidState(session.pid) !== 'dead') continue

    const reason = `pid ${session.pid} exited while pane ${session.tmuxPane} remained open`
    const updated = applySessionUpdate(status, sessionId, session, exitEventForSession(session, reason, 'pid', now))
    if (updated && stats) stats.reconcile.processExits++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

function sweepPaneReturnedToShell(status, panes, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (!session || session.endedAt || !pane || hasTrackedPid(session)) continue
    if (!canUseShellFallback(session) || !isShellCommand(pane.currentCommand || '')) continue

    const reason = `pane ${session.tmuxPane} returned to shell ${pane.currentCommand}`
    const updated = applySessionUpdate(status, sessionId, session, exitEventForSession(session, reason, 'pane', now))
    if (updated && stats) stats.reconcile.paneShellExits++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

function reconcileSessions(status, panes, stats) {
  const processTable = readProcessTable()
  sweepDeadProcesses(status, panes, stats)
  sweepPaneReturnedToShell(status, panes, stats)
  sweepPidBindings(status, panes, processTable, stats)
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
    return cleanCodexPrompt(ev.payload.message)
  }
  if (ev.type === 'response_item' && ev.payload && ev.payload.type === 'message' && ev.payload.role === 'user') {
    const content = ev.payload.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if ((part.type === 'input_text' || part.type === 'text') && part.text) {
          return cleanCodexPrompt(part.text)
        }
      }
    }
  }
  return null
}

function createCodexAccumulator(seed) {
  const pendingCalls = Array.isArray(seed && seed.pendingCalls)
    ? Array.from(new Set(seed.pendingCalls.filter(Boolean).map(String)))
    : []
  return {
    lastUserTitle: seed && seed.lastUserTitle,
    lastUserPrompt: seed && seed.lastUserPrompt,
    sessionMeta: seed && seed.sessionMeta,
    lastCompletedTs: Number.isFinite(seed && seed.lastCompletedTs) ? seed.lastCompletedTs : 0,
    lastInterruptedTs: Number.isFinite(seed && seed.lastInterruptedTs) ? seed.lastInterruptedTs : 0,
    lastUserTs: Number.isFinite(seed && seed.lastUserTs) ? seed.lastUserTs : 0,
    cwd: seed && seed.cwd,
    waitingForPlanConfirmation: Boolean(seed && seed.waitingForPlanConfirmation),
    pendingCalls,
    eventCount: Number.isFinite(seed && seed.eventCount) ? seed.eventCount : 0
  }
}

function eventTimestamp(ev, fallback = 0) {
  if (!ev || !ev.timestamp) return fallback
  const ts = new Date(ev.timestamp).getTime()
  return Number.isFinite(ts) ? ts : fallback
}

function applyCodexEvent(accumulator, ev) {
  if (!ev || typeof ev !== 'object') return
  const pendingCalls = new Set(accumulator.pendingCalls || [])

  if (ev.type === 'session_meta' && ev.payload && typeof ev.payload === 'object') {
    accumulator.sessionMeta = ev.payload
  }

  const userMsg = extractUserMessage(ev)
  if (userMsg) {
    accumulator.lastUserPrompt = userMsg
    accumulator.lastUserTitle = userMsg.slice(0, 100).split('\n')[0].trim()
    accumulator.lastUserTs = eventTimestamp(ev, 0)
    // User responded — no longer waiting for plan confirmation.
    accumulator.waitingForPlanConfirmation = false
  }

  // Only task_complete is a true turn-end signal.
  // agent_message fires mid-turn (progress updates) and is NOT completion.
  if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'task_complete') {
    accumulator.lastCompletedTs = eventTimestamp(ev, 0)
  }

  // Codex does not always emit Stop hooks on Ctrl-C / ESC interruption.
  // The transcript records that as turn_aborted; treat it as a completed
  // turn so interrupted sessions do not remain BUSY forever.
  if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'turn_aborted'
    && ev.payload.reason === 'interrupted') {
    const interruptedTs = eventTimestamp(ev, Date.now())
    accumulator.lastCompletedTs = interruptedTs
    accumulator.lastInterruptedTs = interruptedTs
  }

  // Detect plan mode completion — Codex is waiting for user to confirm/reject.
  if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'item_completed'
    && ev.payload.item && ev.payload.item.type === 'Plan') {
    accumulator.waitingForPlanConfirmation = true
  }

  if (ev.type === 'turn_context' && ev.payload && ev.payload.cwd) {
    accumulator.cwd = ev.payload.cwd
  }

  if (ev.type === 'response_item' && ev.payload) {
    if (ev.payload.type === 'custom_tool_call' || ev.payload.type === 'function_call') {
      if (ev.payload.call_id) pendingCalls.add(String(ev.payload.call_id))
    }
    if (ev.payload.type === 'custom_tool_call_output' || ev.payload.type === 'function_call_output') {
      if (ev.payload.call_id) pendingCalls.delete(String(ev.payload.call_id))
    }
  }

  accumulator.pendingCalls = Array.from(pendingCalls)
  accumulator.eventCount = (accumulator.eventCount || 0) + 1
}

function codexResultFromAccumulator(accumulator) {
  const acc = createCodexAccumulator(accumulator)
  const classification = classifyCodexSession({
    prompt: acc.lastUserPrompt || acc.lastUserTitle || '',
    sessionMeta: acc.sessionMeta
  })
  let status = 'completed'
  const now = Date.now()
  const pendingCount = acc.pendingCalls.length

  if (acc.waitingForPlanConfirmation && acc.lastCompletedTs > 0) {
    // Plan mode ended, waiting for user to confirm "Implement this plan?"
    status = 'needsAttention'
  } else if (acc.lastInterruptedTs > 0 && acc.lastInterruptedTs >= acc.lastUserTs) {
    status = 'interrupted'
  } else if (pendingCount > 0) {
    if (now - acc.lastCompletedTs > 30000 && now - acc.lastUserTs > 30000) {
      status = 'needsAttention'
    } else {
      status = 'working'
    }
  } else if (acc.lastUserTs > acc.lastCompletedTs) {
    status = 'working'
  }

  return {
    status,
    title: acc.lastUserTitle || undefined,
    cwd: acc.cwd,
    hidden: classification.hidden,
    hiddenReason: classification.reason,
    isInternalCodexSession: classification.isInternal,
    isCodexSubagent: classification.isSubagent,
    parentSessionId: classification.parentSessionId,
    subagentDepth: classification.subagentDepth,
    subagentNickname: classification.subagentNickname,
    hasTimeline: Boolean(acc.lastUserTs || acc.lastCompletedTs || acc.lastInterruptedTs || pendingCount || acc.waitingForPlanConfirmation)
  }
}

function readCodexJsonl(jsonlPath, stats) {
  if (!jsonlPath) return null
  const parsed = readJsonlFile(jsonlPath)
  if (!parsed) return null
  recordJsonlRead(stats, parsed)
  if (parsed.objects.length === 0) return null
  const accumulator = createCodexAccumulator()
  for (const ev of parsed.objects) applyCodexEvent(accumulator, ev)
  return codexResultFromAccumulator(accumulator)
}

function readCodexJsonlIncremental(jsonlPath, fileState, options = {}) {
  if (!jsonlPath) return null
  const state = fileState || {}
  const maxInitialBytes = options.maxInitialBytes || CODEX_TAIL_BYTES

  const delta = readJsonlTailIncremental(jsonlPath, state, { maxInitialBytes })
  if (!delta) return null
  recordJsonlRead(options.stats, delta)

  if (delta.reset || !state.accumulator) {
    state.accumulator = createCodexAccumulator()
  } else {
    state.accumulator = createCodexAccumulator(state.accumulator)
  }

  for (const ev of delta.objects) applyCodexEvent(state.accumulator, ev)

  return {
    changed: delta.changed,
    parsed: delta.parsed,
    result: codexResultFromAccumulator(state.accumulator),
    state
  }
}

// --- Codex session sync ---

function recentCodexSessionDirs(now) {
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  const today = new Date(now)
  const yesterday = new Date(now - 86400000)
  return [today, yesterday].map(d => path.join(sessionsBase, String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')))
}

function discoverCodexJsonlFiles(now) {
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessionsBase)) return []

  const filesByThread = new Map()
  for (const dir of recentCodexSessionDirs(now)) {
    if (!fs.existsSync(dir)) continue
    let files
    try { files = fs.readdirSync(dir) } catch (_) { continue }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const match = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
      if (!match) continue
      const fp = path.join(dir, f)
      if (!filesByThread.has(match[1])) filesByThread.set(match[1], fp)
    }
  }
  return Array.from(filesByThread, ([threadId, filePath]) => ({ threadId, filePath }))
}

function applyCodexResultToSession(session, result, now) {
  if (!session || !result) return false
  let sessionChanged = false

  if (result.hidden && !session.isHiddenFromScout) {
    session.isHiddenFromScout = true
    session.hiddenReason = result.hiddenReason || 'codex-hidden-session'
    session.hiddenAt = now
    session.isInternalCodexSession = Boolean(result.isInternalCodexSession)
    session.isCodexSubagent = Boolean(result.isCodexSubagent)
    if (result.parentSessionId) session.parentSessionId = result.parentSessionId
    if (result.subagentDepth !== undefined) session.subagentDepth = result.subagentDepth
    if (result.subagentNickname) session.subagentNickname = result.subagentNickname
    session.needsAttention = null
    session.pendingToolUse = null
    applySessionEvent(session, {
      type: 'session_end',
      source: 'transcript',
      timestamp: now,
      endedAt: now,
      reason: session.hiddenReason,
      details: session.hiddenReason,
      force: true
    })
    return true
  }

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

  if (result.cwd && result.cwd !== session.workingDirectory) {
    session.workingDirectory = result.cwd
    sessionChanged = true
  }

  if (result.hasTimeline === false) return sessionChanged

  const phase = result.status === 'needsAttention' ? 'waitingForApproval'
    : result.status === 'working' ? 'running'
    : result.status === 'completed' ? 'completed'
    : result.status === 'interrupted' ? 'interrupted'
    : null
  const eventResult = applySessionEvent(session, {
    type: result.status === 'interrupted' ? 'interrupted' : 'transcript_status',
    source: 'transcript',
    timestamp: now,
    phase,
    status: result.status,
    attentionReason: result.status === 'needsAttention' ? 'waiting for approval' : null,
    reason: result.status === 'interrupted' ? 'Codex transcript recorded turn_aborted/interrupted' : 'Codex transcript status',
    details: result.status,
    updates: {
      stateSource: session.stateSource || 'codex-jsonl'
    }
  })
  sessionChanged = eventResult.changed || sessionChanged

  return sessionChanged
}

function addDiscoveredCodexSession(status, threadId, filePath, fileStat, result, now) {
  const session = {
    sessionId: threadId,
    agentType: 'codex',
    startedAt: fileStat.birthtimeMs || now,
    status: 'idle',
    endedAt: null,
    needsAttention: null,
    pendingToolUse: null,
    workingDirectory: result.cwd || '',
    sessionTitle: result.title,
    threadId,
    transcriptPath: filePath,
    tmuxPane: null,
    pid: null,
    stateSource: 'codex-jsonl',
    isHiddenFromScout: Boolean(result.hidden),
    hiddenReason: result.hiddenReason || undefined,
    hiddenAt: result.hidden ? now : undefined,
    isInternalCodexSession: Boolean(result.isInternalCodexSession),
    isCodexSubagent: Boolean(result.isCodexSubagent),
    parentSessionId: result.parentSessionId || undefined,
    subagentDepth: result.subagentDepth,
    subagentNickname: result.subagentNickname || undefined,
    lastEvent: { type: 'discovered', timestamp: now },
    lastUpdated: now
  }
  applyCodexResultToSession(session, result, now)
  status.sessions[threadId] = session
}

function markUnboundCodexStale(session, jsonlPath, now) {
  if (session.tmuxPane || hasTrackedPid(session) || !jsonlPath) return false
  try {
    const mtime = fs.statSync(jsonlPath).mtimeMs
    if (now - mtime <= 300000) return false
    session.staleReason = 'JSONL file inactive — Codex process likely exited before hook fired'
    applySessionEvent(session, {
      type: 'stale',
      source: 'stale',
      timestamp: now,
      reason: session.staleReason,
      details: 'JSONL stale for unbound session',
      force: true
    })
    return true
  } catch (_) {
    return false
  }
}

function syncCodexSessionsFull(status, panes, stats) {
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessionsBase)) return

  const now = Date.now()
  let changed = false

  // Phase 1: discover new sessions from JSONL directory
  const knownThreadIds = new Set()
  for (const s of Object.values(status.sessions || {})) {
    if (s.agentType === 'codex' && s.threadId) knownThreadIds.add(s.threadId)
  }

  // Shared caches between Phase 1 and Phase 2
  const jsonlPathCache = new Map()   // threadId -> jsonlPath
  const jsonlResultCache = new Map() // jsonlPath -> result

  for (const { threadId, filePath } of discoverCodexJsonlFiles(now)) {
    if (!jsonlPathCache.has(threadId)) jsonlPathCache.set(threadId, filePath)
    if (knownThreadIds.has(threadId)) continue

    let fstat
    try { fstat = fs.statSync(filePath) } catch (_) { continue }
    if (now - fstat.mtimeMs > 300000) continue

    const result = readCodexJsonl(filePath, stats)
    if (!result || !result.hasTimeline) continue
    if (result.hidden) continue

    jsonlResultCache.set(filePath, result)
    addDiscoveredCodexSession(status, threadId, filePath, fstat, result, now)
    if (stats) stats.codex.discovered++
    knownThreadIds.add(threadId)
    changed = true
  }

  // Phase 2: enrich existing sessions from JSONL (using caches)
  for (const session of Object.values(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (session.agentType !== 'codex' || session.endedAt) continue
    const threadId = session.threadId || session.sessionId

    const jsonlPath = session.transcriptPath || jsonlPathCache.get(threadId) || findCodexJsonl(threadId)
    if (jsonlPath && jsonlPath !== session.transcriptPath) {
      session.transcriptPath = jsonlPath
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      changed = true
    }

    // Unbound sessions (no pane/PID): detect stale JSONL as process death.
    // If the JSONL file hasn't been written to for over 2 minutes, the Codex
    // process is no longer running — mark crashed.
    if (markUnboundCodexStale(session, jsonlPath, now)) {
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      if (stats) stats.codex.stale++
      changed = true
      continue
    }

    const result = jsonlResultCache.get(jsonlPath) || readCodexJsonl(jsonlPath, stats)
    if (!result) continue

    if (applyCodexResultToSession(session, result, now)) {
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      if (stats) stats.codex.updated++
      changed = true
    }
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

function getCodexWatcherFilesState(watcherState) {
  if (!watcherState || typeof watcherState !== 'object') return null
  if (!watcherState.codexFiles || typeof watcherState.codexFiles !== 'object') {
    watcherState.codexFiles = {}
  }
  return watcherState.codexFiles
}

function syncCodexSessionsIncremental(status, panes, options = {}, stats) {
  const sessionsBase = path.join(os.homedir(), '.codex', 'sessions')
  if (!fs.existsSync(sessionsBase)) return

  const now = Date.now()
  const filesState = getCodexWatcherFilesState(options.watcherState)
  if (!filesState) return

  let changed = false
  const knownThreadIds = new Set()
  const jsonlPathCache = new Map()

  for (const s of Object.values(status.sessions || {})) {
    if (s.agentType === 'codex' && s.threadId) knownThreadIds.add(s.threadId)
  }

  if (options.discoverCodex) {
    for (const { threadId, filePath } of discoverCodexJsonlFiles(now)) {
      if (!jsonlPathCache.has(threadId)) jsonlPathCache.set(threadId, filePath)
      if (knownThreadIds.has(threadId)) continue

      let fstat
      try { fstat = fs.statSync(filePath) } catch (_) { continue }
      if (now - fstat.mtimeMs > 300000) continue

      const fileState = filesState[filePath] || {}
      const delta = readCodexJsonlIncremental(filePath, fileState, { stats })
      filesState[filePath] = fileState
      if (!delta || !delta.result || !delta.result.hasTimeline) continue
      if (delta.result.hidden) continue

      addDiscoveredCodexSession(status, threadId, filePath, fstat, delta.result, now)
      if (stats) stats.codex.discovered++
      knownThreadIds.add(threadId)
      changed = true
    }
  }

  for (const session of Object.values(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (session.agentType !== 'codex' || session.endedAt) continue
    const threadId = session.threadId || session.sessionId
    const jsonlPath = session.transcriptPath || jsonlPathCache.get(threadId) || findCodexJsonl(threadId)

    if (!jsonlPath) continue
    if (jsonlPath !== session.transcriptPath) {
      session.transcriptPath = jsonlPath
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      changed = true
    }

    if (markUnboundCodexStale(session, jsonlPath, now)) {
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      if (stats) stats.codex.stale++
      changed = true
      continue
    }

    const fileState = filesState[jsonlPath] || {}
    const delta = readCodexJsonlIncremental(jsonlPath, fileState, { stats })
    filesState[jsonlPath] = fileState
    if (!delta || !delta.changed || !delta.result) continue

    if (applyCodexResultToSession(session, delta.result, now)) {
      writeJsonAtomic(sessionFilePath(session.sessionId), session)
      if (stats) stats.codex.updated++
      changed = true
    }
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

function syncCodexSessions(status, panes, options = {}, stats) {
  if (options.codexMode === 'none') return
  if (options.codexMode === 'incremental') {
    syncCodexSessionsIncremental(status, panes, options, stats)
    return
  }
  syncCodexSessionsFull(status, panes, stats)
}

function sweepStuckCodexTools(status, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (!session || session.agentType !== 'codex' || session.endedAt) continue
    if (!session.pendingToolUse || !Number.isFinite(session.pendingToolUse.timestamp)) continue
    if (now - session.pendingToolUse.timestamp < CODEX_STUCK_TOOL_MS) continue

    const phase = currentPhase(session)
    if (phase !== 'running' || session.needsAttention) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: 'interrupted',
      source: 'transcript',
      timestamp: now,
      reason: `pending tool exceeded ${Math.round(CODEX_STUCK_TOOL_MS / 1000)}s without completion`,
      details: session.pendingToolUse.details || session.pendingToolUse.tool || 'stuck tool',
      force: false
    })
    if (updated && stats) stats.stuckTools.interrupted++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    writeJsonAtomic(statusFile, status)
  }
}

// --- Claude transcript helpers ---

function readFileTail(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    if (length <= 0) return { text: '', mtimeMs: stat.mtimeMs }

    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = fs.readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf-8', 0, bytesRead)
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
      }
      return { text, mtimeMs: stat.mtimeMs }
    } finally {
      fs.closeSync(fd)
    }
  } catch (_) {
    return null
  }
}

function isClaudeInterruptText(value) {
  const text = String(value || '')
  return text.includes(CLAUDE_INTERRUPT_MARKER) || /request interrupted by user/i.test(text)
}

function objectContainsInterrupt(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false
  if (typeof value === 'string') return isClaudeInterruptText(value)
  if (Array.isArray(value)) return value.some(item => objectContainsInterrupt(item, depth + 1))
  if (typeof value === 'object') {
    return Object.values(value).some(item => objectContainsInterrupt(item, depth + 1))
  }
  return false
}

function eventTimestampMs(obj) {
  if (!obj || typeof obj !== 'object') return null
  for (const key of ['timestamp', 'created_at', 'createdAt']) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value).getTime()
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function findLatestClaudeInterrupt(transcriptPath, sinceMs, stats) {
  const tail = readFileTail(transcriptPath, CLAUDE_TRANSCRIPT_TAIL_BYTES)
  if (!tail) return null
  if (stats) stats.claudeTranscript.filesRead++

  const hits = []
  for (const line of tail.text.split('\n')) {
    if (!line.trim()) continue
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {
      if (stats) stats.claudeTranscript.parseErrors++
    }

    const hit = obj ? objectContainsInterrupt(obj) : isClaudeInterruptText(line)
    if (!hit) continue
    hits.push({
      timestamp: eventTimestampMs(obj),
      rawLine: line
    })
  }

  const threshold = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs - 1000 : 0
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index]
    if (Number.isFinite(hit.timestamp)) {
      if (!threshold || hit.timestamp >= threshold) return hit
      continue
    }
    if (!threshold || tail.mtimeMs >= threshold) return hit
  }
  return null
}

function sweepInterruptedClaudeTranscripts(status, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || session.agentType !== 'claude' || session.endedAt) continue
    if (currentPhase(session) !== 'running') continue
    if (!session.transcriptPath) continue

    const hit = findLatestClaudeInterrupt(session.transcriptPath, session.lastUpdated || session.startedAt, stats)
    if (!hit) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: 'interrupted',
      source: 'transcript',
      timestamp: now,
      reason: 'Claude transcript recorded request interruption',
      details: CLAUDE_INTERRUPT_MARKER,
      force: false
    })
    if (updated && stats) stats.claudeTranscript.interrupted++
    changed = updated || changed
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

function paneState(status, attentionReason) {
  return { status, attentionReason }
}

function detectPaneState(paneId, agentType) {
  const content = capturePaneContent(paneId)
  if (!content) return null

  const lines = content.trimEnd().split('\n')
  const tail = lines.slice(-8).join('\n')

  if (agentType === 'codex') {
    // Phase 1: footer WAIT strings that coexist with 'esc to interrupt'
    for (const s of CODEX_WAIT_FOOTER) {
      if (tail.includes(s)) return paneState('needsAttention', 'waiting for answer')
    }
    // Phase 2: if model is actively generating, it's working.
    // This gates Phase 3 — dialog strings in model output won't false-positive.
    if (tail.includes('esc to interrupt')) return paneState('working')
    // Phase 3: dialog WAIT strings (UI has replaced normal view, no 'esc to interrupt')
    for (const s of CODEX_WAIT_DIALOG) {
      const reason = s.includes('plan') ? 'waiting for plan approval'
        : s.includes('Submit with unanswered') || s.includes('enter to submit') ? 'waiting for answer'
        : 'waiting for approval'
      if (tail.includes(s)) return paneState('needsAttention', reason)
    }
    return paneState('completed')
  }

  // Claude Code — BUSY/DONE 门控 + WAIT 检测
  //
  // ✻ Thinking 与真实权限提示永不共存（模型先停止生成再弹提示）。
  // ✻ Worked for... 是权威完成信号，此时 tail 中的 WAIT 字符串来自输出文本。

  // Phase 1: BUSY — 模型正在生成
  if (CLAUDE_BUSY_RE.test(tail)) return paneState('working')

  // Phase 2: DONE — 模型刚完成（短暂 ✻ Worked for... 窗口，门控假阳性）
  if (CLAUDE_DONE_RE.test(tail)) return paneState('completed')

  // Phase 3: WAIT — 权限/审批提示（BUSY/DONE 已排除，此时检测安全）
  for (const s of CLAUDE_WAIT_STRINGS) {
    if (tail.includes(s)) return paneState('needsAttention', 'waiting for approval')
  }

  // Phase 4: IDLE
  if (CLAUDE_IDLE_RE.test(tail)) return paneState('completed')

  // Phase 5: INTERRUPTED
  if (CLAUDE_INTERRUPTED_RE.test(tail)) return paneState('completed')

  return null
}

function applyPaneGroundTruth(status, stats) {
  let changed = false
  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (!session.tmuxPane || session.endedAt) continue

    const detected = detectPaneState(session.tmuxPane, session.agentType)
    if (detected === null) continue
    const state = typeof detected === 'string' ? detected : detected.status
    const attentionReason = typeof detected === 'object' && detected.attentionReason
      ? detected.attentionReason
      : 'waiting for approval'

    const now = Date.now()
    const phase = state === 'needsAttention' && attentionReason === 'waiting for answer' ? 'waitingForAnswer'
      : state === 'needsAttention' ? 'waitingForApproval'
      : state === 'working' ? 'running'
      : state === 'completed' ? 'completed'
      : null
    if (!phase) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: 'pane_state',
      source: 'pane',
      timestamp: now,
      phase,
      status: state,
      attentionReason: state === 'needsAttention' ? attentionReason : null,
      reason: `pane ${session.tmuxPane} tail matched ${state}`,
      details: state
    })
    if (updated && stats) stats.paneGroundTruth.updates++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = Date.now()
    writeJsonAtomic(statusFile, status)
  }
}

// --- Main ---

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function isWatcherRunning() {
  const pidFile = path.join(os.homedir(), '.tmux-scout', 'watcher.pid')
  const lock = readJson(pidFile, null)
  const pid = Number.parseInt(lock && lock.pid, 10)
  return isPidAlive(pid)
}

function run(file, options = {}) {
  clearPidStateCache()
  const stats = ensureStats(options)
  stats.startedAt = Date.now()

  if (file) {
    statusFile = file
    sessionsDir = path.join(path.dirname(file), 'sessions')
  }
  if (!statusFile) return { status: null, panes: new Map(), stats }
  const status = readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const panes = getPaneSnapshot()
  if (options.reconcile !== false) reconcileSessions(status, panes, stats)
  syncCodexSessions(status, panes, options, stats)
  if (options.stuckSweep !== false) sweepStuckCodexTools(status, stats)
  if (options.claudeTranscript !== false) sweepInterruptedClaudeTranscripts(status, stats)
  if (options.paneGroundTruth !== false) applyPaneGroundTruth(status, stats)
  stats.durationMs = Date.now() - stats.startedAt
  return { status, panes, stats }
}

module.exports = { run, isWatcherRunning, clearPidStateCache, createStats }

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
