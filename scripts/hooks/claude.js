#!/usr/bin/env node
// tmux-scout Claude Code hook
// Tracks Claude session status with tmux pane mapping

const fs = require('fs')
const path = require('path')
const os = require('os')
const { applySessionEvent } = require('../lib/session-state')
const { terminalContext } = require('../lib/terminal-context')

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

  const lifecycleEvent = updates.lifecycleEvent || (updates.lastEvent ? {
    type: updates.lastEvent.type,
    source: 'hook',
    stateSource: updates.stateSource || 'claude-hooks',
    timestamp: updates.lastEvent.timestamp,
    details: updates.lastEvent.details,
    attentionReason: updates.needsAttention || null,
    pendingToolUse: updates.pendingToolUse,
    activeTool: updates.activeTool,
    endedAt: updates.endedAt,
    force: true
  } : null)
  delete updates.lifecycleEvent

  const lifecycleFields = new Set(['status', 'phase', 'needsAttention', 'pendingToolUse', 'activeTool', 'endedAt', 'stateSource', 'lastEvent'])
  for (const [key, value] of Object.entries(updates)) {
    if (lifecycleEvent && lifecycleFields.has(key)) continue
    if (value !== undefined) session[key] = value
  }
  session.lastUpdated = Date.now()
  if (lifecycleEvent) applySessionEvent(session, lifecycleEvent)
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

function isQuestionTool(toolName) {
  return toolName === 'AskUserQuestion' || toolName === 'mcp__conductor__AskUserQuestion'
}

function isPlanApprovalTool(toolName) {
  return toolName === 'ExitPlanMode'
}

function eventBase(data, now, tmuxPane, pid) {
  return Object.assign({
    workingDirectory: data.cwd,
    transcriptPath: data.transcript_path,
    tmuxPane,
    pid,
    lastHookAt: now
  }, terminalContext(pid))
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

  const { session_id, hook_event_name, tool_name, tool_input, prompt, source, reason } = data

  if (!session_id) {
    process.exit(0)
  }

  const now = Date.now()
  const tmuxPane = process.env.TMUX_PANE || null
  const pid = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null

  switch (hook_event_name) {
    case 'SessionStart':
      if (source === 'compact') {
        updateSession(session_id, eventBase(data, now, tmuxPane, pid))
        break
      }
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'idle',
        startedAt: now,
        pendingToolUse: null,
        activeTool: null,
        lastEvent: { type: 'session_start', timestamp: now, details: source }
      })))
      break

    case 'UserPromptSubmit': {
      let title = undefined
      let cleanPrompt = ''
      if (prompt) {
        cleanPrompt = String(prompt)
        cleanPrompt = cleanPrompt.replace(/<system[-_]?(?:instruction|reminder)[^>]*>[\s\S]*?<\/system[-_]?(?:instruction|reminder)>/gi, '')
        cleanPrompt = cleanPrompt.replace(/^[\s\n]*<[^>]+>[\s\S]*?<\/[^>]+>[\s\n]*/gi, '')
        cleanPrompt = cleanPrompt.trim()
        if (cleanPrompt) {
          title = cleanPrompt.slice(0, 100).split('\n')[0].trim()
        }
      }
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        sessionTitle: title,
        lastUserPrompt: cleanPrompt || undefined,
        pendingToolUse: null,
        activeTool: null,
        lastEvent: { type: 'prompt_submit', timestamp: now, details: title }
      })))
      break
    }

    case 'PreToolUse': {
      const toolDetails = getToolDetails(tool_name, tool_input)
      const attentionTools = ['ExitPlanMode', 'AskUserQuestion', 'mcp__conductor__AskUserQuestion']
      const needsAttention = attentionTools.includes(tool_name)
      const questionTool = isQuestionTool(tool_name)
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        needsAttention: needsAttention ? tool_name : null,
        pendingToolUse: { tool: tool_name || 'unknown', details: toolDetails, timestamp: now },
        activeTool: tool_name || 'unknown',
        lastEvent: { type: 'tool_use', timestamp: now, details: toolDetails },
        lifecycleEvent: needsAttention ? {
          type: questionTool ? 'question_asked' : 'permission_request',
          source: 'hook',
          stateSource: 'claude-hooks',
          timestamp: now,
          details: toolDetails,
          attentionReason: questionTool ? 'waiting for answer' : 'waiting for approval',
          pendingToolUse: { tool: tool_name || 'unknown', details: toolDetails, timestamp: now },
          activeTool: tool_name || 'unknown',
          force: true
        } : undefined,
      })))
      break
    }

    case 'PermissionRequest': {
      const toolDetails = getToolDetails(tool_name, tool_input)
      const questionTool = isQuestionTool(tool_name)
      const planTool = isPlanApprovalTool(tool_name)
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        needsAttention: questionTool ? 'waiting for answer' : (planTool ? 'waiting for plan approval' : 'waiting for approval'),
        pendingToolUse: { tool: tool_name || 'unknown', details: toolDetails, timestamp: now },
        activeTool: tool_name || 'unknown',
        lastEvent: {
          type: questionTool ? 'question_asked' : 'permission_request',
          timestamp: now,
          details: toolDetails
        }
      })))
      break
    }

    case 'PostToolUse':
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        pendingToolUse: null,
        activeTool: null,
        lastEvent: { type: 'post_tool_use', timestamp: now },
      })))
      break

    case 'PostToolUseFailure': {
      const toolDetails = getToolDetails(tool_name, tool_input)
      const error = data.error || data.error_message || data.message || data.reason
      const details = error ? `${toolDetails} failed: ${String(error).slice(0, 80)}` : `${toolDetails} failed`
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        lastToolError: error || true,
        lastEvent: { type: 'post_tool_use_failure', timestamp: now, details }
      })))
      break
    }

    case 'Stop':
      updateSession(session_id, Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'completed',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        lastAssistantMessage: data.last_assistant_message,
        lastEvent: { type: 'stop', timestamp: now },
      }))
      break

    case 'StopFailure':
      updateSession(session_id, Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'completed',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        error: data.error || data.error_type || 'stop_failure',
        errorDetail: data.error_details || data.error_detail || data.message || data.reason,
        lastEvent: {
          type: 'stop_failure',
          timestamp: now,
          details: data.error_details || data.error_detail || data.error || data.message || data.reason
        }
      }))
      break

    case 'SubagentStart':
      updateSession(session_id, {
        lastEvent: { type: 'subagent_start', timestamp: now },
        tmuxPane,
        pid
      })
      break

    case 'SubagentStop':
      updateSession(session_id, {
        lastEvent: { type: 'subagent_stop', timestamp: now },
        tmuxPane,
        pid
      })
      break

    case 'Notification':
      updateSession(session_id, {
        lastNotification: data.message || data.notification || data.title || null,
        lastEvent: {
          type: 'notification',
          timestamp: now,
          details: data.message || data.notification || data.title || null
        },
        tmuxPane,
        pid
      })
      break

    case 'PreCompact':
      updateSession(session_id, {
        lastCompactAt: now,
        lastCompactReason: data.trigger || data.reason || null,
        lastEvent: {
          type: 'pre_compact',
          timestamp: now,
          details: data.trigger || data.reason || null
        },
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
        activeTool: null,
        lastEvent: { type: 'session_end', timestamp: now, details: reason },
        tmuxPane,
        pid
      })
      break
  }
}

main().catch(() => process.exit(0))
