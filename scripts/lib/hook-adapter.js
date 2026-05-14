// Shared hook adapter primitives for tmux-scout agent integrations.

const fs = require('fs')
const path = require('path')
const os = require('os')
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
    sessionsDir: path.join(statusDir, 'sessions')
  }
}

function ensureDirs(paths) {
  if (!fs.existsSync(paths.statusDir)) {
    fs.mkdirSync(paths.statusDir, { recursive: true })
  }
  if (!fs.existsSync(paths.sessionsDir)) {
    fs.mkdirSync(paths.sessionsDir, { recursive: true })
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

function createHookContext(config) {
  const adapterConfig = Object.assign({
    agentType: 'unknown',
    defaultStateSource: 'hook',
    lifecycleForce: true,
    paths: defaultPaths()
  }, config || {})
  const paths = adapterConfig.paths || defaultPaths()

  function sessionPath(sessionId) {
    return path.join(paths.sessionsDir, safeSessionId(sessionId) + '.json')
  }

  function readStatus() {
    return readJson(paths.statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  }

  function readSession(sessionId) {
    return readJson(sessionPath(sessionId), null)
  }

  function updateSession(sessionId, updates) {
    ensureDirs(paths)
    const nextUpdates = updates || {}

    const sessionFile = sessionPath(sessionId)
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

    const status = readStatus()
    status.sessions[sessionId] = session
    status.lastUpdated = Date.now()

    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const [id, sess] of Object.entries(status.sessions)) {
      if (sess.endedAt && sess.endedAt < cutoff) {
        delete status.sessions[id]
        try { fs.unlinkSync(sessionPath(id)) } catch (_) {}
      }
    }

    writeJsonAtomic(paths.statusFile, status)
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
    sessionPath,
    readStatus,
    readSession,
    updateSession,
    baseUpdates
  }
}

module.exports = {
  defaultPaths,
  writeJsonAtomic,
  readJson,
  readStdin,
  liveSessionState,
  createHookContext
}
