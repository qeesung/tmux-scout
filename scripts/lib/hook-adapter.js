// Shared hook adapter primitives for tmux-scout agent integrations.

const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const { applySessionEvent } = require('./session-state')
const { terminalContext } = require('./terminal-context')

const LIFECYCLE_FIELDS = new Set([
  'status',
  'phase',
  'needsAttention',
  'pendingToolUse',
  'activeTool',
  'endedAt',
  'stateSource',
  'lastEvent'
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

function safeSessionId(sessionId) {
  return String(sessionId).replace(/[/\\:]/g, '_')
}

function liveSessionState(updates) {
  return Object.assign({
    endedAt: null,
    needsAttention: null
  }, updates)
}

function resolvePid(data) {
  const payloadPid = Number.parseInt(data && data.pid, 10)
  if (Number.isInteger(payloadPid) && payloadPid > 0) return payloadPid
  return Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null
}

function createLifecycleEvent(updates, config) {
  if (updates.lifecycleEvent) return updates.lifecycleEvent
  if (!updates.lastEvent) return null

  const legacyNotify = updates.stateSource === 'notify'
  const lifecycleForce = typeof config.lifecycleForce === 'function'
    ? config.lifecycleForce(updates)
    : config.lifecycleForce

  return {
    type: updates.lastEvent.type,
    source: legacyNotify ? 'notify' : 'hook',
    stateSource: updates.stateSource || config.defaultStateSource,
    timestamp: updates.lastEvent.timestamp,
    details: updates.lastEvent.details,
    turnId: updates.lastEvent.turnId,
    attentionReason: updates.needsAttention || null,
    pendingToolUse: updates.pendingToolUse,
    activeTool: updates.activeTool,
    endedAt: updates.endedAt,
    force: Boolean(lifecycleForce)
  }
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
  let session = readJson(sessionFile, null) || {
    sessionId,
    agentType: adapterConfig.agentType,
    startedAt: Date.now()
  }

  const lifecycleEvent = createLifecycleEvent(nextUpdates, adapterConfig)
  delete nextUpdates.lifecycleEvent

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
    const pid = resolvePid(payload)
    const base = Object.assign({
      agentType: adapterConfig.agentType,
      workingDirectory: payload.cwd,
      transcriptPath: payload.transcript_path,
      tmuxPane: process.env.TMUX_PANE || null,
      pid,
      lastHookAt: now
    }, terminalContext(pid))

    if (typeof adapterConfig.baseFields === 'function') {
      Object.assign(base, adapterConfig.baseFields(payload, now, pid))
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
  createHookContext,
  updateSessionDirect,
  sendUpdateToBridge
}
