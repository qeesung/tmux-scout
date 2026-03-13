#!/usr/bin/env node
// tmux-scout Claude Code hook
// Tracks Claude session status with tmux pane mapping

const fs = require('fs')
const path = require('path')
const os = require('os')

const STATUS_DIR = path.join(os.homedir(), '.tmux-scout')
const STATUS_FILE = path.join(STATUS_DIR, 'status.json')
const SESSIONS_DIR = path.join(STATUS_DIR, 'sessions')

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

function liveSessionState(updates) {
  return Object.assign({
    endedAt: null,
    needsAttention: null
  }, updates)
}

function updateSession(sessionId, updates) {
  ensureDirs()

  const sessionFile = path.join(SESSIONS_DIR, sessionId.replace(/[/\\:]/g, '_') + '.json')
  let session = { sessionId, agentType: 'claude', startedAt: Date.now() }
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

function getToolDetails(tool_name, tool_input) {
  let toolDetails = tool_name || 'unknown'
  if (tool_input && typeof tool_input === 'object') {
    if (tool_input.command) {
      toolDetails += ': ' + String(tool_input.command).slice(0, 50)
    } else if (tool_input.file_path) {
      toolDetails += ': ' + path.basename(String(tool_input.file_path))
    } else if (tool_input.pattern && tool_input.path) {
      toolDetails += ': ' + String(tool_input.pattern).slice(0, 30) + ' in ' + path.basename(String(tool_input.path))
    } else if (tool_input.pattern) {
      toolDetails += ': ' + String(tool_input.pattern).slice(0, 30)
    } else if (tool_input.url) {
      toolDetails += ': ' + String(tool_input.url).slice(0, 50)
    } else if (tool_input.query) {
      toolDetails += ': ' + String(tool_input.query).slice(0, 50)
    } else if (tool_input.prompt) {
      toolDetails += ': ' + String(tool_input.prompt).slice(0, 50)
    } else if (tool_input.description) {
      toolDetails += ': ' + String(tool_input.description).slice(0, 50)
    } else if (tool_input.notebook_path) {
      toolDetails += ': ' + path.basename(String(tool_input.notebook_path))
    } else if (tool_input.skill) {
      toolDetails += ': ' + String(tool_input.skill)
    } else {
      for (const [key, value] of Object.entries(tool_input)) {
        if (typeof value === 'string' && value.length > 0) {
          const displayValue = value.length > 40 ? value.slice(0, 40) + '...' : value
          toolDetails += ': ' + displayValue
          break
        }
      }
    }
  }
  return toolDetails
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
  }

  if (!input.trim()) {
    process.exit(0)
  }

  let data
  try {
    data = JSON.parse(input)
  } catch (e) {
    process.exit(0)
  }

  const { session_id, cwd, hook_event_name, tool_name, tool_input, prompt, source, reason } = data

  if (!session_id) {
    process.exit(0)
  }

  const now = Date.now()
  const tmuxPane = process.env.TMUX_PANE || null
  const pid = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null

  switch (hook_event_name) {
    case 'SessionStart':
      updateSession(session_id, liveSessionState({
        status: 'idle',
        workingDirectory: cwd,
        startedAt: now,
        pendingToolUse: null,
        tmuxPane,
        pid,
        lastEvent: { type: 'session_start', timestamp: now, details: source }
      }))
      break

    case 'UserPromptSubmit': {
      let title = undefined
      if (prompt) {
        let cleanPrompt = String(prompt)
        cleanPrompt = cleanPrompt.replace(/<system[-_]?(?:instruction|reminder)[^>]*>[\s\S]*?<\/system[-_]?(?:instruction|reminder)>/gi, '')
        cleanPrompt = cleanPrompt.replace(/^[\s\n]*<[^>]+>[\s\S]*?<\/[^>]+>[\s\n]*/gi, '')
        cleanPrompt = cleanPrompt.trim()
        if (cleanPrompt) {
          title = cleanPrompt.slice(0, 100).split('\n')[0].trim()
        }
      }
      updateSession(session_id, liveSessionState({
        status: 'working',
        workingDirectory: cwd,
        sessionTitle: title,
        pendingToolUse: null,
        tmuxPane,
        pid,
        lastEvent: { type: 'prompt_submit', timestamp: now, details: title }
      }))
      break
    }

    case 'PreToolUse': {
      const toolDetails = getToolDetails(tool_name, tool_input)
      const attentionTools = ['ExitPlanMode', 'AskUserQuestion', 'mcp__conductor__AskUserQuestion']
      const needsAttention = attentionTools.includes(tool_name)
      updateSession(session_id, liveSessionState({
        status: 'working',
        needsAttention: needsAttention ? tool_name : null,
        pendingToolUse: { tool: tool_name || 'unknown', details: toolDetails, timestamp: now },
        lastEvent: { type: 'tool_use', timestamp: now, details: toolDetails },
        tmuxPane,
        pid
      }))
      break
    }

    case 'PostToolUse':
      updateSession(session_id, liveSessionState({
        status: 'working',
        pendingToolUse: null,
        tmuxPane,
        pid
      }))
      break

    case 'Stop':
      updateSession(session_id, {
        status: 'completed',
        needsAttention: null,
        pendingToolUse: null,
        lastEvent: { type: 'stop', timestamp: now },
        tmuxPane,
        pid
      })
      break

    case 'SessionEnd':
      updateSession(session_id, {
        status: 'idle',
        endedAt: now,
        needsAttention: null,
        pendingToolUse: null,
        lastEvent: { type: 'session_end', timestamp: now, details: reason },
        tmuxPane,
        pid
      })
      break
  }
}

main().catch(() => process.exit(0))
