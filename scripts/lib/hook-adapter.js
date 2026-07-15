// Shared hook adapter primitives for tmux-scout agent integrations.

const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const { applySessionEvent, currentPhase } = require('./session-state')
const { AGENT_EVENTS, createAgentEvent } = require('./agent-events')
const { hookRuntimeContext } = require('./terminal-context')
const { deleteSession: deleteRegistrySession, safeSessionId } = require('./session-registry')

const LIFECYCLE_FIELDS = new Set([
  'status',
  'phase',
  'needsAttention',
  'pendingInteraction',
  'pendingToolUse',
  'activeTool',
  'endedAt',
  'stateSource',
  'stateConfidence',
  'stateReason',
  'terminalKind',
  'terminalReason',
  'deferredCompletion',
  'lastEvent',
  'lifecycle',
  'stateContractVersion',
  'currentTurnId',
  'turnStartedAt',
  'turnEndedAt',
  'lastTurnId'
])

function defaultPaths(homeDir = os.homedir()) {
  const statusDir = path.join(homeDir, '.tmux-scout')
  return {
    statusDir,
    statusFile: path.join(statusDir, 'status.json'),
    sessionsDir: path.join(statusDir, 'sessions'),
    runDir: path.join(statusDir, 'run'),
    bridgeSocket: path.join(statusDir, 'run', 'bridge.sock')
  }
}

function ensureDirs(paths) {
  if (!fs.existsSync(paths.statusDir)) {
    fs.mkdirSync(paths.statusDir, { recursive: true })
  }
  if (!fs.existsSync(paths.sessionsDir)) {
    fs.mkdirSync(paths.sessionsDir, { recursive: true })
  }
  if (paths.runDir && !fs.existsSync(paths.runDir)) {
    fs.mkdirSync(paths.runDir, { recursive: true })
  }
}

function writeJsonAtomic(filePath, data) {
  const tempPath = filePath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function readStdin() {
  return new Promise((resolve) => {
    let input = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { input += chunk })
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', () => resolve(input))
  })
}

function liveSessionState(updates) {
  return Object.assign({
    endedAt: null,
    needsAttention: null
  }, updates)
}

// A subagent's rendered tool line (activeSubagents[].lastToolActivity) should
// only be overwritten with a *meaningful* value. Generic placeholders like
// "Thinking…", "Prompt: …", or the bare tool fallbacks ("unknown"/"Tool")
// would clobber the last real tool line, so callers keep the prior value when
// this returns false.
function isMeaningfulSubagentActivity(activity) {
  if (activity === undefined || activity === null) return false
  const text = String(activity).trim()
  if (!text) return false
  if (/^prompt:/i.test(text)) return false
  if (/^processing prompt/i.test(text)) return false
  if (/^thinking(?:\.{0,3}|…)$/i.test(text)) return false
  if (/^(unknown|tool)$/i.test(text)) return false
  return true
}

function resolvePid(data) {
  const payloadPid = Number.parseInt(data && data.pid, 10)
  if (Number.isInteger(payloadPid) && payloadPid > 0) return payloadPid
  return Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null
}

function eventDefaultsFromUpdates(updates, config) {
  return {
    source: 'hook',
    stateSource: updates.stateSource || config.defaultStateSource,
    rawEventName: updates.lastHookEventName || updates.rawEventName,
    transcriptPath: updates.transcriptPath,
    tmuxPane: updates.tmuxPane,
    pid: updates.pid,
    requestId: updates.requestId,
    toolCallId: updates.toolCallId,
    toolUseId: updates.toolUseId,
    channelAlive: updates.channelAlive
  }
}

function createLifecycleEvent(updates, config) {
  const defaults = eventDefaultsFromUpdates(updates, config)
  if (updates.lifecycleEvent) {
    return createAgentEvent(updates.lifecycleEvent, defaults)
  }
  if (!updates.lastEvent) return null

  const legacyNotify = updates.stateSource === 'notify'
  const lifecycleForce = typeof config.lifecycleForce === 'function'
    ? config.lifecycleForce(updates)
    : config.lifecycleForce

  return createAgentEvent({
    type: updates.lastEvent.type,
    source: legacyNotify ? 'notify' : 'hook',
    stateSource: updates.stateSource || config.defaultStateSource,
    timestamp: updates.lastEvent.timestamp,
    details: updates.lastEvent.details,
    turnId: updates.lastEvent.turnId,
    rawEventName: updates.lastEvent.rawEventName || updates.lastHookEventName || updates.lastEvent.details,
    transcriptPath: updates.transcriptPath,
    tmuxPane: updates.tmuxPane,
    pid: updates.pid,
    attentionReason: updates.needsAttention || null,
    pendingToolUse: updates.pendingToolUse,
    activeTool: updates.activeTool,
    requestId: updates.requestId,
    toolCallId: updates.toolCallId,
    toolUseId: updates.toolUseId,
    channelAlive: updates.channelAlive,
    endedAt: updates.endedAt,
    force: Boolean(lifecycleForce)
  }, defaults)
}

function sessionPath(paths, sessionId) {
  return path.join(paths.sessionsDir, safeSessionId(sessionId) + '.json')
}

function readStatus(paths) {
  return readJson(paths.statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
}

function updateSessionDirect(config, paths, sessionId, updates) {
  ensureDirs(paths)
  const adapterConfig = Object.assign({
    agentType: 'unknown',
    defaultStateSource: 'hook',
    lifecycleForce: true
  }, config || {})
  const nextUpdates = Object.assign({}, updates || {})

  const sessionFile = sessionPath(paths, sessionId)
  const existingSession = readJson(sessionFile, null)
  let session = existingSession || {
    sessionId,
    agentType: adapterConfig.agentType,
    startedAt: Date.now(),
    // Every event-created agent session defaults to running.
    // session to running. This matters when the first observed hook is
    // phase-neutral (for example a late PostToolUse); IDLE is reserved for the
    // explicit pane-discovery transport path.
    phase: 'running',
    status: 'working',
    endedAt: null,
    needsAttention: null,
    pendingInteraction: null,
    activeTool: null
  }

  const lifecycleEvent = createLifecycleEvent(nextUpdates, adapterConfig)
  delete nextUpdates.lifecycleEvent

  // Preserve the reducer no-op through persistence as well: do not create a
  // session, merge transport metadata, rewrite files, or refresh lastUpdated.
  if (lifecycleEvent &&
    lifecycleEvent.type === AGENT_EVENTS.PERMISSION_RESOLVED &&
    (!existingSession || currentPhase(existingSession) !== 'waitingForApproval')) {
    return existingSession
  }

  if (lifecycleEvent && lifecycleEvent.type === AGENT_EVENTS.SESSION_DELETE) {
    const status = readStatus(paths)
    const result = deleteRegistrySession(status, paths, sessionId, lifecycleEvent.reason || lifecycleEvent.details || 'session_delete')
    if (result.changed) {
      status.lastUpdated = Date.now()
      writeJsonAtomic(paths.statusFile, status)
    }
    return null
  }

  for (const [key, value] of Object.entries(nextUpdates)) {
    if (lifecycleEvent && LIFECYCLE_FIELDS.has(key)) continue
    if (value !== undefined) session[key] = value
  }

  if (lifecycleEvent) applySessionEvent(session, lifecycleEvent)
  session.lastUpdated = Date.now()
  writeJsonAtomic(sessionFile, session)

  const status = readStatus(paths)
  status.sessions[sessionId] = session
  status.lastUpdated = Date.now()

  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [id, sess] of Object.entries(status.sessions)) {
    if (sess.endedAt && sess.endedAt < cutoff) {
      delete status.sessions[id]
      try { fs.unlinkSync(sessionPath(paths, id)) } catch (_) {}
    }
  }

  writeJsonAtomic(paths.statusFile, status)
  return session
}

function sendUpdateToBridge(paths, message, timeoutMs = 3000) {
  return new Promise(resolve => {
    if (process.env.TMUX_SCOUT_BRIDGE === '0' || process.env.TMUX_SCOUT_BRIDGE_SERVER === '1') {
      resolve(false)
      return
    }
    if (!paths.bridgeSocket) {
      resolve(false)
      return
    }

    let done = false
    let buffer = ''
    let socket = null
    function finish(ok) {
      if (done) return
      done = true
      try { socket.destroy() } catch (_) {}
      resolve(Boolean(ok))
    }

    try {
      socket = net.createConnection({ path: paths.bridgeSocket })
    } catch (_) {
      finish(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      socket.write(JSON.stringify(message) + '\n')
    })
    socket.on('data', chunk => {
      buffer += chunk.toString('utf-8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      try {
        const response = JSON.parse(line)
        finish(response && response.ok === true)
      } catch (_) {
        finish(false)
      }
    })
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.on('end', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

function createHookContext(config) {
  const adapterConfig = Object.assign({
    agentType: 'unknown',
    defaultStateSource: 'hook',
    lifecycleForce: true,
    paths: defaultPaths()
  }, config || {})
  const paths = adapterConfig.paths || defaultPaths()
  let writeChain = Promise.resolve()

  function sessionFilePath(sessionId) {
    return sessionPath(paths, sessionId)
  }

  function readCurrentStatus() {
    return readStatus(paths)
  }

  function readSession(sessionId) {
    return readJson(sessionFilePath(sessionId), null)
  }

  function updateSession(sessionId, updates) {
    const nextUpdates = Object.assign({}, updates || {})
    const lifecycleEvent = createLifecycleEvent(nextUpdates, adapterConfig)
    if (lifecycleEvent) nextUpdates.lifecycleEvent = lifecycleEvent

    const message = {
      type: 'update_session',
      sessionId,
      agentType: adapterConfig.agentType,
      defaultStateSource: adapterConfig.defaultStateSource,
      updates: nextUpdates
    }

    writeChain = writeChain.catch(() => {}).then(async () => {
      const bridged = await sendUpdateToBridge(paths, message)
      if (!bridged) {
        updateSessionDirect(adapterConfig, paths, sessionId, nextUpdates)
      }
    })
    return writeChain
  }

  function flush() {
    return writeChain.catch(() => {})
  }

  function baseUpdates(data, now) {
    const payload = data || {}
    const tmuxPane = process.env.TMUX_PANE || payload.tmux_pane || payload.tmuxPane || null
    const runtime = hookRuntimeContext(payload, {
      agentType: adapterConfig.agentType,
      tmuxPane
    })
    const pid = runtime.pid || resolvePid(payload)
    const base = Object.assign({
      agentType: adapterConfig.agentType,
      workingDirectory: payload.cwd || process.cwd(),
      transcriptPath: payload.transcript_path,
      tmuxPane,
      pid,
      requestId: payload.request_id || payload.requestId || payload.tool_call_id || payload.toolCallId || payload.tool_use_id || payload.toolUseId || payload.call_id || payload.permission_id || payload.question_id,
      toolCallId: payload.tool_call_id || payload.toolCallId || payload.call_id,
      toolUseId: payload.tool_use_id || payload.toolUseId,
      lastHookAt: now,
      lastHookEventName: payload.hook_event_name || payload.event_type || payload.type || null
    }, runtime)

    if (typeof adapterConfig.baseFields === 'function') {
      Object.assign(base, adapterConfig.baseFields(payload, now, pid, runtime))
    }

    return base
  }

  return {
    agentType: adapterConfig.agentType,
    paths,
    sessionPath: sessionFilePath,
    readStatus: readCurrentStatus,
    readSession,
    updateSession,
    flush,
    baseUpdates
  }
}

module.exports = {
  defaultPaths,
  ensureDirs,
  writeJsonAtomic,
  readJson,
  readStdin,
  liveSessionState,
  isMeaningfulSubagentActivity,
  createHookContext,
  updateSessionDirect,
  sendUpdateToBridge
}
