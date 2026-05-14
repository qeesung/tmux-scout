#!/usr/bin/env node
// Generic tmux-scout hook for CLI agents whose payloads are close to Claude-style events.

const fs = require('fs')
const path = require('path')
const { createHookContext, readStdin, liveSessionState } = require('../lib/hook-adapter')
const { AGENT_EVENTS } = require('../lib/agent-events')

function argValue(names) {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && i + 1 < args.length) return args[i + 1]
  }
  return null
}

const agentType = argValue(['--agent', '--source']) || 'agent'
const eventOverride = argValue(['--event'])

const hookContext = createHookContext({
  agentType,
  defaultStateSource: `${agentType}-hooks`,
  lifecycleForce: true,
  baseFields: data => ({
    stateSource: `${agentType}-hooks`,
    threadId: data.thread_id || data.session_id || data.sessionId || data.conversation_id
  })
})

function updateSession(sessionId, updates) {
  hookContext.updateSession(sessionId, updates)
}

function baseUpdates(data, now) {
  return hookContext.baseUpdates(data, now)
}

function basename(value) {
  return value ? path.basename(String(value)) : ''
}

function cleanPrompt(prompt) {
  return String(prompt || '').replace(/[\r\n\t]+/g, ' ').trim()
}

function titleFromPrompt(prompt, fallback) {
  const clean = cleanPrompt(prompt)
  if (clean) return clean.slice(0, 100)
  return fallback || undefined
}

function getSessionId(data) {
  return data.session_id ||
    data.sessionId ||
    data.conversation_id ||
    data.thread_id ||
    data.threadId ||
    data.id ||
    `${agentType}-${cleanPrompt(data.cwd || process.cwd() || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_')}`
}

function getEventName(data) {
  return eventOverride || data.hook_event_name || data.event_type || data.type || ''
}

function getToolName(data) {
  return data.tool_name || data.toolName || data.tool || 'unknown'
}

function parseJsonMaybe(value) {
  if (!value) return value
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return value
  try { return JSON.parse(trimmed) } catch (_) { return value }
}

function getToolInput(data) {
  return parseJsonMaybe(data.tool_input || data.toolInput || data.toolArgs || data.tool_args)
}

function getToolDetails(toolName, toolInput) {
  let details = String(toolName || 'unknown')
  const input = parseJsonMaybe(toolInput)
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (input.command) details += ': ' + String(input.command).slice(0, 80)
    else if (input.file_path) details += ': ' + path.basename(String(input.file_path))
    else if (input.path) details += ': ' + path.basename(String(input.path))
    else if (input.pattern) details += ': ' + String(input.pattern).slice(0, 80)
    else if (input.query) details += ': ' + String(input.query).slice(0, 80)
    else if (input.description) details += ': ' + String(input.description).slice(0, 80)
    else if (input.url) details += ': ' + String(input.url).slice(0, 80)
    else {
      for (const value of Object.values(input)) {
        if (typeof value === 'string' && value.trim()) {
          details += ': ' + value.trim().slice(0, 80)
          break
        }
      }
    }
  } else if (typeof input === 'string' && input.trim()) {
    details += ': ' + input.trim().slice(0, 80)
  }
  return details
}

function latestAssistantFromCopilotTranscript(transcriptPath) {
  if (!transcriptPath) return undefined
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8')
    let last
    for (const line of content.trim().split('\n')) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'assistant.message' && typeof obj.data?.content === 'string') {
          last = obj.data.content
        }
      } catch (_) {}
    }
    return last
  } catch (_) {
    return undefined
  }
}

function isQuestionTool(toolName) {
  const name = String(toolName || '').toLowerCase()
  return name === 'ask_user' || name.includes('askuserquestion') || name.includes('ask_user')
}

function isPermissionTool(agent, toolName) {
  const name = String(toolName || '').toLowerCase()
  if (agent === 'gemini') return false
  if (agent === 'copilot-cli') {
    return !new Set([
      'view', 'glob', 'grep', 'rg', 'readbash', 'readpowershell',
      'listbash', 'listpowershell', 'report_intent', 'reportintent'
    ]).has(name)
  }
  if (agent === 'kimi') {
    return new Set([
      'shell', 'writefile', 'strreplacefile', 'taskstop', 'mcptool',
      'plugintool', 'exitplanmode', 'enterplanmode'
    ]).has(name)
  }
  return false
}

function sessionStart(data, sessionId, now, title) {
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'idle',
    startedAt: now,
    sessionTitle: title || data.session_title || basename(data.cwd) || `${agentType} session`,
    pendingToolUse: null,
    activeTool: null,
    lastEvent: { type: AGENT_EVENTS.SESSION_START, timestamp: now, details: getEventName(data) }
  })))
}

function promptSubmit(data, sessionId, now, prompt) {
  const title = titleFromPrompt(prompt, data.session_title || basename(data.cwd) || `${agentType} session`)
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    sessionTitle: title,
    lastUserPrompt: cleanPrompt(prompt) || undefined,
    pendingToolUse: null,
    activeTool: null,
    lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: now, details: title }
  })))
}

function toolUse(data, sessionId, now) {
  const toolName = getToolName(data)
  const toolInput = getToolInput(data)
  const details = getToolDetails(toolName, toolInput)
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: { tool: toolName, details, timestamp: now },
    activeTool: toolName,
    lastEvent: { type: AGENT_EVENTS.TOOL_USE, timestamp: now, details }
  })))
}

function permissionRequest(data, sessionId, now, question) {
  const toolName = getToolName(data)
  const toolInput = getToolInput(data)
  const details = question || getToolDetails(toolName, toolInput)
  const eventType = question ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.PERMISSION_REQUEST
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: question ? 'waiting for answer' : 'waiting for approval',
    pendingToolUse: { tool: toolName, details, timestamp: now },
    activeTool: toolName,
    lastEvent: { type: eventType, timestamp: now, details },
    lifecycleEvent: {
      type: eventType,
      source: 'hook',
      stateSource: `${agentType}-hooks`,
      timestamp: now,
      details,
      attentionReason: question ? 'waiting for answer' : 'waiting for approval',
      pendingToolUse: { tool: toolName, details, timestamp: now },
      activeTool: toolName,
      force: true
    }
  })))
}

function postToolUse(data, sessionId, now, failure) {
  const toolName = getToolName(data)
  const rawError = data.error || data.error_message || data.message
  const details = failure && rawError
    ? `${getToolDetails(toolName, getToolInput(data))} failed: ${String(rawError).slice(0, 80)}`
    : toolName
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastToolError: failure ? (rawError || true) : undefined,
    lastEvent: { type: failure ? AGENT_EVENTS.POST_TOOL_USE_FAILURE : AGENT_EVENTS.POST_TOOL_USE, timestamp: now, details }
  })))
}

function stop(data, sessionId, now, failure) {
  const lastAssistantMessage = data.last_assistant_message ||
    data.prompt_response ||
    data.assistant_message ||
    latestAssistantFromCopilotTranscript(data.transcriptPath || data.transcript_path)
  updateSession(sessionId, Object.assign(baseUpdates(data, now), {
    status: 'completed',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastAssistantMessage,
    error: failure ? (data.error || data.error_type || data.reason || 'error') : undefined,
    errorDetail: failure ? (data.error_message || data.error_details || data.message) : undefined,
    lastEvent: {
      type: failure ? AGENT_EVENTS.STOP_FAILURE : AGENT_EVENTS.STOP,
      timestamp: now,
      details: failure ? (data.error_message || data.error || data.reason) : undefined
    }
  }))
}

function sessionEnd(data, sessionId, now) {
  updateSession(sessionId, Object.assign(baseUpdates(data, now), {
    status: 'completed',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    endedAt: now,
    lastEvent: { type: AGENT_EVENTS.SESSION_END, timestamp: now, details: data.reason || getEventName(data) }
  }))
}

function upsertSubagent(sessionId, childId, patch) {
  const parent = hookContext.readSession(sessionId) || {}
  const activeSubagents = Array.isArray(parent.activeSubagents) ? parent.activeSubagents.filter(Boolean) : []
  const index = activeSubagents.findIndex(item => item && item.agentId === childId)
  const existing = index >= 0 ? activeSubagents[index] : { agentId: childId }
  const next = Object.assign({}, existing, patch, { agentId: childId, updatedAt: patch.updatedAt || Date.now() })
  if (index >= 0) activeSubagents[index] = next
  else activeSubagents.push(next)
  updateSession(sessionId, {
    activeSubagents,
    lastSubagentUpdatedAt: next.updatedAt,
    lastEvent: { type: AGENT_EVENTS.SUBAGENT_START, timestamp: next.updatedAt }
  })
}

function removeSubagent(sessionId, childId, now, activity) {
  const parent = hookContext.readSession(sessionId) || {}
  const activeSubagents = Array.isArray(parent.activeSubagents)
    ? parent.activeSubagents.filter(item => item && item.agentId !== childId)
    : []
  updateSession(sessionId, {
    activeSubagents,
    lastSubagentUpdatedAt: now,
    lastEvent: { type: AGENT_EVENTS.SUBAGENT_STOP, timestamp: now, details: activity }
  })
}

function handleGemini(data, sessionId, eventName, now) {
  if (eventName === 'SessionStart') return sessionStart(data, sessionId, now)
  if (eventName === 'BeforeAgent') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'BeforeTool') {
    const toolName = getToolName(data)
    if (isQuestionTool(toolName)) return permissionRequest(data, sessionId, now, 'Gemini is asking for input in the terminal')
    return toolUse(data, sessionId, now)
  }
  if (eventName === 'AfterTool') return postToolUse(data, sessionId, now, false)
  if (eventName === 'AfterAgent') return stop(data, sessionId, now, false)
  if (eventName === 'SessionEnd') return sessionEnd(data, sessionId, now)
  if (eventName === 'Notification' && data.notification_type === 'ToolPermission') {
    const details = data.details && typeof data.details === 'object' ? data.details : {}
    if (details.type === 'ask_user') return permissionRequest(data, sessionId, now, 'Gemini is asking for input in the terminal')
    return permissionRequest(Object.assign({}, data, { tool_name: details.title || 'ToolPermission' }), sessionId, now)
  }
  if (eventName === 'PreCompress') {
    updateSession(sessionId, { currentActivity: 'Compacting conversation...', lastEvent: { type: AGENT_EVENTS.PRE_COMPACT, timestamp: now }, lastUpdated: now })
  }
}

function handleKimi(data, sessionId, eventName, now) {
  if (eventName === 'SessionStart') return sessionStart(data, sessionId, now)
  if (eventName === 'UserPromptSubmit') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'PreToolUse') {
    const toolName = getToolName(data)
    if (isQuestionTool(toolName)) return permissionRequest(data, sessionId, now, 'Kimi is asking for input in the terminal')
    if (isPermissionTool('kimi', toolName)) return permissionRequest(data, sessionId, now)
    return toolUse(data, sessionId, now)
  }
  if (eventName === 'PostToolUse') return postToolUse(data, sessionId, now, false)
  if (eventName === 'PostToolUseFailure') return postToolUse(data, sessionId, now, true)
  if (eventName === 'Stop') return stop(data, sessionId, now, false)
  if (eventName === 'StopFailure') return stop(data, sessionId, now, true)
  if (eventName === 'SessionEnd') return sessionEnd(data, sessionId, now)
  if (eventName === 'SubagentStart') {
    const childId = data.agent_id || data.agent_name || data.subagent_id || `kimi-subagent-${now}`
    return upsertSubagent(sessionId, childId, {
      nickname: data.agent_name || data.agent_type || 'subagent',
      title: titleFromPrompt(data.prompt || data.description, 'subagent'),
      lastToolActivity: data.prompt || data.description || undefined,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }
  if (eventName === 'SubagentStop') {
    const childId = data.agent_id || data.agent_name || data.subagent_id || 'subagent'
    return removeSubagent(sessionId, childId, now, data.response || data.reason)
  }
}

function handleCopilot(data, sessionId, eventName, now) {
  if (eventName === 'sessionStart') return promptSubmit(data, sessionId, now, data.initialPrompt || data.prompt)
  if (eventName === 'userPromptSubmitted') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'preToolUse') {
    const toolName = getToolName(data)
    if (isQuestionTool(toolName)) return permissionRequest(data, sessionId, now, 'Copilot CLI is asking for input in the terminal')
    if (isPermissionTool('copilot-cli', toolName)) return permissionRequest(data, sessionId, now)
    return toolUse(data, sessionId, now)
  }
  if (eventName === 'postToolUse') return postToolUse(data, sessionId, now, false)
  if (eventName === 'agentStop') return stop(data, sessionId, now, false)
  if (eventName === 'errorOccurred') return stop(data, sessionId, now, true)
  if (eventName === 'sessionEnd') return sessionEnd(data, sessionId, now)
}

function handleOpenCode(data, sessionId, eventName, now) {
  if (eventName === 'SessionStart') return sessionStart(data, sessionId, now, data.session_title)
  if (eventName === 'UserPromptSubmit') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'AssistantMessageUpdate') {
    updateSession(sessionId, Object.assign(baseUpdates(data, now), {
      lastAssistantMessage: data.assistant_message_preview,
      currentActivity: data.assistant_message_preview,
      sessionTitle: data.session_title || undefined,
      lastEvent: { type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, timestamp: now, details: data.assistant_message_preview }
    }))
    return
  }
  if (eventName === 'PreToolUse') return toolUse(data, sessionId, now)
  if (eventName === 'PostToolUse') return postToolUse(data, sessionId, now, false)
  if (eventName === 'PermissionRequest') return permissionRequest(data, sessionId, now)
  if (eventName === 'QuestionAsked') return permissionRequest(data, sessionId, now, data.question_text || 'OpenCode is asking for input')
  if (eventName === 'Stop') return stop(data, sessionId, now, false)
  if (eventName === 'SessionEnd') return sessionEnd(data, sessionId, now)
}

function handlePayload(data) {
  const eventName = getEventName(data)
  const sessionId = String(getSessionId(data))
  const now = Date.now()

  if (agentType === 'gemini') return handleGemini(data, sessionId, eventName, now)
  if (agentType === 'kimi') return handleKimi(data, sessionId, eventName, now)
  if (agentType === 'copilot-cli') return handleCopilot(data, sessionId, eventName, now)
  if (agentType === 'opencode') return handleOpenCode(data, sessionId, eventName, now)

  if (/sessionstart/i.test(eventName)) return sessionStart(data, sessionId, now)
  if (/prompt/i.test(eventName)) return promptSubmit(data, sessionId, now, data.prompt || data.message)
  if (/pre.*tool|before.*tool/i.test(eventName)) return toolUse(data, sessionId, now)
  if (/post.*tool|after.*tool/i.test(eventName)) return postToolUse(data, sessionId, now, false)
  if (/stop|complete|end/i.test(eventName)) return stop(data, sessionId, now, false)
}

async function main() {
  const input = await readStdin()
  if (!input.trim()) return
  let data
  try { data = JSON.parse(input) } catch (_) { return }
  if (eventOverride && !data.hook_event_name) data.hook_event_name = eventOverride
  handlePayload(data)
  await hookContext.flush()
}

const adapter = {
  agentId: agentType,
  handlePayload
}

module.exports = {
  adapter,
  handlePayload,
  getToolDetails
}

if (require.main === module) {
  main().catch(() => process.exit(0))
}
