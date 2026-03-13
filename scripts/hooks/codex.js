#!/usr/bin/env node
// tmux-scout Codex notify hook
// Tracks Codex session status with tmux pane mapping

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const STATUS_DIR = path.join(os.homedir(), '.tmux-scout')
const STATUS_FILE = path.join(STATUS_DIR, 'status.json')
const SESSIONS_DIR = path.join(STATUS_DIR, 'sessions')
const ORIGINAL_NOTIFY_FILE = path.join(STATUS_DIR, 'codex-original-notify.json')

function ensureDirs() {
  if (!fs.existsSync(STATUS_DIR)) {
    fs.mkdirSync(STATUS_DIR, { recursive: true })
  }
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

function writeStatusAtomic(filePath, data) {
  const tempPath = filePath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (e) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw e
  }
}

function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'))
    }
  } catch (e) {}
  return { version: 1, lastUpdated: Date.now(), sessions: {} }
}

function updateSession(sessionId, updates) {
  ensureDirs()

  const sessionFile = path.join(SESSIONS_DIR, sessionId.replace(/[/\\:]/g, '_') + '.json')
  let session = { sessionId, agentType: 'codex', startedAt: Date.now() }
  try {
    if (fs.existsSync(sessionFile)) {
      session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))
    }
  } catch (e) {}

  Object.assign(session, updates, { lastUpdated: Date.now() })
  writeStatusAtomic(sessionFile, session)

  const status = readStatus()
  status.sessions[sessionId] = session
  status.lastUpdated = Date.now()

  // Clean up old sessions (older than 24h)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [id, sess] of Object.entries(status.sessions)) {
    if (sess.endedAt && sess.endedAt < cutoff) {
      delete status.sessions[id]
      try {
        fs.unlinkSync(path.join(SESSIONS_DIR, id.replace(/[/\\:]/g, '_') + '.json'))
      } catch (e) {}
    }
  }

  writeStatusAtomic(STATUS_FILE, status)
}

function extractSessionTitle(inputMessages) {
  if (!inputMessages || !Array.isArray(inputMessages)) return undefined
  for (const msg of inputMessages) {
    if (msg.role === 'user' && msg.content) {
      if (typeof msg.content === 'string') {
        return msg.content.slice(0, 100).split('\n')[0].trim()
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part.type === 'text' || part.type === 'input_text') && part.text) {
            return part.text.slice(0, 100).split('\n')[0].trim()
          }
        }
      }
    }
  }
  return undefined
}

function forwardToOriginalNotify(jsonArg) {
  try {
    if (!fs.existsSync(ORIGINAL_NOTIFY_FILE)) return
    const saved = JSON.parse(fs.readFileSync(ORIGINAL_NOTIFY_FILE, 'utf-8'))
    if (!saved || !Array.isArray(saved.notify) || saved.notify.length === 0) return
    const [command, ...args] = saved.notify
    spawnSync(command, [...args, jsonArg], {
      stdio: 'ignore',
      timeout: 30000
    })
  } catch (e) {}
}

function main() {
  const jsonArg = process.argv[2]

  if (!jsonArg) {
    forwardToOriginalNotify('')
    process.exit(0)
  }

  // Always forward first
  forwardToOriginalNotify(jsonArg)

  let data
  try {
    data = JSON.parse(jsonArg)
  } catch (e) {
    process.exit(0)
  }

  const {
    type,
    'thread-id': threadId,
    'turn-id': turnId,
    cwd,
    'input-messages': inputMessages,
    'last-assistant-message': lastAssistantMessage
  } = data

  if (type !== 'agent-turn-complete') {
    process.exit(0)
  }

  const sessionId = threadId || 'unknown'
  const now = Date.now()
  const tmuxPane = process.env.TMUX_PANE || null
  const pid = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null

  let title = extractSessionTitle(inputMessages)

  // Fallback: use last assistant message as title if no user message found
  if (!title && lastAssistantMessage && typeof lastAssistantMessage === 'string') {
    title = lastAssistantMessage.slice(0, 100).split('\n')[0].trim()
  }

  let details = ''
  if (lastAssistantMessage) {
    details = typeof lastAssistantMessage === 'string'
      ? lastAssistantMessage.slice(0, 100)
      : ''
  }

  updateSession(sessionId, {
    agentType: 'codex',
    status: 'completed',
    endedAt: null,
    needsAttention: null,
    pendingToolUse: null,
    workingDirectory: cwd,
    sessionTitle: title,
    threadId,
    tmuxPane,
    pid,
    lastEvent: {
      type: 'turn_complete',
      timestamp: now,
      details,
      turnId
    }
  })
}

try {
  main()
} catch (e) {
  process.exit(0)
}
