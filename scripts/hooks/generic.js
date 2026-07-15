#!/usr/bin/env node
// Generic tmux-scout hook for CLI agents whose payloads are close to Claude-style events.

const fs = require('fs')
const path = require('path')
const { createHookContext, readStdin, liveSessionState, isMeaningfulSubagentActivity } = require('../lib/hook-adapter')
const { AGENT_EVENTS } = require('../lib/agent-events')
const { internalPromptReason } = require('../lib/codex-session-classifier')
const { notificationText } = require('../lib/notification-intent')
const { safeSessionId } = require('../lib/session-registry')

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
    threadId: data.thread_id || data.session_id || data.sessionId || data.conversation_id,
    parentSessionId: data.parentSessionId || data.parent_session_id
  })
})

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
  const session = hookContext.readSession(sessionId)
  const pending = session && session.pendingInteraction
  if (!pending) return
  const eventType = pendingResolutionType(pending)
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
    lastEvent: {
      type: eventType,
      timestamp: now,
      details: details || pending.details || pending.reason,
      rawEventName: `${getEventName(data) || 'hook'}:${eventType}`
    }
  })))
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
    data.task_id ||
    (data.extra && data.extra.task_id) ||
    data.id ||
    `${agentType}-${cleanPrompt(data.cwd || process.cwd() || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '_')}`
}

function getEventName(data) {
  return eventOverride || data.hook_event_name || data.event_type || data.type || ''
}

function normalizeHookEventName(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

function getToolName(data) {
  return data.tool_name || data.toolName || data.tool || data.server || 'unknown'
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
  return parseJsonMaybe(data.tool_input ||
    data.toolInput ||
    data.toolArgs ||
    data.tool_args ||
    data.arguments ||
    data.args ||
    data.params ||
    data.command ||
    data.file_path)
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

function structuredQuestionText(toolInput) {
  const input = parseJsonMaybe(toolInput)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    for (const item of input.questions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const text = item.question || item.prompt || item.message || item.text || item.header
      if (typeof text === 'string' && text.trim()) return text.trim()
    }
    return null
  }
  for (const key of ['question', 'prompt', 'message', 'text', 'query']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim()
  }
  return null
}

function isHermesClarifyTool(toolName) {
  const name = String(toolName || '').trim().toLowerCase()
  return name === 'clarify' || name === 'askuserquestions' || name === 'ask_user_questions'
}

function copilotQuestionText(data) {
  const toolName = String(getToolName(data) || '')
  if (!new Set(['ask_user', 'AskUserQuestion', 'AskUserQuestions']).has(toolName)) return null
  const raw = data.toolArgs || data.tool_args
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed.question === 'string' && parsed.question.trim()
      ? parsed.question.trim()
      : null
  } catch (_) {
    return null
  }
}

// Keep Copilot tool normalization and risk classification aligned with the reference adapter.
function normalizeCopilotToolName(rawToolName) {
  const toolName = String(rawToolName || '').trim().toLowerCase()
  const names = {
    ask_user: 'AskUser',
    report_intent: 'ReportIntent',
    view: 'View',
    glob: 'Glob',
    grep: 'Grep',
    rg: 'Grep',
    bash: 'Bash',
    powershell: 'PowerShell',
    create: 'Create',
    edit: 'Edit',
    apply_batch: 'Edit',
    apply_patch: 'Edit',
    task: 'Task',
    skill: 'Skill',
    web_fetch: 'WebFetch',
    read_bash: 'ReadBash',
    read_powershell: 'ReadPowerShell',
    write_bash: 'WriteBash',
    write_powershell: 'WritePowerShell',
    stop_bash: 'StopBash',
    stop_powershell: 'StopPowerShell',
    list_bash: 'ListBash',
    list_powershell: 'ListPowerShell',
    read_agent: 'ReadAgent',
    list_agents: 'ListAgents'
  }
  return names[toolName] || String(rawToolName || 'unknown')
}

function copilotToolRiskLevel(toolName) {
  const normalized = normalizeCopilotToolName(toolName)
  const readOnly = new Set([
    'View', 'Glob', 'Grep', 'ReadBash', 'ReadPowerShell', 'ListBash',
    'ListPowerShell', 'ReadAgent', 'ListAgents', 'ReportIntent', 'Bash', 'PowerShell'
  ])
  const high = new Set([
    'WriteBash', 'WritePowerShell', 'StopBash', 'StopPowerShell',
    'WebFetch', 'Task', 'Skill'
  ])
  if (readOnly.has(normalized)) return 'low'
  if (high.has(normalized)) return 'high'
  return 'medium'
}

function isPermissionTool(agent, toolName) {
  const name = String(toolName || '').toLowerCase()
  if (agent === 'gemini') return false
  if (agent === 'coco' || agent === 'trae' || agent === 'cursor' || agent === 'hermes') return false
  if (agent === 'copilot-cli') return copilotToolRiskLevel(toolName) !== 'low'
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
    status: 'working',
    startedAt: now,
    sessionTitle: title || data.session_title || basename(data.cwd) || `${agentType} session`,
    pendingToolUse: null,
    activeTool: null,
    lastEvent: { type: AGENT_EVENTS.SESSION_START, timestamp: now, details: getEventName(data) }
  })))
}

function promptSubmit(data, sessionId, now, prompt) {
  resolvePendingInteraction(sessionId, data, now, 'user prompt submitted')
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

function toolUse(data, sessionId, now, options = {}) {
  const toolName = getToolName(data)
  const toolInput = getToolInput(data)
  const details = getToolDetails(toolName, toolInput)
  if (options.resolvePending === true) {
    resolvePendingInteraction(sessionId, data, now, details)
  }
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: { tool: toolName, details, timestamp: now },
    activeTool: toolName,
    lastEvent: { type: AGENT_EVENTS.TOOL_USE, timestamp: now, details }
  })))
}

function permissionRequest(data, sessionId, now, question, attentionReasonOverride, options = {}) {
  const toolName = getToolName(data)
  const toolInput = getToolInput(data)
  const details = question ||
    data.permission_description ||
    data.permissionDescription ||
    data.description ||
    getToolDetails(toolName, toolInput)
  const eventType = question ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.PERMISSION_REQUEST
  const attentionReason = attentionReasonOverride || (question ? 'waiting for answer' : 'waiting for approval')
  const activeTool = options.trackActiveTool === false ? undefined : toolName
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: attentionReason,
    pendingToolUse: { tool: toolName, details, timestamp: now },
    activeTool,
    lastEvent: { type: eventType, timestamp: now, details },
    lifecycleEvent: {
      type: eventType,
      source: 'hook',
      stateSource: `${agentType}-hooks`,
      timestamp: now,
      details,
      attentionReason,
      pendingToolUse: { tool: toolName, details, timestamp: now },
      activeTool,
      force: true
    }
  })))
}

function postToolUse(data, sessionId, now, failure, options = {}) {
  const toolName = getToolName(data)
  const rawError = data.error || data.error_message || data.message
  const details = failure && rawError
    ? `${getToolDetails(toolName, getToolInput(data))} failed: ${String(rawError).slice(0, 80)}`
    : toolName
  if (options.resolvePending !== false) {
    resolvePendingInteraction(sessionId, data, now, details)
  }
  updateSession(sessionId, liveSessionState(Object.assign(baseUpdates(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastToolError: failure ? (rawError || true) : undefined,
    lastEvent: { type: failure ? AGENT_EVENTS.POST_TOOL_USE_FAILURE : AGENT_EVENTS.POST_TOOL_USE, timestamp: now, details }
  })))
}

function toolCompletionActivity(data, failure = false) {
  const toolName = getToolName(data)
  const raw = failure
    ? (data.error || data.error_message || data.message)
    : (data.tool_response || data.toolResponse || data.tool_output || data.toolOutput)
  let preview = ''
  if (typeof raw === 'string') preview = raw.trim().replace(/\s+/g, ' ').slice(0, 80)
  else if (raw && typeof raw === 'object') {
    const value = raw.stdout || raw.output || raw.result || raw.message
    if (typeof value === 'string') preview = value.trim().replace(/\s+/g, ' ').slice(0, 80)
  }
  if (failure) return preview ? `${toolName} failed: ${preview}` : `${toolName} failed`
  return preview ? `${toolName}: ${preview}` : `${toolName} done`
}

function stop(data, sessionId, now, failure, options = {}) {
  const lastAssistantMessage = data.last_assistant_message ||
    data.prompt_response ||
    data.assistant_message ||
    data.response ||
    data.output ||
    data.text ||
    (data.extra && data.extra.last_assistant_message) ||
    latestAssistantFromCopilotTranscript(data.transcriptPath || data.transcript_path)
  if (options.resolvePending === true) {
    resolvePendingInteraction(sessionId, data, now, lastAssistantMessage || (failure ? 'turn failed' : 'turn completed'))
  }
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
  // Every common reference adapter that implements SessionEnd clears its stale
  // pending interaction first.
  resolvePendingInteraction(sessionId, data, now, data.reason || 'session ended')
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

function updateActivity(data, sessionId, now, details, eventType = AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE) {
  updateSession(sessionId, Object.assign(baseUpdates(data, now), {
    currentActivity: details || undefined,
    lastEvent: { type: eventType, timestamp: now, details }
  }))
}

function subagentId(data, now, prefix) {
  return data.agent_id ||
    data.agentId ||
    data.child_session_id ||
    data.childSessionId ||
    data.child_id ||
    data.childId ||
    data.subagent_id ||
    data.subagentId ||
    data.agent_name ||
    data.agentName ||
    `${prefix}-subagent-${now}`
}

function subagentPatch(data, now, defaultNickname) {
  const nested = data.subagent && typeof data.subagent === 'object' ? data.subagent : {}
  const task = data.task_description ||
    data.taskDescription ||
    data.description ||
    data.prompt ||
    data.task ||
    data.message ||
    nested.task_description ||
    nested.description ||
    nested.prompt ||
    nested.task
  const nickname = data.agent_name ||
    data.agentName ||
    data.agent_type ||
    data.agentType ||
    nested.name ||
    nested.agent_name ||
    nested.agent_type ||
    defaultNickname ||
    'subagent'
  return {
    nickname,
    title: titleFromPrompt(task, 'subagent'),
    lastToolActivity: isMeaningfulSubagentActivity(task) ? task : undefined,
    transcriptPath: data.transcript_path || data.transcriptPath || nested.transcript_path || nested.transcriptPath,
    phase: 'running',
    startedAt: now,
    updatedAt: now
  }
}

function handleGemini(data, sessionId, eventName, now) {
  if (eventName === 'SessionStart') {
    if (data.source === 'compact' || data.source === 'clear') return
    return sessionStart(data, sessionId, now)
  }
  if (eventName === 'BeforeAgent') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'BeforeTool') return toolUse(data, sessionId, now)
  if (eventName === 'AfterTool') {
    postToolUse(data, sessionId, now, false)
    return updateActivity(data, sessionId, now, toolCompletionActivity(data))
  }
  if (eventName === 'AfterAgent') return stop(data, sessionId, now, false)
  if (eventName === 'SessionEnd') return sessionEnd(data, sessionId, now)
  if (eventName === 'Notification' && data.notification_type === 'ToolPermission') {
    const details = data.details && typeof data.details === 'object' ? data.details : {}
    if (details.type === 'ask_user') return permissionRequest(data, sessionId, now, 'Gemini is asking for input in the terminal')
    return permissionRequest(Object.assign({}, data, { tool_name: details.title || 'ToolPermission' }), sessionId, now)
  }
  if (eventName === 'Notification') return notificationActivity(data, sessionId, now)
  if (eventName === 'PreCompress') {
    return updateActivity(data, sessionId, now, 'Compacting conversation...')
  }
}

// The reference implementation keeps activeNativeApprovals in the long-lived KimiAdapter. tmux-scout
// launches one process per hook, so persist the same Set in the run directory.
function kimiApprovalMarkerDir(sessionId) {
  return path.join(hookContext.paths.runDir, 'kimi-hooks', 'active-native-approvals', safeSessionId(sessionId))
}

function readKimiNativeApprovals(sessionId) {
  const dir = kimiApprovalMarkerDir(sessionId)
  const approvals = new Set()
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.approval')) continue
      const value = fs.readFileSync(path.join(dir, entry), 'utf-8').trim()
      if (value) approvals.add(value)
    }
  } catch (_) {}
  return approvals
}

function addKimiNativeApproval(sessionId, data, now) {
  const toolCallId = data.tool_call_id || `fallback-${now}`
  const dir = kimiApprovalMarkerDir(sessionId)
  const filePath = path.join(dir, `${encodeURIComponent(toolCallId)}.approval`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    // One marker per tool_call_id avoids lost updates when independent hook
    // processes receive parallel PreToolUse events.
    fs.writeFileSync(filePath, toolCallId, { flag: 'wx' })
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
  }
}

function clearKimiNativeApprovals(sessionId) {
  try { fs.rmSync(kimiApprovalMarkerDir(sessionId), { recursive: true, force: true }) } catch (_) {}
}

function kimiPostResolvesPending(sessionId, data) {
  const approvals = readKimiNativeApprovals(sessionId)
  const toolName = getToolName(data)
  const toolCallId = typeof data.tool_call_id === 'string' ? data.tool_call_id : ''
  const isNativeApproval = toolName === 'AskUserQuestion' || isPermissionTool('kimi', toolName)

  if (isNativeApproval && toolCallId && approvals.has(toolCallId)) {
    const marker = path.join(kimiApprovalMarkerDir(sessionId), `${encodeURIComponent(toolCallId)}.approval`)
    try { fs.unlinkSync(marker) } catch (_) {}
    return readKimiNativeApprovals(sessionId).size === 0
  }

  // Exact reference fallback: unrelated/low-risk completions resolve only when no
  // tracked native approval remains.
  return approvals.size === 0
}

function handleKimi(data, sessionId, eventName, now) {
  // The Kimi reference adapter only ACKs SessionStart; sessionStarted is emitted from
  // UserPromptSubmit, including the empty-prompt Kimi exception.
  if (eventName === 'SessionStart') return
  if (eventName === 'UserPromptSubmit') {
    clearKimiNativeApprovals(sessionId)
    return promptSubmit(data, sessionId, now, data.prompt)
  }
  if (eventName === 'PreToolUse') {
    const toolName = getToolName(data)
    if (toolName === 'AskUserQuestion') {
      const question = structuredQuestionText(getToolInput(data))
      if (question) {
        addKimiNativeApproval(sessionId, data, now)
        return permissionRequest(data, sessionId, now, question)
      }
      return toolUse(data, sessionId, now)
    }
    if (isPermissionTool('kimi', toolName)) {
      addKimiNativeApproval(sessionId, data, now)
      return permissionRequest(data, sessionId, now)
    }
    return toolUse(data, sessionId, now)
  }
  if (eventName === 'PostToolUse') {
    const toolName = getToolName(data)
    postToolUse(data, sessionId, now, false, { resolvePending: kimiPostResolvesPending(sessionId, data) })
    return updateActivity(data, sessionId, now, `${toolName} done`)
  }
  if (eventName === 'PostToolUseFailure') {
    const toolName = getToolName(data)
    postToolUse(data, sessionId, now, true, { resolvePending: kimiPostResolvesPending(sessionId, data) })
    return updateActivity(data, sessionId, now, `${toolName} done`)
  }
  if (eventName === 'Stop') {
    clearKimiNativeApprovals(sessionId)
    return stop(data, sessionId, now, false, { resolvePending: true })
  }
  if (eventName === 'StopFailure') {
    clearKimiNativeApprovals(sessionId)
    return stop(data, sessionId, now, true, { resolvePending: true })
  }
  if (eventName === 'SessionEnd') {
    clearKimiNativeApprovals(sessionId)
    return sessionEnd(data, sessionId, now)
  }
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
    const question = copilotQuestionText(data)
    if (new Set(['ask_user', 'AskUserQuestion', 'AskUserQuestions']).has(String(toolName))) {
      if (question) return permissionRequest(data, sessionId, now, question)
      return
    }
    if (isPermissionTool('copilot-cli', toolName)) return permissionRequest(data, sessionId, now)
    return toolUse(data, sessionId, now)
  }
  if (eventName === 'postToolUse') {
    postToolUse(data, sessionId, now, false)
    return updateActivity(data, sessionId, now, toolCompletionActivity(data))
  }
  if (eventName === 'agentStop') return stop(data, sessionId, now, false, { resolvePending: true })
  if (eventName === 'subagentStop') return updateActivity(data, sessionId, now, '')
  if (eventName === 'errorOccurred') return stop(data, sessionId, now, true, { resolvePending: true })
  if (eventName === 'sessionEnd') return sessionEnd(data, sessionId, now)
}

function openCodeTerminalKey(data, now) {
  const runtime = baseUpdates(data, now)
  const tmuxPane = nonEmptyString(runtime.tmuxPane)
  if (tmuxPane) return `pane:${tmuxPane}`
  const terminalSessionId = nonEmptyString(data.terminal_session_id) || runtime.terminalSessionId
  if (terminalSessionId) return `session:${terminalSessionId}`
  const terminalTty = nonEmptyString(data.terminal_tty) || runtime.terminalTty
  if (terminalTty) return `tty:${terminalTty}`
  return null
}

function openCodeTerminalMarkerPath(key) {
  return path.join(hookContext.paths.runDir, 'opencode-hooks', 'terminal-sessions', `${encodeURIComponent(key)}.json`)
}

function readOpenCodeTerminalSession(key) {
  if (!key) return null
  try {
    const value = JSON.parse(fs.readFileSync(openCodeTerminalMarkerPath(key), 'utf-8'))
    return value && value.sessionId ? value.sessionId : null
  } catch (_) {
    return null
  }
}

function writeOpenCodeTerminalSession(key, sessionId) {
  if (!key) return
  const filePath = openCodeTerminalMarkerPath(key)
  const tempPath = `${filePath}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ sessionId }))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function clearOpenCodeTerminalSession(sessionId) {
  const dir = path.join(hookContext.paths.runDir, 'opencode-hooks', 'terminal-sessions')
  try {
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name)
      try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (value && value.sessionId === sessionId) fs.unlinkSync(filePath)
      } catch (_) {}
    }
  } catch (_) {}
}

function handleOpenCode(data, sessionId, eventName, now) {
  // The reference implementation ignores every OpenCode child-agent hook. These payloads reuse the
  // parent's session_id, so processing them would corrupt the parent phase.
  if (data.agent_id) return
  if (eventName === 'SessionStart') {
    const terminalKey = openCodeTerminalKey(data, now)
    const previousSessionId = readOpenCodeTerminalSession(terminalKey)
    if (previousSessionId && previousSessionId !== sessionId) {
      updateSession(previousSessionId, {
        status: 'completed',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        lastEvent: { type: AGENT_EVENTS.SESSION_END, timestamp: now, details: 'newer OpenCode session in terminal' }
      })
    }
    writeOpenCodeTerminalSession(terminalKey, sessionId)
    return sessionStart(data, sessionId, now, data.session_title)
  }
  if (eventName === 'UserPromptSubmit') return promptSubmit(data, sessionId, now, data.prompt)
  if (eventName === 'AssistantMessageUpdate') {
    if (typeof data.assistant_message_preview !== 'string' || !data.assistant_message_preview) return
    updateSession(sessionId, Object.assign(baseUpdates(data, now), {
      lastAssistantMessage: data.assistant_message_preview,
      currentActivity: data.assistant_message_preview,
      sessionTitle: data.session_title || undefined,
      lastEvent: { type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, timestamp: now, details: data.assistant_message_preview }
    }))
    return
  }
  if (eventName === 'PreToolUse') return toolUse(data, sessionId, now)
  if (eventName === 'PostToolUse') {
    const hasToolName = typeof data.tool_name === 'string' && data.tool_name.length > 0
    postToolUse(data, sessionId, now, false, { resolvePending: !hasToolName })
    const current = hookContext.readSession(sessionId)
    if (current && current.lastAssistantMessage) {
      return updateActivity(data, sessionId, now, current.lastAssistantMessage)
    }
    return
  }
  if (eventName === 'PermissionRequest') return permissionRequest(data, sessionId, now)
  if (eventName === 'QuestionAsked') return permissionRequest(data, sessionId, now, data.question_text || 'OpenCode is asking for input')
  if (eventName === 'Stop') {
    return stop(Object.assign({}, data, {
      last_assistant_message: data.last_assistant_message || data.assistant_message_preview
    }), sessionId, now, false)
  }
  if (eventName === 'SessionEnd') {
    clearOpenCodeTerminalSession(sessionId)
    return sessionEnd(data, sessionId, now)
  }
}

function cursorMcpToolName(data) {
  const server = data.server || data.server_name || data.mcp_server || data.mcpServer
  const tool = data.tool_name || data.toolName || data.tool || data.name || data.method
  if (server && tool) return `MCP: ${server} -> ${tool}`
  if (server) return `MCP: ${server}`
  return tool || 'MCP'
}

function handleCursor(data, sessionId, eventName, now) {
  if (eventName === 'sessionStart') return sessionStart(data, sessionId, now, data.session_title)
  if (eventName === 'sessionEnd') return sessionEnd(data, sessionId, now)
  if (eventName === 'beforeSubmitPrompt') {
    return promptSubmit(data, sessionId, now, data.prompt || data.message || data.text || data.user_prompt)
  }
  if (eventName === 'beforeShellExecution') {
    return toolUse(Object.assign({ tool_name: 'Shell' }, data, {
      tool_input: data.tool_input || data.toolInput || { command: data.command }
    }), sessionId, now, { resolvePending: true })
  }
  if (eventName === 'afterShellExecution') {
    const failed = Number.isFinite(data.exit_code) ? data.exit_code !== 0
      : Number.isFinite(data.exitCode) ? data.exitCode !== 0
        : Boolean(data.error || data.error_message)
    return postToolUse(Object.assign({ tool_name: 'Shell' }, data, {
      tool_input: data.tool_input || data.toolInput || { command: data.command }
    }), sessionId, now, failed)
  }
  if (eventName === 'beforeMCPExecution') {
    return toolUse(Object.assign({}, data, { tool_name: cursorMcpToolName(data) }), sessionId, now, { resolvePending: true })
  }
  if (eventName === 'afterMCPExecution') {
    return postToolUse(Object.assign({}, data, { tool_name: cursorMcpToolName(data) }), sessionId, now, Boolean(data.error || data.error_message))
  }
  if (eventName === 'beforeReadFile') {
    return toolUse(Object.assign({ tool_name: 'ReadFile' }, data, {
      tool_input: data.tool_input || data.toolInput || { file_path: data.file_path || data.path }
    }), sessionId, now)
  }
  if (eventName === 'afterFileEdit') {
    const payload = Object.assign({ tool_name: 'EditFile' }, data, {
      tool_input: data.tool_input || data.toolInput || { file_path: data.file_path || data.path }
    })
    postToolUse(payload, sessionId, now, Boolean(data.error || data.error_message), { resolvePending: false })
    const filePath = data.file_path || data.path
    if (filePath) return updateActivity(data, sessionId, now, `Edited: ${filePath}`)
    return
  }
  if (eventName === 'afterAgentResponse') {
    updateActivity(data, sessionId, now, 'Agent responded')
    if (typeof data.text === 'string' && data.text) {
      return stop(Object.assign({}, data, { last_assistant_message: data.text }), sessionId, now, false)
    }
    return
  }
  if (eventName === 'afterAgentThought') {
    return updateActivity(data, sessionId, now, data.thought || data.text || data.message)
  }
  if (eventName === 'preToolUse') return toolUse(data, sessionId, now)
  if (eventName === 'postToolUse') return postToolUse(data, sessionId, now, false, { resolvePending: false })
  if (eventName === 'stop') return stop(data, sessionId, now, false, { resolvePending: true })
}

function notificationDetails(data) {
  return notificationText(data) || undefined
}

// Unknown/system notifications carry activity metadata only. Reference adapters do
// not inspect their prose to infer lifecycle state.
function notificationActivity(data, sessionId, now) {
  return updateActivity(data, sessionId, now, notificationDetails(data), AGENT_EVENTS.NOTIFICATION)
}

function handleCoco(data, sessionId, eventName, now) {
  const event = normalizeHookEventName(eventName)
  if (event === 'session_start') return sessionStart(data, sessionId, now, data.session_title)
  if (event === 'session_end') return sessionEnd(data, sessionId, now)
  if (event === 'user_prompt_submit') {
    const nested = data.user_prompt_submit && typeof data.user_prompt_submit === 'object'
      ? data.user_prompt_submit
      : {}
    return promptSubmit(data, sessionId, now, data.prompt || nested.prompt || data.message || data.text)
  }
  if (event === 'pre_tool_use') {
    const nested = data.pre_tool_use && typeof data.pre_tool_use === 'object'
      ? data.pre_tool_use
      : {}
    const payload = Object.assign({}, nested, data, {
      tool_name: data.tool_name || nested.tool_name,
      tool_input: data.tool_input || nested.tool_input
    })
    const toolName = getToolName(payload)
    if (toolName === 'AskUserQuestion') {
      const question = structuredQuestionText(getToolInput(payload))
      if (question) return permissionRequest(payload, sessionId, now, question)
    }
    return toolUse(payload, sessionId, now, { resolvePending: true })
  }
  if (event === 'post_tool_use' || event === 'post_tool_use_failure') {
    const key = event === 'post_tool_use_failure' ? 'post_tool_use_failure' : 'post_tool_use'
    const nested = data[key] && typeof data[key] === 'object' ? data[key] : {}
    const payload = Object.assign({}, nested, data, {
      tool_name: data.tool_name || nested.tool_name,
      tool_input: data.tool_input || nested.tool_input,
      tool_response: data.tool_response || nested.tool_response
    })
    const failure = event === 'post_tool_use_failure'
    postToolUse(payload, sessionId, now, failure)
    return updateActivity(payload, sessionId, now, toolCompletionActivity(payload, failure))
  }
  if (event === 'permission_request') return permissionRequest(data, sessionId, now)
  if (event === 'notification') {
    // CocoAdapter: only exact idle_prompt means the current turn ended.
    if (data.notification_type === 'idle_prompt') return stop(data, sessionId, now, false, { resolvePending: true })
    return notificationActivity(data, sessionId, now)
  }
  if (event === 'stop') return stop(data, sessionId, now, false, { resolvePending: true })
  if (event === 'subagent_start') {
    const childId = subagentId(data, now, agentType)
    return upsertSubagent(sessionId, childId, {
      nickname: data.agent_name || data.agent_type || data.agentName || 'subagent',
      title: titleFromPrompt(data.prompt || data.description || data.task, 'subagent'),
      lastToolActivity: data.prompt || data.description || data.task || undefined,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }
  if (event === 'subagent_stop') {
    return removeSubagent(sessionId, subagentId(data, now, agentType), now, data.response || data.reason)
  }
}

function isBypassedPermissionMode(data) {
  const mode = normalizeHookEventName(data.permission_mode || data.permissionMode || data.mode || '')
  return mode === 'auto' || mode === 'bypass_permissions' || mode === 'bypasspermissions'
}

function isIdlePromptNotification(data) {
  return data.notification_type === 'idle_prompt'
}

function questionPrompt(data, fallback) {
  return data.question_text ||
    data.questionText ||
    data.question ||
    data.prompt ||
    data.message ||
    notificationDetails(data) ||
    fallback
}

// The reference implementation keeps these as TraexCliAdapter instance Sets/Maps. tmux-scout runs one
// process per hook, so persist the same adapter bookkeeping outside the visible
// session registry. In particular, SessionStart must not create an IDLE row.
function traexMarkerPath(kind, sessionId) {
  return path.join(hookContext.paths.runDir, 'traex-hooks', kind, `${safeSessionId(sessionId)}.json`)
}

function readTraexMarker(kind, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(traexMarkerPath(kind, sessionId), 'utf-8'))
  } catch (_) {
    return null
  }
}

function writeTraexMarker(kind, sessionId, value) {
  const filePath = traexMarkerPath(kind, sessionId)
  const tempPath = `${filePath}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function removeTraexMarker(kind, sessionId) {
  try { fs.unlinkSync(traexMarkerPath(kind, sessionId)) } catch (_) {}
}

function isConfirmedTraexSession(sessionId) {
  return Boolean(readTraexMarker('confirmed', sessionId))
}

function isInternalTraexSession(sessionId) {
  return Boolean(readTraexMarker('internal', sessionId))
}

function traexParentSessionId(sessionId) {
  const marker = readTraexMarker('parent', sessionId)
  return marker && marker.parentSessionId ? String(marker.parentSessionId) : null
}

function clearTraexChildMappings(parentSessionId) {
  const parentDir = path.join(hookContext.paths.runDir, 'traex-hooks', 'parent')
  let entries = []
  try { entries = fs.readdirSync(parentDir) } catch (_) { return }
  for (const entry of entries) {
    const filePath = path.join(parentDir, entry)
    try {
      const marker = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      if (marker && marker.parentSessionId === parentSessionId) fs.unlinkSync(filePath)
    } catch (_) {}
  }
}

function clearTraexSessionMarkers(sessionId) {
  removeTraexMarker('confirmed', sessionId)
  removeTraexMarker('internal', sessionId)
  removeTraexMarker('parent', sessionId)
  clearTraexChildMappings(sessionId)
}

function traexPrompt(data) {
  const nested = data.user_prompt_submit && typeof data.user_prompt_submit === 'object'
    ? data.user_prompt_submit
    : {}
  return {
    prompt: typeof data.prompt === 'string'
      ? data.prompt
      : typeof nested.prompt === 'string' ? nested.prompt : '',
    cwd: typeof data.cwd === 'string'
      ? data.cwd
      : typeof nested.cwd === 'string' ? nested.cwd : ''
  }
}

function confirmTraexPrompt(data, sessionId, now, prompt, cwd) {
  writeTraexMarker('confirmed', sessionId, { sessionId, confirmedAt: now })
  const payload = cwd && !data.cwd ? Object.assign({}, data, { cwd }) : data
  // The reference implementation emits sessionStarted from UserPromptSubmit, not SessionStart. Keep the
  // two reducer events distinct so existing lifecycle evidence remains exact.
  sessionStart(payload, sessionId, now, data.session_title)
  return promptSubmit(payload, sessionId, now, prompt)
}

function stopInternalTraexSubagent(sessionId, now) {
  const parentId = traexParentSessionId(sessionId)
  if (!parentId) return
  if (isConfirmedTraexSession(parentId)) removeSubagent(parentId, sessionId, now)
  removeTraexMarker('parent', sessionId)
}

function handleTraex(data, sessionId, eventName, now) {
  const event = normalizeHookEventName(eventName)

  // Once a UserPromptSubmit is identified as an internal background session,
  // The reference adapter silently ACKs every later event until SessionEnd clears bookkeeping.
  if (isInternalTraexSession(sessionId)) {
    if (event === 'session_end') clearTraexSessionMarkers(sessionId)
    return
  }

  const parentId = traexParentSessionId(sessionId)
  if (parentId && !data.parentSessionId && !data.parent_session_id) {
    // The reference adapter attaches parentSessionId to the child sessionStarted event. Carry
    // the same identity on every child hook so even an early tool event cannot
    // become a top-level picker row before UserPromptSubmit arrives.
    data = Object.assign({}, data, { parentSessionId: parentId })
  }
  const confirmed = isConfirmedTraexSession(sessionId)
  const mayEstablishIdentity = event === 'session_start' ||
    event === 'user_prompt_submit' ||
    event === 'subagent_start' ||
    event === 'subagent_stop'

  // A root session is not real until its UserPromptSubmit arrives. This is the
  // TraexCliAdapter confirmedSessions gate from the reference implementation: no tool, wait, Stop, or
  // SessionEnd event may manufacture an IDLE/BUSY/DONE row before confirmation.
  if (!confirmed && !parentId && !mayEstablishIdentity) {
    if (event === 'session_end') clearTraexChildMappings(sessionId)
    return
  }

  // The reference implementation deliberately treats SessionStart as bookkeeping-only.
  if (event === 'session_start') return
  if (event === 'user_prompt_submit') {
    const submitted = traexPrompt(data)
    if (internalPromptReason(submitted.prompt)) {
      writeTraexMarker('internal', sessionId, { sessionId, hiddenAt: now })
      removeTraexMarker('confirmed', sessionId)
      stopInternalTraexSubagent(sessionId, now)
      return
    }
    return confirmTraexPrompt(data, sessionId, now, submitted.prompt, submitted.cwd)
  }
  if (event === 'pre_tool_use') {
    return toolUse(data, sessionId, now, { resolvePending: true })
  }
  if (event === 'permission_request') {
    // The reference TraexCliAdapter only ACKs auto/bypass modes; no state event and no
    // stale-wait resolver is emitted.
    if (isBypassedPermissionMode(data)) return
    // Traex permissionRequested changes only the wait phase. It does not
    // synthesize toolUseStarted, so preserve whatever activeTool already exists.
    return permissionRequest(data, sessionId, now, undefined, undefined, { trackActiveTool: false })
  }
  if (event === 'post_tool_use') {
    postToolUse(data, sessionId, now, false)
    return updateActivity(data, sessionId, now, toolCompletionActivity(data))
  }
  if (event === 'post_tool_use_failure') {
    postToolUse(data, sessionId, now, true)
    return updateActivity(data, sessionId, now, toolCompletionActivity(data, true))
  }
  if (event === 'notification') {
    if (isIdlePromptNotification(data)) return stop(data, sessionId, now, false, { resolvePending: true })
    return notificationActivity(data, sessionId, now)
  }
  if (event === 'stop') {
    if (parentId) {
      if (isConfirmedTraexSession(parentId)) removeSubagent(parentId, sessionId, now, data.response || data.reason)
      removeTraexMarker('parent', sessionId)
      removeTraexMarker('confirmed', sessionId)
    }
    return stop(data, sessionId, now, false, { resolvePending: true })
  }
  if (event === 'stop_failure') return stop(data, sessionId, now, true)
  if (event === 'subagent_start') {
    const childId = data.agent_id
    if (!childId) return
    writeTraexMarker('parent', childId, { parentSessionId: sessionId, linkedAt: now })
    if (confirmed) return upsertSubagent(sessionId, childId, subagentPatch(data, now, 'subagent'))
    return
  }
  if (event === 'subagent_stop') {
    const childId = data.agent_id
    if (!childId || traexParentSessionId(childId) !== sessionId) return
    removeTraexMarker('parent', childId)
    if (confirmed) return removeSubagent(sessionId, childId, now, data.response || data.reason)
    return
  }
  if (event === 'session_end') {
    if (parentId && isConfirmedTraexSession(parentId)) {
      removeSubagent(parentId, sessionId, now, data.response || data.reason)
    }
    sessionEnd(data, sessionId, now)
    clearTraexSessionMarkers(sessionId)
    return
  }
  // The reference TraexCliAdapter ACKs compact hooks without emitting state.
  if (event === 'pre_compact' || event === 'post_compact') return
}

function hermesPrompt(data) {
  return data.user_message ||
    data.userMessage ||
    data.prompt ||
    data.message ||
    data.input ||
    (data.extra && (data.extra.user_message || data.extra.prompt || data.extra.message))
}

const HERMES_APPROVAL_MATCH_WINDOW_MS = 10 * 60 * 1000
const HERMES_SUBAGENT_SPAWN_WINDOW_MS = 15 * 1000

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function directHermesSessionId(data) {
  const extra = data.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {}
  const extraSessionKey = nonEmptyString(extra.session_key)
  return nonEmptyString(data.session_id) ||
    nonEmptyString(data.session_key) ||
    nonEmptyString(extra.task_id) ||
    (extraSessionKey && extraSessionKey !== 'default' ? extraSessionKey : undefined)
}

function hermesRuntime(data) {
  return {
    terminalSessionId: nonEmptyString(data.terminal_session_id),
    terminalTty: nonEmptyString(data.terminal_tty),
    pid: data.pid === undefined || data.pid === null ? undefined : nonEmptyString(String(data.pid)),
    hostName: nonEmptyString(data._hostname)
  }
}

function hasHermesRuntime(runtime) {
  return Boolean(runtime && (runtime.terminalSessionId || runtime.terminalTty || runtime.pid || runtime.hostName))
}

// Keep HermesAdapter.hasMatchingRuntimeContext aligned with the reference behavior.
function hermesRuntimeMatches(left, right) {
  if (!left || !right) return false
  if (left.terminalSessionId && right.terminalSessionId) return left.terminalSessionId === right.terminalSessionId
  if (left.pid && right.pid && left.terminalTty && right.terminalTty) {
    return left.pid === right.pid && left.terminalTty === right.terminalTty
  }
  if (left.pid && right.pid && left.hostName && right.hostName) {
    return left.pid === right.pid && left.hostName === right.hostName
  }
  if (left.terminalTty && right.terminalTty && left.hostName && right.hostName) {
    return left.terminalTty === right.terminalTty && left.hostName === right.hostName
  }
  return Boolean(left.pid && right.pid && left.pid === right.pid)
}

function hermesTrackingDir(kind) {
  return path.join(hookContext.paths.runDir, 'hermes-hooks', kind)
}

function writeHermesTracking(filePath, value) {
  const tempPath = `${filePath}.tmp.${process.pid}`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function readHermesTracking(kind, now) {
  const dir = hermesTrackingDir(kind)
  const entries = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const filePath = path.join(dir, name)
      try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (!value || !Number.isFinite(value.timestamp) || now - value.timestamp > HERMES_APPROVAL_MATCH_WINDOW_MS) {
          try { fs.unlinkSync(filePath) } catch (_) {}
          continue
        }
        entries.push(value)
      } catch (_) {}
    }
  } catch (_) {}
  return entries
}

function rememberHermesSession(sessionId, data, now) {
  const filePath = path.join(hermesTrackingDir('sessions'), `${safeSessionId(sessionId)}.json`)
  let previous = null
  try { previous = JSON.parse(fs.readFileSync(filePath, 'utf-8')) } catch (_) {}
  const runtime = hermesRuntime(data)
  const oldRuntime = previous && previous.runtime ? previous.runtime : {}
  writeHermesTracking(filePath, {
    sessionId,
    timestamp: now,
    runtime: {
      terminalSessionId: runtime.terminalSessionId || oldRuntime.terminalSessionId,
      terminalTty: runtime.terminalTty || oldRuntime.terminalTty,
      pid: runtime.pid || oldRuntime.pid,
      hostName: runtime.hostName || oldRuntime.hostName
    }
  })
}

function normalizeHermesCommand(command) {
  const value = nonEmptyString(command)
  return value ? value.replace(/\s+/g, ' ').trim() : undefined
}

function hermesToolCommand(data) {
  const input = data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input)
    ? data.tool_input
    : {}
  return normalizeHermesCommand(input.command)
}

function hermesApprovalCommand(data) {
  const extra = data.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {}
  return normalizeHermesCommand(data.command || extra.command)
}

function rememberHermesCommand(kind, sessionId, command, now) {
  if (!command) return
  const filePath = path.join(hermesTrackingDir(kind), `${now}-${process.pid}.json`)
  writeHermesTracking(filePath, { sessionId, command, timestamp: now })
}

function resolveHermesSessionId(data, eventName, now) {
  const direct = directHermesSessionId(data)
  if (direct) return direct
  const event = String(eventName || '').toLowerCase()
  if (event !== 'pre_approval_request' && event !== 'post_approval_response') return undefined

  const command = hermesApprovalCommand(data)
  if (command) {
    const approvals = readHermesTracking('approval-commands', now)
      .filter(item => item.command === command)
      .sort((left, right) => right.timestamp - left.timestamp)
    if (approvals[0]) return approvals[0].sessionId
    const invocations = readHermesTracking('commands', now)
      .filter(item => item.command === command)
      .sort((left, right) => right.timestamp - left.timestamp)
    if (invocations[0]) return invocations[0].sessionId
  }

  const runtime = hermesRuntime(data)
  const sessions = readHermesTracking('sessions', now)
  if (hasHermesRuntime(runtime)) {
    const matches = sessions.filter(item => hermesRuntimeMatches(runtime, item.runtime))
    if (matches.length === 1) return matches[0].sessionId
    if (matches.length > 1) return undefined
  }

  sessions.sort((left, right) => right.timestamp - left.timestamp)
  return sessions[0] && sessions[0].sessionId
}

function resolveHermesSessionFromRecentRuntime(data, now) {
  const runtime = hermesRuntime(data)
  if (!hasHermesRuntime(runtime)) return undefined
  const matches = readHermesTracking('sessions', now)
    .filter(item => now - item.timestamp <= HERMES_SUBAGENT_SPAWN_WINDOW_MS)
    .filter(item => hermesRuntimeMatches(runtime, item.runtime))
    .sort((left, right) => right.timestamp - left.timestamp)
  return matches[0] && matches[0].sessionId
}

function clearHermesTracking(sessionId, now) {
  try { fs.unlinkSync(path.join(hermesTrackingDir('sessions'), `${safeSessionId(sessionId)}.json`)) } catch (_) {}
  for (const kind of ['commands', 'approval-commands']) {
    for (const entry of readHermesTracking(kind, now)) {
      if (entry.sessionId !== sessionId) continue
      const dir = hermesTrackingDir(kind)
      try {
        for (const name of fs.readdirSync(dir)) {
          const filePath = path.join(dir, name)
          try {
            const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            if (value && value.sessionId === sessionId) fs.unlinkSync(filePath)
          } catch (_) {}
        }
      } catch (_) {}
      break
    }
  }
  const childrenDir = hermesTrackingDir('children')
  try {
    for (const name of fs.readdirSync(childrenDir)) {
      const filePath = path.join(childrenDir, name)
      try {
        const binding = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (name === `${safeSessionId(sessionId)}.json` || binding.parentSessionId === sessionId) {
          fs.unlinkSync(filePath)
        }
      } catch (_) {}
    }
  } catch (_) {}

  const launchesDir = hermesTrackingDir('pending-launches')
  try {
    for (const name of fs.readdirSync(launchesDir)) {
      const filePath = path.join(launchesDir, name)
      try {
        const launch = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (launch.parentSessionId === sessionId) fs.unlinkSync(filePath)
      } catch (_) {}
    }
  } catch (_) {}
}

function hermesExtra(data) {
  return data.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {}
}

function hermesFirstString(data, keys) {
  const extra = hermesExtra(data)
  for (const source of [data, extra]) {
    for (const key of keys) {
      const value = nonEmptyString(source[key])
      if (value) return value
    }
  }
  return undefined
}

function hermesParentSessionId(data) {
  return hermesFirstString(data, ['parent_session_id', 'parent_id', 'forked_from_id'])
}

function hermesChildSessionId(data) {
  return hermesFirstString(data, ['child_session_id', 'child_id'])
}

function hermesSubagentId(data) {
  return hermesFirstString(data, ['agent_id', 'child_session_id', 'child_id'])
}

function hasHermesSubagentMetadata(data) {
  const extra = hermesExtra(data)
  return Boolean(['child_role', 'child_type', 'child_summary', 'child_status', 'child_id']
    .some(key => nonEmptyString(extra[key])))
}

function hermesChildMarkerPath(childSessionId) {
  return path.join(hermesTrackingDir('children'), `${safeSessionId(childSessionId)}.json`)
}

function readHermesChildBinding(childSessionId) {
  if (!childSessionId) return null
  try { return JSON.parse(fs.readFileSync(hermesChildMarkerPath(childSessionId), 'utf-8')) } catch (_) { return null }
}

function writeHermesChildBinding(childSessionId, binding) {
  writeHermesTracking(hermesChildMarkerPath(childSessionId), binding)
}

function removeHermesChildBinding(childSessionId) {
  if (!childSessionId) return
  try { fs.unlinkSync(hermesChildMarkerPath(childSessionId)) } catch (_) {}
}

function rememberHermesPendingLaunch(sessionId, data, now) {
  const toolName = String(getToolName(data) || '').trim().toLowerCase().replace(/_/g, '')
  if (toolName !== 'delegatetask') return
  const filePath = path.join(hermesTrackingDir('pending-launches'), `${now}-${process.pid}.json`)
  writeHermesTracking(filePath, {
    parentSessionId: sessionId,
    timestamp: now,
    runtime: hermesRuntime(data),
    toolName: getToolName(data),
    taskDescription: getToolDetails(getToolName(data), getToolInput(data))
  })
}

function consumeHermesPendingLaunch(data, now) {
  const runtime = hermesRuntime(data)
  if (!hasHermesRuntime(runtime)) return null
  const dir = hermesTrackingDir('pending-launches')
  const candidates = []
  try {
    for (const name of fs.readdirSync(dir)) {
      const filePath = path.join(dir, name)
      try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (!value || now - value.timestamp > HERMES_SUBAGENT_SPAWN_WINDOW_MS) {
          try { fs.unlinkSync(filePath) } catch (_) {}
          continue
        }
        if (hermesRuntimeMatches(runtime, value.runtime)) candidates.push({ filePath, value })
      } catch (_) {}
    }
  } catch (_) {}
  candidates.sort((left, right) => right.value.timestamp - left.value.timestamp)
  const match = candidates[0]
  if (!match) return null
  try { fs.unlinkSync(match.filePath) } catch (_) {}
  return match.value
}

function hermesBoolean(data, key) {
  if (typeof data[key] === 'boolean') return data[key]
  const nested = hermesExtra(data)[key]
  return typeof nested === 'boolean' ? nested : undefined
}

function handleHermesChildEvent(data, childSessionId, parentSessionId, eventName, now, fallback = {}) {
  if (!childSessionId || !parentSessionId || childSessionId === parentSessionId) return false
  const existing = readHermesChildBinding(childSessionId)
  const agentId = hermesSubagentId(data) || fallback.agentId || (existing && existing.agentId) || childSessionId
  const nickname = hermesFirstString(data, ['child_role', 'child_type', 'agent_type']) ||
    fallback.agentType || (existing && existing.agentType) || 'subagent'
  const task = hermesFirstString(data, ['child_summary', 'description', 'task']) ||
    fallback.taskDescription || (existing && existing.taskDescription)
  const binding = { parentSessionId, agentId, agentType: nickname, taskDescription: task, timestamp: now }
  writeHermesChildBinding(childSessionId, binding)

  if (!existing) {
    upsertSubagent(parentSessionId, agentId, {
      nickname,
      title: titleFromPrompt(task, 'subagent'),
      lastToolActivity: task || undefined,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }

  const event = String(eventName || '').toLowerCase()
  if (event === 'pre_tool_call') {
    upsertSubagent(parentSessionId, agentId, {
      nickname,
      title: titleFromPrompt(task, 'subagent'),
      lastToolActivity: getToolDetails(getToolName(data), getToolInput(data)),
      phase: 'running',
      updatedAt: now
    })
  } else if (event === 'post_tool_call') {
    upsertSubagent(parentSessionId, agentId, {
      nickname,
      title: titleFromPrompt(task, 'subagent'),
      lastToolActivity: `${getToolName(data)} done`,
      phase: 'running',
      updatedAt: now
    })
  } else if (event === 'pre_llm_call') {
    upsertSubagent(parentSessionId, agentId, {
      nickname,
      title: titleFromPrompt(task, 'subagent'),
      lastToolActivity: 'Thinking...',
      phase: 'running',
      updatedAt: now
    })
  } else if (event === 'on_session_end') {
    removeSubagent(parentSessionId, agentId, now, data.reason || data.message)
    removeHermesChildBinding(childSessionId)
  }
  return true
}

function routeHermesChildEvent(data, sessionId, eventName, now) {
  const explicitParent = hermesParentSessionId(data)
  const mapped = readHermesChildBinding(sessionId)
  const parentSessionId = explicitParent || (mapped && mapped.parentSessionId)
  const directChild = hermesChildSessionId(data)
  const childSessionId = directChild || (parentSessionId ? sessionId : undefined)
  if (childSessionId && parentSessionId) {
    return handleHermesChildEvent(data, childSessionId, parentSessionId, eventName, now)
  }

  const event = String(eventName || '').toLowerCase()
  const sessionMarker = path.join(hermesTrackingDir('sessions'), `${safeSessionId(sessionId)}.json`)
  const knownSession = fs.existsSync(sessionMarker)
  if (!knownSession && !hermesSubagentId(data) && !hasHermesSubagentMetadata(data) &&
    (event === 'on_session_start' || event === 'pre_llm_call')) {
    const launch = consumeHermesPendingLaunch(data, now)
    if (launch) {
      return handleHermesChildEvent(data, sessionId, launch.parentSessionId, eventName, now, {
        agentId: sessionId,
        agentType: launch.toolName,
        taskDescription: launch.taskDescription
      })
    }
  }

  // The reference adapter ACKs unowned child metadata rather than inventing a top-level row.
  if ((hermesSubagentId(data) || hasHermesSubagentMetadata(data)) &&
    event !== 'subagent_start' && event !== 'subagent_stop') return true
  return false
}

function hermesResponse(data) {
  return data.last_assistant_message ||
    data.assistant_message ||
    data.response ||
    data.output ||
    data.text ||
    data.message ||
    (data.extra && (data.extra.last_assistant_message || data.extra.response || data.extra.output))
}

function handleHermes(data, sessionId, eventName, now) {
  const event = String(eventName || '').toLowerCase()
  rememberHermesSession(sessionId, data, now)
  if (event === 'on_session_start' || event === 'on_session_reset') {
    return sessionStart(data, sessionId, now, data.session_title)
  }
  if (event === 'pre_llm_call') return promptSubmit(data, sessionId, now, hermesPrompt(data))
  if (event === 'post_llm_call') {
    return stop(Object.assign({}, data, { last_assistant_message: hermesResponse(data) }), sessionId, now, false)
  }
  if (event === 'pre_tool_call') {
    rememberHermesCommand('commands', sessionId, hermesToolCommand(data), now)
    rememberHermesPendingLaunch(sessionId, data, now)
    const toolName = getToolName(data)
    if (isHermesClarifyTool(toolName)) {
      const question = structuredQuestionText(getToolInput(data))
      if (question) return permissionRequest(data, sessionId, now, question)
    }
    return toolUse(data, sessionId, now)
  }
  if (event === 'post_tool_call') {
    const toolName = getToolName(data)
    postToolUse(data, sessionId, now, Boolean(data.error || data.error_message), {
      resolvePending: isHermesClarifyTool(getToolName(data))
    })
    return updateActivity(data, sessionId, now, `${toolName} done`)
  }
  if (event === 'pre_approval_request') {
    rememberHermesCommand('approval-commands', sessionId, hermesApprovalCommand(data), now)
    return permissionRequest(data, sessionId, now)
  }
  if (event === 'post_approval_response') {
    rememberHermesCommand('approval-commands', sessionId, hermesApprovalCommand(data), now)
    const payload = Object.assign({ tool_name: data.tool_name || data.toolName || 'approval' }, data)
    postToolUse(payload, sessionId, now, false)
    return updateActivity(data, sessionId, now, data.message || data.reason || data.status || 'Approval completed')
  }
  if (event === 'on_session_finalize') {
    resolvePendingInteraction(sessionId, data, now, 'session finalized')
    clearHermesTracking(sessionId, now)
    return updateSession(sessionId, Object.assign(baseUpdates(data, now), {
      lastEvent: { type: AGENT_EVENTS.SESSION_DELETE, timestamp: now, details: 'on_session_finalize' }
    }))
  }
  if (event === 'on_session_end') {
    resolvePendingInteraction(sessionId, data, now, data.reason || 'conversation ended')
    if (hermesBoolean(data, 'completed') === true) return
    return stop(Object.assign({}, data, {
      wasInterrupted: hermesBoolean(data, 'interrupted') === true
    }), sessionId, now, false)
  }
  if (event === 'subagent_start') {
    const childId = subagentId(data, now, 'hermes')
    const childSessionId = hermesChildSessionId(data)
    if (childSessionId) {
      writeHermesChildBinding(childSessionId, {
        parentSessionId: sessionId,
        agentId: childId,
        timestamp: now
      })
    }
    return upsertSubagent(sessionId, childId, {
      nickname: data.agent_name || data.agent_type || data.agentName || 'subagent',
      title: titleFromPrompt(data.prompt || data.description || data.task, 'subagent'),
      lastToolActivity: data.prompt || data.description || data.task || undefined,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }
  if (event === 'subagent_stop') {
    removeHermesChildBinding(hermesChildSessionId(data))
    return removeSubagent(sessionId, subagentId(data, now, 'hermes'), now, data.response || data.reason)
  }
}

function handlePayload(data) {
  const eventName = getEventName(data)
  const now = Date.now()
  // The reference TraexCliAdapter ACKs payloads without the protocol session_id. A cwd
  // fallback would merge unrelated turns into a synthetic BUSY session.
  if (agentType === 'traex' && !nonEmptyString(data.session_id)) return
  const resolvedSessionId = agentType === 'hermes'
    ? resolveHermesSessionId(data, eventName, now)
    : getSessionId(data)
  if (!resolvedSessionId) {
    if (agentType === 'hermes' && String(eventName || '').toLowerCase() === 'pre_tool_call') {
      const parentSessionId = resolveHermesSessionFromRecentRuntime(data, now)
      if (parentSessionId) rememberHermesPendingLaunch(parentSessionId, data, now)
    }
    // The reference adapter ACKs anonymous post_tool_call and every other unresolved Hermes
    // event without creating a synthetic session.
    return
  }
  const sessionId = String(resolvedSessionId)

  if (agentType === 'gemini') return handleGemini(data, sessionId, eventName, now)
  if (agentType === 'kimi') return handleKimi(data, sessionId, eventName, now)
  if (agentType === 'copilot-cli') return handleCopilot(data, sessionId, eventName, now)
  if (agentType === 'opencode') return handleOpenCode(data, sessionId, eventName, now)
  if (agentType === 'cursor') return handleCursor(data, sessionId, eventName, now)
  if (agentType === 'coco' || agentType === 'trae') return handleCoco(data, sessionId, eventName, now)
  if (agentType === 'traex') return handleTraex(data, sessionId, eventName, now)
  if (agentType === 'hermes') {
    if (routeHermesChildEvent(data, sessionId, eventName, now)) return
    return handleHermes(data, sessionId, eventName, now)
  }
  // There is no cross-agent regex lifecycle adapter. Unknown agents/events are
  // ACK-only so an incidental substring such as "frontend_update" cannot
  // synthesize DONE.
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
