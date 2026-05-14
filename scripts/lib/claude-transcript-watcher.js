// fs.watch-backed fast path for Claude transcript interruption markers.

const fs = require('fs')
const path = require('path')
const { applySessionEvent, currentPhase } = require('./session-state')
const { readFileTail, splitJsonlLines } = require('./jsonl-tail-reader')
const { AGENT_EVENTS } = require('./agent-events')

const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user]'
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 128 * 1024

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

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (_) {}
  return fallback
}

function sessionFilePath(statusFile, sessionId) {
  return path.join(path.dirname(statusFile), 'sessions', sessionId.replace(/[/\\:]/g, '_') + '.json')
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

function containsInterruptText(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return false
  if (typeof value === 'string') return /request interrupted by user/i.test(value)
  if (Array.isArray(value)) return value.some(item => containsInterruptText(item, depth + 1))
  if (typeof value === 'object') return Object.values(value).some(item => containsInterruptText(item, depth + 1))
  return false
}

function findLatestClaudeInterrupt(transcriptPath, sinceMs) {
  const tail = readFileTail(transcriptPath, CLAUDE_TRANSCRIPT_TAIL_BYTES)
  if (!tail) return null

  const hits = []
  for (const line of splitJsonlLines(tail.text)) {
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {}
    const hit = obj ? containsInterruptText(obj) : /request interrupted by user/i.test(line)
    if (!hit) continue
    hits.push({ timestamp: eventTimestampMs(obj), rawLine: line })
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

function markInterrupted(statusFile, sessionId) {
  const status = readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const session = status.sessions && status.sessions[sessionId]
  if (!session || session.agentType !== 'claude' || session.endedAt) return false
  if (currentPhase(session) !== 'running') return false
  if (!findLatestClaudeInterrupt(session.transcriptPath, session.lastUpdated || session.startedAt)) return false

  const now = Date.now()
  const result = applySessionEvent(session, {
    type: AGENT_EVENTS.INTERRUPTED,
    source: 'transcript',
    timestamp: now,
    reason: 'Claude transcript recorded request interruption',
    details: CLAUDE_INTERRUPT_MARKER,
    force: false
  })
  if (!result.changed) return false

  status.sessions[sessionId] = session
  status.lastUpdated = now
  writeJsonAtomic(sessionFilePath(statusFile, sessionId), session)
  writeJsonAtomic(statusFile, status)
  return true
}

class ClaudeTranscriptWatchManager {
  constructor(statusFile, log) {
    this.statusFile = statusFile
    this.log = typeof log === 'function' ? log : () => {}
    this.watches = new Map()
    this.timers = new Map()
  }

  reconcile(status) {
    const desired = new Map()
    for (const [sessionId, session] of Object.entries((status && status.sessions) || {})) {
      if (!session || session.agentType !== 'claude' || session.endedAt) continue
      if (currentPhase(session) !== 'running') continue
      if (!session.transcriptPath) continue
      desired.set(sessionId, session.transcriptPath)
    }

    for (const [sessionId, watch] of Array.from(this.watches.entries())) {
      if (desired.get(sessionId) === watch.transcriptPath) continue
      this.closeOne(sessionId)
    }

    for (const [sessionId, transcriptPath] of desired.entries()) {
      if (this.watches.has(sessionId)) continue
      this.openOne(sessionId, transcriptPath)
    }
  }

  openOne(sessionId, transcriptPath) {
    try {
      const watcher = fs.watch(transcriptPath, { persistent: false }, () => {
        this.scheduleCheck(sessionId)
      })
      watcher.on('error', error => {
        this.log(`claude transcript watch error session=${sessionId}: ${error.message}`)
        this.closeOne(sessionId)
      })
      this.watches.set(sessionId, { watcher, transcriptPath })
    } catch (error) {
      this.log(`claude transcript watch unavailable session=${sessionId}: ${error.message}`)
    }
  }

  scheduleCheck(sessionId) {
    if (this.timers.has(sessionId)) clearTimeout(this.timers.get(sessionId))
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      try {
        if (markInterrupted(this.statusFile, sessionId)) this.closeOne(sessionId)
      } catch (error) {
        this.log(`claude transcript watch check failed session=${sessionId}: ${error.message}`)
      }
    }, 50)
    if (timer && typeof timer.unref === 'function') timer.unref()
    this.timers.set(sessionId, timer)
  }

  closeOne(sessionId) {
    const timer = this.timers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.timers.delete(sessionId)
    const watch = this.watches.get(sessionId)
    if (watch) {
      try { watch.watcher.close() } catch (_) {}
    }
    this.watches.delete(sessionId)
  }

  close() {
    for (const sessionId of Array.from(this.watches.keys())) this.closeOne(sessionId)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

module.exports = {
  CLAUDE_INTERRUPT_MARKER,
  findLatestClaudeInterrupt,
  markInterrupted,
  ClaudeTranscriptWatchManager
}
