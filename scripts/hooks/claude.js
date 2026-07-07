#!/usr/bin/env node
// tmux-scout Claude Code hook
// Tracks Claude session status with tmux pane mapping

const path = require('path')
const { createHookContext, liveSessionState, readStdin, isMeaningfulSubagentActivity } = require('../lib/hook-adapter')
const { AGENT_EVENTS } = require('../lib/agent-events')
const { classifyNotification } = require('../lib/notification-intent')

const hookContext = createHookContext({
  agentType: 'claude',
  defaultStateSource: 'claude-hooks',
  lifecycleForce: true
})

function updateSession(sessionId, updates) {
  hookContext.updateSession(sessionId, updates)
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

function eventBase(data, now) {
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
  updateSession(sessionId, liveSessionState(Object.assign(eventBase(data, now), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastEvent: {
      type: eventType,
      timestamp: now,
      details: details || pending.details || pending.reason,
      rawEventName: `${data.hook_event_name || 'hook'}:${eventType}`
    }
  })))
}

function normalizeSubagents(value) {
  return Array.isArray(value) ? value.filter(Boolean) : []
}

function getSubagentPayload(data) {
  const subAgent = data && (data.sub_agent || data.subAgent || data.subagent)
  return subAgent && typeof subAgent === 'object' ? subAgent : {}
}

function getSubagentId(data, fallback) {
  const subAgent = getSubagentPayload(data)
  return subAgent.id ||
    data.agent_id ||
    data.subagent_id ||
    data.sub_agent_id ||
    data.agentId ||
    fallback ||
    null
}

function getSubagentType(data) {
  const subAgent = getSubagentPayload(data)
  return subAgent.type ||
    subAgent.agent_type ||
    data.agent_type ||
    data.subagent_type ||
    data.agent_name ||
    undefined
}

function getSubagentTranscriptPath(data) {
  const subAgent = getSubagentPayload(data)
  return subAgent.transcript_path || subAgent.transcriptPath || data.subagent_transcript_path || undefined
}

function cleanInlineText(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
}

function titleFromText(value, fallback) {
  const text = cleanInlineText(value)
  if (text) return text.slice(0, 100)
  return fallback || undefined
}

function pendingSubagentDescription(data) {
  const toolName = data.tool_name || ''
  if (toolName !== 'Agent' && toolName !== 'Task') return null
  const input = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {}
  return cleanInlineText(input.description || input.prompt || input.task || '')
}

function pendingDescriptionUpdate(sessionId, description) {
  if (!description) return {}
  const current = hookContext.readSession(sessionId) || {}
  const queue = Array.isArray(current._pendingSubagentDescriptions)
    ? current._pendingSubagentDescriptions.filter(Boolean)
    : []
  queue.push(description)
  return { _pendingSubagentDescriptions: queue.slice(-20) }
}

function descriptionFromSubagentStart(data, parent) {
  const queue = Array.isArray(parent._pendingSubagentDescriptions)
    ? parent._pendingSubagentDescriptions.filter(Boolean)
    : []
  const queued = queue.shift()
  const subAgent = getSubagentPayload(data)
  const inline = cleanInlineText(
    data.task_description ||
    data.description ||
    data.prompt ||
    subAgent.description ||
    subAgent.prompt ||
    ''
  )
  return { description: queued || inline || undefined, queue }
}

function upsertSubagent(parentSessionId, agentId, patch) {
  if (!parentSessionId || !agentId) return false
  const parent = hookContext.readSession(parentSessionId) || {}
  const activeSubagents = normalizeSubagents(parent.activeSubagents)
  const index = activeSubagents.findIndex(item => item && item.agentId === agentId)
  const existing = index >= 0 ? activeSubagents[index] : { agentId }
  const updatedAt = patch.updatedAt || Date.now()
  const cleanPatch = {}
  for (const [key, value] of Object.entries(patch || {})) {
    if (key !== 'eventType' && value !== undefined) cleanPatch[key] = value
  }
  const next = Object.assign({}, existing, cleanPatch, {
    agentId,
    updatedAt
  })

  if (index >= 0) activeSubagents[index] = next
  else activeSubagents.push(next)

  updateSession(parentSessionId, {
    activeSubagents,
    lastSubagentUpdatedAt: updatedAt,
    lastEvent: {
      type: patch.eventType || AGENT_EVENTS.SUBAGENT_TOOL_ACTIVITY,
      timestamp: updatedAt,
      details: patch.lastToolActivity || patch.taskDescription || patch.title
    }
  })
  return true
}

function removeSubagent(parentSessionId, agentId, now, details) {
  if (!parentSessionId) return false
  const parent = hookContext.readSession(parentSessionId) || {}
  const activeSubagents = normalizeSubagents(parent.activeSubagents)
  let removed = false
  let next = activeSubagents

  if (agentId) {
    next = activeSubagents.filter(item => {
      const keep = item && item.agentId !== agentId
      if (!keep) removed = true
      return keep
    })
  } else if (activeSubagents.length === 1) {
    next = []
    removed = true
  }

  if (!removed) return false
  updateSession(parentSessionId, {
    activeSubagents: next,
    lastSubagentUpdatedAt: now,
    lastEvent: { type: AGENT_EVENTS.SUBAGENT_STOP, timestamp: now, details }
  })
  return true
}

function findParentSessionIdForSubagent(data, fallbackSessionId) {
  const subAgent = getSubagentPayload(data)
  const explicit = data.parent_session_id ||
    data.parentSessionId ||
    data.parent_thread_id ||
    subAgent.parent_session_id ||
    subAgent.parentSessionId
  if (explicit) return explicit

  const agentId = getSubagentId(data)
  if (!agentId) return fallbackSessionId
  const status = hookContext.readStatus()
  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    const activeSubagents = normalizeSubagents(session.activeSubagents)
    if (activeSubagents.some(item => item && item.agentId === agentId)) {
      return sessionId
    }
  }
  return fallbackSessionId
}

function startSubagent(sessionId, data, now) {
  const parent = hookContext.readSession(sessionId) || {}
  const { description, queue } = descriptionFromSubagentStart(data, parent)
  const agentId = getSubagentId(data, `claude-subagent-${now}`)
  const agentType = getSubagentType(data)
  const title = titleFromText(description || data.title || data.name, agentType || 'subagent')
  const activeSubagents = normalizeSubagents(parent.activeSubagents)
  const index = activeSubagents.findIndex(item => item && item.agentId === agentId)
  const existing = index >= 0 ? activeSubagents[index] : { agentId }
  const next = Object.assign({}, existing, {
    agentId,
    agentType,
    nickname: agentType || data.agent_name || 'subagent',
    title,
    taskDescription: description,
    transcriptPath: getSubagentTranscriptPath(data),
    phase: 'running',
    startedAt: existing.startedAt || now,
    updatedAt: now
  })

  if (index >= 0) activeSubagents[index] = next
  else activeSubagents.push(next)

  updateSession(sessionId, {
    activeSubagents,
    _pendingSubagentDescriptions: queue,
    needsAttention: null,
    pendingToolUse: null,
    activeTool: null,
    lastSubagentUpdatedAt: now,
    lastEvent: { type: AGENT_EVENTS.SUBAGENT_START, timestamp: now, details: title }
  })
}

function subagentToolActivity(data) {
  const eventName = data.hook_event_name
  const toolName = data.tool_name || 'Tool'
  if (eventName === 'PostToolUse') return `${toolName} done`
  if (eventName === 'PostToolUseFailure') {
    const error = data.error || data.error_message || data.message || data.reason
    return error ? `${toolName} failed: ${String(error).slice(0, 80)}` : `${toolName} failed`
  }
  return getToolDetails(toolName, data.tool_input)
}

function updateSubagentToolActivity(data, fallbackSessionId, now) {
  const agentId = getSubagentId(data)
  if (!agentId) return false
  const parentSessionId = findParentSessionIdForSubagent(data, fallbackSessionId)
  if (!parentSessionId) return false
  const activity = subagentToolActivity(data)
  const agentType = getSubagentType(data)
  const questionTool = isQuestionTool(data.tool_name)
  const waitingEvent = data.hook_event_name === 'PermissionRequest'
  const patch = {
    phase: data.hook_event_name === 'PostToolUseFailure'
      ? 'failed'
      : waitingEvent
        ? (questionTool ? 'waitingForAnswer' : 'waitingForApproval')
        : 'running',
    // Keep the prior meaningful tool line when this update carries only a
    // generic placeholder (undefined here is dropped by upsertSubagent).
    lastToolActivity: isMeaningfulSubagentActivity(activity) ? activity : undefined,
    updatedAt: now,
    eventType: AGENT_EVENTS.SUBAGENT_TOOL_ACTIVITY
  }
  if (agentType) {
    patch.agentType = agentType
    patch.nickname = agentType
  } else if (data.agent_name) {
    patch.nickname = data.agent_name
  }
  return upsertSubagent(parentSessionId, agentId, patch)
}

function handleClaudeHook(data) {
  const { session_id, hook_event_name, tool_name, tool_input, prompt, source, reason } = data

  if (!session_id) {
    return
  }

  const now = Date.now()
  const tmuxPane = process.env.TMUX_PANE || null
  const pid = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : null

  const subagentId = getSubagentId(data)
  if (subagentId && hook_event_name !== 'SubagentStart' && hook_event_name !== 'SubagentStop') {
    updateSubagentToolActivity(data, session_id, now)
    return
  }

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
        lastEvent: { type: AGENT_EVENTS.SESSION_START, timestamp: now, details: source }
      })))
      break

    case 'UserPromptSubmit': {
      resolvePendingInteraction(session_id, data, now, 'user prompt submitted')
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
        lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: now, details: title }
      })))
      break
    }

    case 'PreToolUse': {
      resolvePendingInteraction(session_id, data, now, getToolDetails(tool_name, tool_input))
      const toolDetails = getToolDetails(tool_name, tool_input)
      const attentionTools = ['ExitPlanMode', 'AskUserQuestion', 'mcp__conductor__AskUserQuestion']
      const needsAttention = attentionTools.includes(tool_name)
      const questionTool = isQuestionTool(tool_name)
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), pendingDescriptionUpdate(session_id, pendingSubagentDescription(data)), {
        status: 'working',
        needsAttention: needsAttention ? tool_name : null,
        pendingToolUse: { tool: tool_name || 'unknown', details: toolDetails, timestamp: now },
        activeTool: tool_name || 'unknown',
        lastEvent: { type: AGENT_EVENTS.TOOL_USE, timestamp: now, details: toolDetails },
        lifecycleEvent: needsAttention ? {
          type: questionTool ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.PERMISSION_REQUEST,
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
          type: questionTool ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.PERMISSION_REQUEST,
          timestamp: now,
          details: toolDetails
        }
      })))
      break
    }

    case 'PostToolUse':
      resolvePendingInteraction(session_id, data, now, tool_name || 'tool completed')
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        pendingToolUse: null,
        activeTool: null,
        lastEvent: { type: AGENT_EVENTS.POST_TOOL_USE, timestamp: now },
      })))
      break

    case 'PostToolUseFailure': {
      const toolDetails = getToolDetails(tool_name, tool_input)
      const error = data.error || data.error_message || data.message || data.reason
      const details = error ? `${toolDetails} failed: ${String(error).slice(0, 80)}` : `${toolDetails} failed`
      resolvePendingInteraction(session_id, data, now, details)
      updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
        status: 'working',
        needsAttention: null,
        pendingToolUse: null,
        activeTool: null,
        lastToolError: error || true,
        lastEvent: { type: AGENT_EVENTS.POST_TOOL_USE_FAILURE, timestamp: now, details }
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
        lastEvent: { type: AGENT_EVENTS.STOP, timestamp: now },
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
          type: AGENT_EVENTS.STOP_FAILURE,
          timestamp: now,
          details: data.error_details || data.error_detail || data.error || data.message || data.reason
        }
      }))
      break

    case 'SubagentStart':
      startSubagent(session_id, data, now)
      break

    case 'SubagentStop': {
      const parentSessionId = findParentSessionIdForSubagent(data, session_id)
      removeSubagent(parentSessionId, getSubagentId(data), now, data.reason || data.response || data.message)
      break
    }

    case 'Notification': {
      // Claude signals "the agent needs the user" only through Notification text
      // ("Claude needs your permission" / "...approval for the plan" / "Claude is
      // waiting for your input"). Standard Claude Code never delivers a real
      // PermissionRequest hook, so without classifying this the session stays
      // stuck showing BUSY, so normalize every waiting signal into an explicit
      // lifecycle event through the one reducer.
      const { intent, details, tool } = classifyNotification(data)
      const notificationText = data.message || data.notification || data.title || details || null

      if (intent === 'permission' || intent === 'plan' || intent === 'question') {
        const questionIntent = intent === 'question'
        const eventType = questionIntent ? AGENT_EVENTS.QUESTION_ASKED : AGENT_EVENTS.PERMISSION_REQUEST
        const attentionReason = questionIntent
          ? 'waiting for answer'
          : intent === 'plan' ? 'waiting for plan approval' : 'waiting for approval'
        const session = hookContext.readSession(session_id)
        const knownTool = tool ||
          (session && session.activeTool) ||
          (session && session.pendingToolUse && session.pendingToolUse.tool) ||
          undefined
        const waitDetails = details || attentionReason
        const pendingToolUse = knownTool ? { tool: knownTool, details: waitDetails, timestamp: now } : undefined
        updateSession(session_id, liveSessionState(Object.assign(eventBase(data, now, tmuxPane, pid), {
          status: 'working',
          needsAttention: attentionReason,
          lastNotification: notificationText,
          pendingToolUse: pendingToolUse || null,
          activeTool: knownTool || null,
          lastEvent: { type: eventType, timestamp: now, details: waitDetails },
          lifecycleEvent: {
            type: eventType,
            source: 'hook',
            stateSource: 'claude-hooks',
            timestamp: now,
            details: waitDetails,
            attentionReason,
            pendingToolUse,
            activeTool: knownTool || undefined,
            force: true
          }
        })))
        break
      }

      if (intent === 'idle') {
        // "Claude is waiting for your input" — turn ended / idle at the prompt.
        // Only demote a still-running session to completed; never resurrect a
        // completed/idle session or clobber a real pending WAIT.
        const session = hookContext.readSession(session_id)
        if (session && session.phase === 'running') {
          updateSession(session_id, Object.assign(eventBase(data, now, tmuxPane, pid), {
            status: 'completed',
            needsAttention: null,
            pendingToolUse: null,
            activeTool: null,
            lastNotification: notificationText,
            lastEvent: { type: AGENT_EVENTS.TURN_COMPLETE, timestamp: now, details: 'idle prompt' }
          }))
          break
        }
      }

      // Informational notification (or idle on a non-running session): record it
      // without touching the state machine.
      updateSession(session_id, {
        lastNotification: notificationText,
        lastEvent: {
          type: AGENT_EVENTS.NOTIFICATION,
          timestamp: now,
          details: notificationText
        },
        tmuxPane,
        pid
      })
      break
    }

    case 'PreCompact':
      updateSession(session_id, {
        lastCompactAt: now,
        lastCompactReason: data.trigger || data.reason || null,
        lastEvent: {
          type: AGENT_EVENTS.PRE_COMPACT,
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
        lastEvent: { type: AGENT_EVENTS.SESSION_END, timestamp: now, details: reason },
        tmuxPane,
        pid
      })
      break
  }
}

async function main() {
  const input = await readStdin()
  if (!input.trim()) return

  let data
  try {
    data = JSON.parse(input)
  } catch (_) {
    return
  }

  handleClaudeHook(data)
  await hookContext.flush()
}

const adapter = {
  agentId: 'claude',
  handle: handleClaudeHook
}

module.exports = {
  adapter,
  handleClaudeHook,
  getToolDetails
}

if (require.main === module) {
  main().catch(() => process.exit(0))
}
