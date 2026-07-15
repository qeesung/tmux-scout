#!/usr/bin/env node
// tmux-scout Codex hook
// Handles modern Codex event hooks from stdin and legacy notify payloads from argv.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
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
    _codexHookManaged: data.hook_event_name ? true : undefined,
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
  updateSession(sessionId, Object.assign({}, baseUpdates(data, now), codexNativeApprovalUpdates(session, data.hook_event_name), {
    status: 'working',
    needsAttention: null,
    pendingToolUse: null,
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

function compactText(value, max = 160) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? text.slice(0, max - 1) + '~' : text
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => {
      return JSON.stringify(key) + ':' + stableStringify(value[key])
    }).join(',') + '}'
  }
  return JSON.stringify(value)
}

function codexNativeRequestId(toolName, toolInput) {
  const input = stableStringify(toolInput || {})
  const hash = crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
  return `${toolName || 'unknown'}:${hash}`
}

function codexApprovedRequestIds(session) {
  return Array.isArray(session && session._codexNativeApprovedRequestIds)
    ? session._codexNativeApprovedRequestIds.filter(value => typeof value === 'string' && value)
    : []
}

function hasCodexApprovedRequest(session, requestId) {
  return Boolean(requestId && codexApprovedRequestIds(session).includes(requestId))
}

function codexNativeApprovalUpdates(session, eventName) {
  const pendingRequestId = session && session._codexPendingNativeRequestId
  if (!pendingRequestId) return {}
  if (eventName !== 'PreToolUse' && eventName !== 'PostToolUse') return {}
  const approved = codexApprovedRequestIds(session).filter(value => value !== pendingRequestId)
  approved.unshift(pendingRequestId)
  return {
    _codexPendingNativeRequestId: null,
    _codexNativeApprovedRequestIds: approved.slice(0, 50)
  }
}

function questionDetailsFromToolInput(toolInput) {
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput : null
  if (!input) return null
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    const first = input.questions.find(item => item && typeof item === 'object')
    if (first) {
      return compactText(first.question || first.header || first.id, 160) || 'request_user_input'
    }
    return 'request_user_input'
  }
  return compactText(input.message || input.prompt || input.description, 160) || null
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

// Stop becomes WAIT only for the exact structured Chinese numbered-question
// shape accepted by the protocol; English punctuation, payload flags, and
// generic option lists do not gain independent state semantics here.
function parseCodexQuestions(message) {
  if (typeof message !== 'string' || !message.includes('？')) return []
  const items = []
  let currentQuestion = ''
  let currentChoices = []

  function flush() {
    if (!currentQuestion) return
    items.push({ question: currentQuestion.trim(), choices: currentChoices })
    currentQuestion = ''
    currentChoices = []
  }

  for (const line of message.split('\n')) {
    const trimmed = line.trim()
    const numbered = trimmed.match(/^\d+[\.．、]\s*(.+)/)
    if (numbered && trimmed.includes('？')) {
      flush()
      currentQuestion = numbered[1]
      continue
    }
    const dashItem = trimmed.match(/^[-•－]\s*(.+)/)
    if (!dashItem || !currentQuestion) continue
    const text = dashItem[1].trim()
    if (text.startsWith('例如') || text.startsWith('如：')) {
      currentChoices.push(...text
        .replace(/^例如[：:]?\s*/, '')
        .replace(/^如[：:]?\s*/, '')
        .split(/\s*[\/／、]\s*/)
        .filter(Boolean))
    } else if (text.endsWith('？')) {
      flush()
      currentQuestion = text
    } else {
      currentChoices.push(text)
    }
  }
  flush()
  return items
}

function codexStopWantsAnswer(_data, lastAssistantMessage) {
  return parseCodexQuestions(lastAssistantMessage).length > 0
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

function readApprovalPolicy(transcriptPath, maxBytes = 1024 * 1024) {
  if (!transcriptPath) return undefined
  let fd = null
  try {
    fd = fs.openSync(transcriptPath, 'r')
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes))
    let offset = 0
    let carry = ''
    while (offset < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - offset), offset)
      if (bytesRead <= 0) break
      offset += bytesRead
      carry += buffer.toString('utf-8', 0, bytesRead)
      const lines = carry.split('\n')
      carry = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line)
          const policy = obj &&
            obj.type === 'turn_context' &&
            obj.payload &&
            typeof obj.payload.approval_policy === 'string'
            ? obj.payload.approval_policy
            : undefined
          if (policy) return policy
        } catch (_) {}
      }
    }
    if (carry.trim()) {
      try {
        const obj = JSON.parse(carry)
        if (obj && obj.type === 'turn_context' && typeof obj.payload?.approval_policy === 'string') {
          return obj.payload.approval_policy
        }
      } catch (_) {}
    }
  } catch (_) {
    return undefined
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
  return undefined
}

// Scan backwards in 64 KiB chunks until a
// user_message is found or the file head is reached. There is deliberately no
// total-byte cap; a late watcher must still confirm a long-running real turn.
function readLastUserPrompt(transcriptPath) {
  if (!transcriptPath) return undefined
  const newlineByte = 0x0a
  const carriageReturnByte = 0x0d
  const readChunkBytes = 64 * 1024
  let fd = -1
  try {
    const stat = fs.statSync(transcriptPath)
    if (stat.size <= 0) return undefined
    fd = fs.openSync(transcriptPath, 'r')
    const buffer = Buffer.alloc(readChunkBytes)
    let position = stat.size
    let trailing = Buffer.alloc(0)

    function matchLine(lineBuffer) {
      const end = lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === carriageReturnByte
        ? lineBuffer.length - 1
        : lineBuffer.length
      const line = lineBuffer.subarray(0, end).toString('utf8')
      try {
        const obj = JSON.parse(line)
        if (obj &&
          obj.type === 'event_msg' &&
          obj.payload &&
          obj.payload.type === 'user_message' &&
          typeof obj.payload.message === 'string') {
          return cleanPrompt(obj.payload.message)
        }
      } catch (_) {}
      return undefined
    }

    while (position > 0) {
      const readLength = Math.min(buffer.length, position)
      position -= readLength
      const bytesRead = fs.readSync(fd, buffer, 0, readLength, position)
      if (bytesRead <= 0) break

      const chunk = buffer.subarray(0, bytesRead)
      const combined = trailing.length > 0 ? Buffer.concat([chunk, trailing]) : chunk
      let end = combined.length
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== newlineByte) continue
        const lineBuffer = combined.subarray(index + 1, end)
        end = index
        if (lineBuffer.length === 0) continue
        const matched = matchLine(lineBuffer)
        if (matched !== undefined) return matched
      }
      trailing = Buffer.from(combined.subarray(0, end))
    }

    return trailing.length > 0 ? matchLine(trailing) : undefined
  } catch (_) {
    return undefined
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd) } catch (_) {}
    }
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

// Codex multi-agent hooks may route a child event with session_id equal to
// parent_thread_id. In
// that protocol shape the real child identity lives in session_meta.id.
function linkSubagentFromSessionMeta(sessionId, meta) {
  if (!meta || typeof meta !== 'object') return null
  const source = meta.source && typeof meta.source === 'object' && !Array.isArray(meta.source)
    ? meta.source
    : null
  const subagent = source && source.subagent && typeof source.subagent === 'object' && !Array.isArray(source.subagent)
    ? source.subagent
    : null
  const threadSpawn = subagent && subagent.thread_spawn && typeof subagent.thread_spawn === 'object'
    ? subagent.thread_spawn
    : null
  const parentSessionId = threadSpawn && threadSpawn.parent_thread_id
  if (!parentSessionId) return null

  const depth = Number.isFinite(threadSpawn.depth) ? threadSpawn.depth : 1
  if (depth > 1) return null

  const childSessionId = parentSessionId === sessionId ? meta.id : sessionId
  if (!childSessionId || childSessionId === parentSessionId) return null

  return {
    parentSessionId,
    childSessionId,
    depth,
    nickname: meta.agent_nickname || threadSpawn.agent_nickname || null
  }
}

function codexSubagentRoute(data, sessionId, classification) {
  // Internal/background sessions are not collaboration children, even if an
  // unrelated payload field happens to be named agent_id.
  if (classification && classification.hidden && !classification.isSubagent) return null

  const meta = data._session_meta || readTranscriptSessionMeta(data.transcript_path)
  const metaRoute = linkSubagentFromSessionMeta(sessionId, meta)
  const agentId = typeof data.agent_id === 'string' && data.agent_id
    ? data.agent_id
    : null

  // Give payload.agent_id priority for child activity/stop events. It is
  // the only per-child identity when all children share the parent's
  // session_id. session_meta remains the source of parent/nickname metadata.
  if (agentId && agentId !== sessionId) {
    const parentSessionId = metaRoute
      ? metaRoute.parentSessionId
      : sessionId
    if (agentId === parentSessionId) return metaRoute
    return Object.assign({}, metaRoute || {}, {
      parentSessionId,
      childSessionId: agentId
    })
  }

  return metaRoute
}

function markHiddenSession(sessionId, base, classification, now, details, linkParent = true) {
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

  if (linkParent && classification.isSubagent && classification.parentSessionId) {
    upsertParentSubagent(classification.parentSessionId, sessionId, {
      nickname: classification.subagentNickname || 'subagent',
      depth: classification.subagentDepth,
      phase: 'running',
      startedAt: now,
      updatedAt: now
    })
  }
}

function isCodexUserConfirmed(session) {
  return Boolean(session && (session._codexUserConfirmed === true || cleanPrompt(session.lastUserPrompt || '')))
}

function markSilentCodexSession(sessionId, base, now, details) {
  markHiddenSession(sessionId, base, {
    hidden: true,
    isInternal: true,
    isSubagent: false,
    reason: 'codex-unconfirmed-session'
  }, now, details || 'codex-unconfirmed-session')
}

function backfillPromptFromTranscriptIfNeeded(sessionId, data, base, now) {
  const existing = readSession(sessionId)
  if (isCodexUserConfirmed(existing)) return { proceed: true, confirmed: true }

  const transcriptPath = data.transcript_path
  if (!transcriptPath) return { proceed: true, confirmed: false }

  const prompt = readLastUserPrompt(transcriptPath)
  if (!prompt) return { proceed: true, confirmed: false }

  const classification = classifyCodexSession({ prompt, sessionMeta: data._session_meta || readTranscriptSessionMeta(transcriptPath) })
  if (classification.hidden) {
    markHiddenSession(sessionId, base, classification, now, data.hook_event_name)
    return { proceed: false, confirmed: false }
  }

  const title = titleFromPrompt(prompt)
  updateSession(sessionId, Object.assign({}, base, {
    status: existing && existing.status ? existing.status : 'idle',
    sessionTitle: existing && existing.sessionTitle ? existing.sessionTitle : title,
    lastUserPrompt: prompt,
    _codexUserConfirmed: true,
    lastEvent: existing && existing.lastEvent
      ? existing.lastEvent
      : { type: AGENT_EVENTS.SESSION_START, timestamp: now - 1, details: 'backfilled from transcript' }
  }))
  // updateSession is queued by hook-adapter. Return the synchronous fact as
  // well so this same hook invocation (notably a first-event Stop) does not
  // re-read the old file and misclassify a confirmed session as internal.
  return { proceed: true, confirmed: true }
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
  // Codex child hooks can carry the parent in session_id and the actual child
  // in agent_id. Keep the child identity precise so one child cannot update or
  // remove a sibling (or the parent itself).
  const childSessionId = data.agent_id || session.sessionId || data.session_id || data.thread_id
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
    const isQuestionTool = toolName === 'request_user_input'
    const details = isQuestionTool
      ? questionDetailsFromToolInput(data.tool_input)
      : getToolDetails(toolName, data.tool_input)
    upsertParentSubagent(session.parentSessionId, childSessionId, Object.assign({}, base, {
      phase: isQuestionTool
        ? 'waitingForAnswer'
        : eventName === 'PermissionRequest' ? 'waitingForApproval' : 'running',
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
  const classification = classifyHookPayload(data)
  const subagentRoute = codexSubagentRoute(data, sessionId, classification)

  if (subagentRoute) {
    const childSessionId = subagentRoute.childSessionId
    const childClassification = {
      hidden: true,
      isInternal: false,
      isSubagent: true,
      reason: 'codex-subagent',
      parentSessionId: subagentRoute.parentSessionId,
      subagentDepth: subagentRoute.depth !== undefined
        ? subagentRoute.depth
        : classification.subagentDepth,
      subagentNickname: subagentRoute.nickname || classification.subagentNickname
    }
    const childBase = Object.assign({}, base, {
      threadId: childSessionId,
      codexSessionId: childSessionId
    })
    const child = readSession(childSessionId)
    if (!isHiddenCodexSession(child)) {
      // The route handler below is the single writer for activeSubagents. This
      // avoids first-event Stop adding a child immediately before removing it.
      markHiddenSession(childSessionId, childBase, childClassification, now, eventName, false)
    }
    updateParentSubagentFromHiddenEvent(Object.assign({}, child || {}, {
      sessionId: childSessionId,
      agentType: 'codex',
      isCodexSubagent: true,
      parentSessionId: subagentRoute.parentSessionId,
      subagentDepth: childClassification.subagentDepth,
      subagentNickname: childClassification.subagentNickname,
      startedAt: child && child.startedAt ? child.startedAt : now
    }), data, now)
    return
  }

  const existing = readSession(sessionId)
  if (isHiddenCodexSession(existing)) {
    updateParentSubagentFromHiddenEvent(existing, data, now)
    return
  }

  if (classification.hidden) {
    markHiddenSession(sessionId, base, classification, now, eventName)
    return
  }

  let confirmedByBackfill = false
  if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
    const backfill = backfillPromptFromTranscriptIfNeeded(sessionId, data, base, now)
    if (!backfill.proceed) return
    confirmedByBackfill = backfill.confirmed
  }

  switch (eventName) {
    case 'SessionStart': {
      // Treat a missing transcript_path as protocol-level proof of a
      // short-lived internal Codex session and emits no SessionState event.
      if (!data.transcript_path) return
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
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
        _codexPendingNativeRequestId: null,
        _codexNativeApprovedRequestIds: null,
        pendingToolUse: null,
        activeTool: null,
        _codexUserConfirmed: true,
        sessionTitle: title,
        lastUserPrompt: cleanPrompt(data.prompt || data.prompt_preview || ''),
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: now, details: title, turnId: data.turn_id }
      }))
      break
    }

    case 'PreToolUse': {
      const toolName = data.tool_name || 'unknown'
      const isQuestionTool = toolName === 'request_user_input'
      const questionDetails = isQuestionTool ? questionDetailsFromToolInput(data.tool_input) : null
      const details = questionDetails || getToolDetails(toolName, data.tool_input)
      if (isQuestionTool && questionDetails) {
        updateSession(sessionId, Object.assign({}, base, {
          status: 'working',
          needsAttention: 'waiting for answer',
          pendingToolUse: { tool: toolName, details, timestamp: now },
          activeTool: toolName,
          lastTurnId: data.turn_id,
          lastEvent: { type: AGENT_EVENTS.QUESTION_ASKED, timestamp: now, details, turnId: data.turn_id }
        }))
        break
      }
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
      const toolName = data.tool_name || 'unknown'
      const nativeRequestId = codexNativeRequestId(toolName, data.tool_input)
      const approvalPolicy = readApprovalPolicy(data.transcript_path)
      if (isBypassPermission(data) || approvalPolicy === 'never' || hasCodexApprovedRequest(existing, nativeRequestId)) {
        // Only ACK bypass/never/remembered approvals and refresh the jump
        // target. This emits no state event and must not resolve an existing
        // WAIT.
        break
      }
      const details = getToolDetails(toolName, data.tool_input)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: 'waiting for approval',
        _codexPendingNativeRequestId: nativeRequestId,
        pendingToolUse: { tool: toolName, details, timestamp: now },
        activeTool: toolName,
        requestId: data.request_id || data.requestId || data.tool_call_id || data.toolCallId || data.tool_use_id || data.toolUseId || nativeRequestId,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.PERMISSION_REQUEST, timestamp: now, details, turnId: data.turn_id }
      }))
      break
    }

    case 'PostToolUse': {
      const toolName = data.tool_name || 'unknown'
      const isQuestionTool = toolName === 'request_user_input'
      const details = isQuestionTool ? questionDetailsFromToolInput(data.tool_input) : toolName
      const rawResponse = data.tool_response || data.tool_output
      const preview = typeof rawResponse === 'string'
        ? compactText(rawResponse, 80)
        : ''
      const activity = preview ? `${toolName}: ${preview}` : `${toolName} done`
      resolvePendingInteraction(sessionId, data, now, details)
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        needsAttention: null,
        pendingToolUse: null,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.POST_TOOL_USE, timestamp: now, details: toolName, turnId: data.turn_id }
      }))
      updateSession(sessionId, Object.assign({}, base, {
        status: 'working',
        currentActivity: activity,
        lastTurnId: data.turn_id,
        lastEvent: { type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, timestamp: now, details: activity, turnId: data.turn_id }
      }))
      break
    }

    case 'Stop': {
      const lastAssistantMessage = typeof data.last_assistant_message === 'string'
        ? data.last_assistant_message
        : ''
      const wantsAnswer = codexStopWantsAnswer(data, lastAssistantMessage)
      const existing = readSession(sessionId)
      if (!confirmedByBackfill && !isCodexUserConfirmed(existing)) {
        markSilentCodexSession(sessionId, base, now, 'Stop without confirmed user prompt')
        break
      }
      // Clear stale pending interaction before Stop parsing. Resolve an
      // older wait first; the final assistant message may then establish a new
      // question wait.
      resolvePendingInteraction(sessionId, data, now, lastAssistantMessage)
      updateSession(sessionId, Object.assign({}, base, {
        status: wantsAnswer ? 'working' : 'completed',
        needsAttention: wantsAnswer ? 'waiting for answer' : null,
        _codexPendingNativeRequestId: wantsAnswer ? undefined : null,
        _codexNativeApprovedRequestIds: wantsAnswer ? undefined : null,
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
  const existing = readSession(sessionId)
  if (existing && (existing._codexHookManaged === true || existing.stateSource === 'codex-hooks')) {
    return
  }
  const prompt = extractSessionPrompt(inputMessages)
  if (!prompt && !existing) return
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
  parseCodexQuestions,
  codexSessionMetaFields
}

if (require.main === module) {
  main().catch(() => process.exit(0))
}
