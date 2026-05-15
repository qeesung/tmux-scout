#!/usr/bin/env node
// tmux-scout Codex hook
// Handles modern Codex event hooks from stdin and legacy notify payloads from argv.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { createHookContext, readStdin } = require('../lib/hook-adapter')
const { classifyCodexSession, cleanCodexPrompt, isHiddenCodexSession } = require('../lib/codex-session-classifier')
const { AGENT_EVENTS } = require('../lib/agent-events')

const hookContext = createHookContext({
  agentType: 'codex',
  defaultStateSource: 'codex-hooks',
  lifecycleForce: updates => updates.stateSource !== 'notify',
  baseFields: data => ({
    endedAt: null,
    threadId: data.thread_id || data.session_id || data['thread-id'],
    stateSource: data.hook_event_name ? 'codex-hooks' : 'notify',
    ...codexSessionMetaFields(data)
  })
})

const STATUS_DIR = hookContext.paths.statusDir
const ORIGINAL_NOTIFY_FILE = path.join(STATUS_DIR, 'codex-original-notify.json')

function readSession(sessionId) {
  return hookContext.readSession(sessionId)
}

function updateSession(sessionId, updates) {
  hookContext.updateSession(sessionId, updates)
}

function baseUpdates(data, now) {
  return hookContext.baseUpdates(data, now)
}

function pendingResolutionType(pending) {
  return pending && pending.type === 'question'
    ? AGENT_EVENTS.QUESTION_ANSWERED
    : AGENT_EVENTS.PERMISSION_RESOLVED
}

function resolvePendingInteraction(sessionId, data, now, details) {
  const session = readSession(sessionId)
  const pending = session && session.pendingInteraction
  if (!pending) return
  const eventType = pendingResolutionType(pending)
  updateSession(sessionId, Object.assign({}, baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastTurnId: data.turn_id,
    lastEvent: {
      type: eventType,
      timestamp: now,
      details: details || pending.details || pending.reason,
      turnId: data.turn_id,
      rawEventName: `${data.hook_event_name || 'hook'}:${eventType}`
    }
  }))
}

function extractSessionPrompt(inputMessages) {
  if (!inputMessages || !Array.isArray(inputMessages)) return undefined
  for (const msg of inputMessages) {
    if (msg.role === 'user' && msg.content) {
      if (typeof msg.content === 'string') {
        return cleanPrompt(msg.content)
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part.type === 'text' || part.type === 'input_text') && part.text) {
            return cleanPrompt(part.text)
          }
        }
      }
    }
  }
  return undefined
}

function cleanPrompt(prompt) {
  return cleanCodexPrompt(prompt)
}

function titleFromPrompt(prompt) {
  const clean = cleanPrompt(prompt)
  return clean ? clean.slice(0, 100).split('\n')[0].trim() : undefined
}

function getToolDetails(toolName, toolInput) {
  let toolDetails = toolName || 'unknown'
  if (toolInput && typeof toolInput === 'object') {
    if (toolInput.command) {
      toolDetails += ': ' + String(toolInput.command).slice(0, 80)
    } else if (toolInput.file_path) {
      toolDetails += ': ' + path.basename(String(toolInput.file_path))
    } else if (toolInput.description) {
      toolDetails += ': ' + String(toolInput.description).slice(0, 80)
    } else if (toolInput.url) {
      toolDetails += ': ' + String(toolInput.url).slice(0, 80)
    } else if (toolInput.query) {
      toolDetails += ': ' + String(toolInput.query).slice(0, 80)
    } else {
      for (const value of Object.values(toolInput)) {
        if (typeof value === 'string' && value.length > 0) {
          toolDetails += ': ' + value.slice(0, 80)
          break
        }
      }
    }
  }
  return toolDetails
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
  } catch (_) {}
}

function normalizeSignal(value) {
  return String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_')
}

const TRUE_SIGNALS = new Set(['1', 'true', 'yes', 'on'])
const INPUT_WAIT_SIGNALS = new Set([
  'waiting_for_input',
  'waiting_for_answer',
  'requires_input',
  'requires_user_input',
  'needs_input',
  'needs_user_input',
  'input_required',
  'user_input_required',
  'input_requested',
  'user_input_requested',
  'awaiting_input',
  'awaiting_user_input',
  'awaiting_answer',
  AGENT_EVENTS.QUESTION_ASKED
])

function isTrueSignal(value) {
  if (value === true) return true
  if (value === false || value === null || value === undefined) return false
  return TRUE_SIGNALS.has(normalizeSignal(value))
}

function hasExplicitInputWaitSignal(data) {
  const flagFields = [
    'waiting_for_input',
    'waiting_for_answer',
    'requires_input',
    'requires_user_input',
    'needs_input',
    'needs_user_input',
    'input_required',
    'user_input_required',
    AGENT_EVENTS.QUESTION_ASKED
  ]
  for (const field of flagFields) {
    if (isTrueSignal(data[field])) return true
  }

  for (const field of ['reason', 'stop_reason', 'next_action', 'status', 'prompt_type', 'input_mode']) {
    if (INPUT_WAIT_SIGNALS.has(normalizeSignal(data[field]))) return true
  }

  return false
}

function looksLikeAssistantQuestion(message) {
  if (typeof message !== 'string') return false
  const text = message.trim()
  if (!text) return false
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const tailLines = lines.slice(-6)
  if (tailLines.length === 0) return false

  const promptQuestionRe = /(which|choose|pick|select|confirm|do you want|would you like|should i|shall i|what should i|what would you like|what do you want|请选择|请确认|是否|要我|需要.*(?:选择|输入|回答))/i
  const optionRe = /^(?:[-*]|\d+[.)、．])\s+\S/

  function isPromptQuestion(line) {
    if (optionRe.test(line)) return false
    return /[?？]/.test(line) && promptQuestionRe.test(line)
  }

  const lastLine = tailLines[tailLines.length - 1]
  if (isPromptQuestion(lastLine)) return true

  for (let i = 0; i < tailLines.length - 1; i++) {
    if (!isPromptQuestion(tailLines[i])) continue
    if (tailLines.slice(i + 1).some(line => optionRe.test(line))) return true
  }

  return false
}

function codexStopWantsAnswer(data, lastAssistantMessage) {
  if (hasExplicitInputWaitSignal(data)) {
    return true
  }
  return looksLikeAssistantQuestion(lastAssistantMessage)
}

function isBypassPermission(data) {
  return data.permission_mode === 'bypassPermissions'
}

function readFirstLineBounded(filePath, maxBytes = 64 * 1024) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const chunks = []
    const buffer = Buffer.alloc(Math.min(4096, maxBytes))
    let total = 0

    while (total < maxBytes) {
      const toRead = Math.min(buffer.length, maxBytes - total)
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, total)
      if (bytesRead <= 0) break

      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(10)
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline))
        return Buffer.concat(chunks).toString('utf-8')
      }

      chunks.push(Buffer.from(chunk))
      total += bytesRead
    }

    if (total < maxBytes) {
      return Buffer.concat(chunks).toString('utf-8')
    }
  } catch (_) {
    return null
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
  return null
}

function readTranscriptSessionMeta(transcriptPath) {
  if (!transcriptPath) return null
  try {
    const firstLine = readFirstLineBounded(transcriptPath)
    if (!firstLine.trim()) return null
    const obj = JSON.parse(firstLine)
    return obj && obj.type === 'session_meta' && obj.payload ? obj.payload : null
  } catch (_) {
    return null
  }
}

function codexSourceLabel(source) {
  if (!source) return undefined
  if (typeof source === 'string') return source
  if (typeof source !== 'object' || Array.isArray(source)) return undefined
  if (typeof source.internal === 'string') return `internal:${source.internal || 'session'}`
  if (typeof source.subagent === 'string') return `subagent:${source.subagent}`
  if (source.subagent && typeof source.subagent === 'object') {
    if (source.subagent.thread_spawn) return 'subagent:thread_spawn'
    if (source.subagent.other) return `subagent:${source.subagent.other}`
    return 'subagent'
  }
  const keys = Object.keys(source).filter(Boolean)
  return keys.length > 0 ? keys.join(',') : undefined
}

function codexSessionMetaFields(data) {
  const meta = data && (data._session_meta || readTranscriptSessionMeta(data.transcript_path))
  if (!meta || typeof meta !== 'object') return {}
  const source = meta.source && typeof meta.source === 'object' && !Array.isArray(meta.source)
    ? meta.source
    : null
  const subagent = source && source.subagent && typeof source.subagent === 'object' && !Array.isArray(source.subagent)
    ? source.subagent
    : null
  const threadSpawn = subagent && subagent.thread_spawn && typeof subagent.thread_spawn === 'object'
    ? subagent.thread_spawn
    : null
  const fields = {
    codexSessionId: meta.id,
    codexSessionSource: codexSourceLabel(meta.source),
    codexForkedFromId: meta.forked_from_id || (threadSpawn && threadSpawn.parent_thread_id),
    codexAgentNickname: meta.agent_nickname || (threadSpawn && threadSpawn.agent_nickname)
  }
  const compact = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') compact[key] = value
  }
  return compact
}

function classifyHookPayload(data) {
  const prompt = data.prompt || data.prompt_preview || ''
  const sessionMeta = data._session_meta || readTranscriptSessionMeta(data.transcript_path)
  return classifyCodexSession({ prompt, sessionMeta })
}

function markHiddenSession(sessionId, base, classification, now, details) {
  const updates = Object.assign({}, base, {
    isHiddenFromScout: true,
    hiddenReason: classification.reason || 'codex-hidden-session',
    hiddenAt: now,
    isInternalCodexSession: Boolean(classification.isInternal),
    isCodexSubagent: Boolean(classification.isSubagent),
    parentSessionId: classification.parentSessionId || undefined,
    subagentDepth: classification.subagentDepth,
    subagentNickname: classification.subagentNickname || undefined,
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    endedAt: now,
    lifecycleEvent: {
      type: AGENT_EVENTS.SESSION_END,
      source: 'hook',
      stateSource: base.stateSource,
      timestamp: now,
      endedAt: now,
      reason: classification.reason || 'codex-hidden-session',
      details: details || classification.reason || 'codex-hidden-session',
      force: true
    }
  })
  updateSession(sessionId, updates)

  if (classification.isSubagent && classification.parentSessionId) {
    upsertParentSubagent(classification.parentSessionId, sessionId, {
      nickname: classification.subagentNickname || 'subagent',
      depth: classification.subagentDepth,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }
}

function normalizeSubagents(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function upsertParentSubagent(parentSessionId, childSessionId, patch) {
  if (!parentSessionId || !childSessionId) return false
  const parent = readSession(parentSessionId)
  if (!parent || isHiddenCodexSession(parent)) return false

  const activeSubagents = normalizeSubagents(parent.activeSubagents)
  const index = activeSubagents.findIndex(item => item && item.agentId === childSessionId)
  const existing = index >= 0 ? activeSubagents[index] : { agentId: childSessionId }
  const nextInfo = Object.assign({}, existing, patch, {
    agentId: childSessionId,
    updatedAt: patch.updatedAt || Date.now()
  })

  if (index >= 0) activeSubagents[index] = nextInfo
  else activeSubagents.push(nextInfo)

  updateSession(parentSessionId, {
    activeSubagents,
    lastSubagentUpdatedAt: nextInfo.updatedAt
  })
  return true
}

function removeParentSubagent(parentSessionId, childSessionId, now) {
  if (!parentSessionId || !childSessionId) return false
  const parent = readSession(parentSessionId)
  if (!parent || !Array.isArray(parent.activeSubagents)) return false
  const activeSubagents = parent.activeSubagents.filter(item => item && item.agentId !== childSessionId)
  if (activeSubagents.length === parent.activeSubagents.length) return false
  updateSession(parentSessionId, {
    activeSubagents,
    lastSubagentUpdatedAt: now
  })
  return true
}

function updateParentSubagentFromHiddenEvent(session, data, now) {
  if (!session || !session.isCodexSubagent || !session.parentSessionId) return
  const eventName = data.hook_event_name
  const childSessionId = session.sessionId || data.session_id || data.thread_id
  const base = {
    nickname: session.subagentNickname || data.agent_nickname || 'subagent',
    depth: session.subagentDepth,
    updatedAt: now
  }

  if (eventName === 'Stop' || eventName === 'SessionEnd') {
    removeParentSubagent(session.parentSessionId, childSessionId, now)
    return
  }

  if (eventName === 'UserPromptSubmit') {
    const title = titleFromPrompt(data.prompt || data.prompt_preview)
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      title: title || session.sessionTitle,
      phase: 'running'
    }))
    return
  }

  if (eventName === 'PreToolUse' || eventName === 'PermissionRequest') {
    const toolName = data.tool_name || 'unknown'
    const details = getToolDetails(toolName, data.tool_input)
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      phase: eventName === 'PermissionRequest' ? 'waitingForApproval' : 'running',
      lastToolActivity: details
    }))
    return
  }

  if (eventName === 'PostToolUse') {
    const toolName = data.tool_name || 'unknown'
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      phase: 'running',
      lastToolActivity: `${toolName} done`
    }))
    return
  }

  if (eventName === 'PostToolUseFailure') {
    const toolName = data.tool_name || 'unknown'
    const error = data.error || data.error_message || data.message || 'failed'
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      phase: 'running',
      lastToolActivity: `${toolName} failed: ${String(error).slice(0, 80)}`
    }))
    return
  }

  if (eventName === 'SessionStart') {
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      title: data.session_title || session.sessionTitle,
      phase: 'running',
      startedAt: session.startedAt || now
    }))
  }
}

function handleModernHook(data) {
  const eventName = data.hook_event_name
  const sessionId = data.session_id || data.thread_id || data['thread-id']
  if (!eventName || !sessionId) return

  const now = Date.now()
  const base = baseUpdates(data, now)
  const existing = readSession(sessionId)
  if (isHiddenCodexSession(existing)) {
    updateParentSubagentFromHiddenEvent(existing, data, now)
    return
  }

  const classification = classifyHookPayload(data)
  if (classification.hidden) {
    markHiddenSession(sessionId, base, classification, now, eventName)
    return
  }

  switch (eventName) {
    case 'SessionStart': {
      updateSession(sessionId, Object.assign({}, base, {
        status: 'idle',
        startedAt: now,
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        sessionTitle: data.session_title || undefined,
        lastEvent: { type: AGENT_EVENTS.SESSION_START, timestamp: now, details: data.source }
      }))
      break
    }

    case 'UserPromptSubmit': {
      resolvePendingInteraction(sessionId, data, now, 'user prompt submitted')
      const title = titleFromPrompt(data.prompt || data.prompt_preview)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        sessionTitle: title,
        lastUserPrompt: cleanPrompt(data.prompt || data.prompt_preview || ''),
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: now, details: title, turnId: data.turn_id }
      }))
      break
    }

    case 'PreToolUse': {
      const toolName = data.tool_name || 'unknown'
      const details = getToolDetails(toolName, data.tool_input)
      resolvePendingInteraction(sessionId, data, now, details)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: null,
        pendingToolUse: { tool: toolName, details, timestamp: now },
        activeTool: toolName,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.TOOL_USE, timestamp: now, details, turnId: data.turn_id }
      }))
      break
    }

    case 'PermissionRequest': {
      if (isBypassPermission(data)) {
        resolvePendingInteraction(sessionId, data, now, 'permission bypassed')
        updateSession(sessionId, Object.assign({}, base, {
          lastTurnId: data.turn_id,
          lastEvent: { type: AGENT_EVENTS.PERMISSION_BYPASSED, timestamp: now, turnId: data.turn_id }
        }))
        break
      }
      const toolName = data.tool_name || 'unknown'
      const details = getToolDetails(toolName, data.tool_input)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: 'waiting for approval',
        pendingToolUse: { tool: toolName, details, timestamp: now },
        activeTool: toolName,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.PERMISSION_REQUEST, timestamp: now, details, turnId: data.turn_id }
      }))
      break
    }

    case 'PostToolUse': {
      const toolName = data.tool_name || 'unknown'
      resolvePendingInteraction(sessionId, data, now, toolName)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.POST_TOOL_USE, timestamp: now, details: toolName, turnId: data.turn_id }
      }))
      break
    }

    case 'Stop': {
      const lastAssistantMessage = typeof data.last_assistant_message === 'string'
        ? data.last_assistant_message
        : ''
      const wantsAnswer = codexStopWantsAnswer(data, lastAssistantMessage)
      if (!wantsAnswer) resolvePendingInteraction(sessionId, data, now, lastAssistantMessage)
      updateSession(sessionId, Object.assign({}, base, {
        status: wantsAnswer ? 'working' : 'completed',
        needsAttention: wantsAnswer ? 'waiting for answer' : null,
        pendingToolUse: null,
        activeTool: null,
        sessionTitle: data.session_title || undefined,
        lastAssistantMessage,
        lastTurnId: data.turn_id,
        lastEvent: {
          type: wantsAnswer ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.STOP,
          timestamp: now,
          details: lastAssistantMessage.slice(0, 100),
          turnId: data.turn_id
        }
      }))
      break
    }
  }
}

function handleLegacyNotify(data) {
  const {
    type,
    'thread-id': threadId,
    'turn-id': turnId,
    cwd,
    'input-messages': inputMessages,
    'last-assistant-message': lastAssistantMessage
  } = data

  if (type !== 'agent-turn-complete') return

  const sessionId = threadId || 'unknown'
  const now = Date.now()
  const prompt = extractSessionPrompt(inputMessages)
  let title = titleFromPrompt(prompt)
  const classification = classifyCodexSession({ prompt: prompt || '' })
  if (classification.hidden) {
    markHiddenSession(sessionId, baseUpdates({ cwd, 'thread-id': threadId }, now), classification, now, type)
    return
  }

  if (!title && lastAssistantMessage && typeof lastAssistantMessage === 'string') {
    title = lastAssistantMessage.slice(0, 100).split('\n')[0].trim()
  }

  const details = typeof lastAssistantMessage === 'string'
    ? lastAssistantMessage.slice(0, 100)
    : ''

  updateSession(sessionId, Object.assign({}, baseUpdates({
    cwd,
    'thread-id': threadId
  }, now), {
    status: 'completed',
    endedAt: null,
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    sessionTitle: title,
    threadId,
    lastEvent: {
      type: AGENT_EVENTS.TURN_COMPLETE,
      timestamp: now,
      details,
      turnId
    }
  }))
}

async function main() {
  const jsonArg = process.argv[2]

  if (jsonArg) {
    adapter.handleArg(jsonArg)
    await hookContext.flush()
    return
  }

  const input = await readStdin()
  if (!input.trim()) return

  let data
  try {
    data = JSON.parse(input)
  } catch (_) {
    return
  }

  adapter.handlePayload(data)
  await hookContext.flush()
}

const adapter = {
  agentId: 'codex',
  handlePayload(data) {
    if (data && data.hook_event_name) {
      handleModernHook(data)
    } else {
      handleLegacyNotify(data)
    }
  },
  handleArg(jsonArg) {
    forwardToOriginalNotify(jsonArg)
    try {
      handleLegacyNotify(JSON.parse(jsonArg))
    } catch (_) {}
  }
}

module.exports = {
  adapter,
  handleModernHook,
  handleLegacyNotify,
  codexStopWantsAnswer,
  looksLikeAssistantQuestion,
  codexSessionMetaFields
}

if (require.main === module) {
  main().catch(() => process.exit(0))
}
