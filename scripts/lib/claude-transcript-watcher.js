// fs.watch-backed fast path for Claude transcript interruption markers.

const fs = require('fs')
const path = require('path')
const { applySessionEvent, currentPhase } = require('./session-state')
const { readFileTail, splitJsonlLines } = require('./jsonl-tail-reader')
const { AGENT_EVENTS } = require('./agent-events')

const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user]'
// Also covers the '[Request interrupted by user for tool use]' variant via the
// shared prefix + closing ']'.
const CLAUDE_INTERRUPT_MARKER_PREFIX = '[Request interrupted by user'
const CLAUDE_TRANSCRIPT_TAIL_BYTES = 128 * 1024
const ATTACH_RETRY_INTERVAL_MS = 250
const ATTACH_RETRY_MAX_ATTEMPTS = 24

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

function readFileRange(filePath, start, endExclusive) {
  const length = Math.max(0, endExclusive - start)
  if (length === 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = fs.readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf-8', 0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
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

// Strict structural match (same rule as sync.js): the marker is a `type:'user'`
// message whose content carries a text block starting with the marker prefix and
// ending ']'. Matching the phrase anywhere false-positives when a prompt/assistant
// message merely quotes it.
function isInterruptMarkerText(value) {
  const text = String(value == null ? '' : value).trim()
  return text.startsWith(CLAUDE_INTERRUPT_MARKER_PREFIX) && text.endsWith(']')
}

function isInterruptMarkerObject(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'user') return false
  const message = obj.message
  if (!message || typeof message !== 'object') return false
  const content = message.content
  if (Array.isArray(content)) {
    return content.some(block =>
      block && typeof block === 'object' &&
      block.type === 'text' && typeof block.text === 'string' &&
      isInterruptMarkerText(block.text))
  }
  if (typeof content === 'string') return isInterruptMarkerText(content)
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
    const hit = obj ? isInterruptMarkerObject(obj) : false
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
    this.retryTimers = new Map()
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
    for (const [sessionId, retry] of Array.from(this.retryTimers.entries())) {
      if (desired.get(sessionId) === retry.transcriptPath) continue
      this.closeOne(sessionId)
    }

    for (const [sessionId, transcriptPath] of desired.entries()) {
      if (this.watches.has(sessionId)) continue
      const retry = this.retryTimers.get(sessionId)
      if (retry && retry.transcriptPath === transcriptPath) continue
      this.openOne(sessionId, transcriptPath)
    }
  }

  openOne(sessionId, transcriptPath) {
    this.tryOpenOne(sessionId, transcriptPath, 0)
  }

  tryOpenOne(sessionId, transcriptPath, attempt) {
    let initialOffset = 0
    try {
      initialOffset = fs.statSync(transcriptPath).size
    } catch (_) {
      initialOffset = 0
    }
    if (attempt > 0) initialOffset = 0

    try {
      const watcher = fs.watch(transcriptPath, { persistent: false }, () => {
        this.scheduleCheck(sessionId)
      })
      watcher.on('error', error => {
        this.log(`claude transcript watch error session=${sessionId}: ${error.message}`)
        this.closeOne(sessionId)
      })
      this.watches.set(sessionId, {
        watcher,
        transcriptPath,
        lastOffset: initialOffset,
        partialLine: ''
      })
      if (attempt > 0) this.scheduleCheck(sessionId)
    } catch (error) {
      if (error && error.code === 'ENOENT' && attempt + 1 < ATTACH_RETRY_MAX_ATTEMPTS) {
        const timer = setTimeout(() => {
          const retry = this.retryTimers.get(sessionId)
          if (!retry || retry.transcriptPath !== transcriptPath) return
          this.retryTimers.delete(sessionId)
          this.tryOpenOne(sessionId, transcriptPath, attempt + 1)
        }, ATTACH_RETRY_INTERVAL_MS)
        if (timer && typeof timer.unref === 'function') timer.unref()
        this.retryTimers.set(sessionId, { timer, transcriptPath })
        return
      }
      this.log(`claude transcript watch unavailable session=${sessionId}: ${error.message}`)
    }
  }

  scanWatch(sessionId) {
    const watch = this.watches.get(sessionId)
    if (!watch) return false

    let stat
    try {
      stat = fs.statSync(watch.transcriptPath)
    } catch (_) {
      return false
    }

    if (!Number.isFinite(watch.lastOffset) || stat.size < watch.lastOffset) {
      watch.lastOffset = 0
      watch.partialLine = ''
    }
    if (stat.size === watch.lastOffset) return false

    const chunk = readFileRange(watch.transcriptPath, watch.lastOffset, stat.size)
    watch.lastOffset = stat.size
    const text = String(watch.partialLine || '') + chunk
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) {
      watch.partialLine = text
      return false
    }

    const complete = text.slice(0, lastNewline + 1)
    watch.partialLine = text.slice(lastNewline + 1)
    for (const line of splitJsonlLines(complete)) {
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch (_) {}
      if (obj ? isInterruptMarkerObject(obj) : false) {
        return true
      }
    }
    return false
  }

  scheduleCheck(sessionId) {
    if (this.timers.has(sessionId)) clearTimeout(this.timers.get(sessionId))
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      try {
        if (this.scanWatch(sessionId) && markInterrupted(this.statusFile, sessionId)) {
          this.closeOne(sessionId)
        }
      } catch (error) {
        this.log(`claude transcript watch check failed session=${sessionId}: ${error.message}`)
      }
    }, 50)
    if (timer && typeof timer.unref === 'function') timer.unref()
    this.timers.set(sessionId, timer)
  }

  closeOne(sessionId) {
    const retry = this.retryTimers.get(sessionId)
    if (retry) clearTimeout(retry.timer)
    this.retryTimers.delete(sessionId)
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
    for (const retry of this.retryTimers.values()) clearTimeout(retry.timer)
    this.retryTimers.clear()
  }
}

module.exports = {
  CLAUDE_INTERRUPT_MARKER,
  findLatestClaudeInterrupt,
  markInterrupted,
  ClaudeTranscriptWatchManager,
  ATTACH_RETRY_INTERVAL_MS,
  ATTACH_RETRY_MAX_ATTEMPTS
}
