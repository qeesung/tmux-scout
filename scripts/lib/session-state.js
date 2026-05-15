// Central session state reducer for tmux-scout.

const { AGENT_EVENTS, normalizeAgentEvent } = require('./agent-events')

const SOURCE_PRIORITY = {
  hook: 90,
  pid: 95,
  process: 95,
  transcript: 70,
  jsonl: 65,
  pane: 60,
  stale: 50,
  notify: 40,
  unknown: 10
}

const PROTECTED_PHASE_MS = 120000
const MAX_STATE_EVIDENCE = 20
const EVIDENCE_DEDUPE_MS = 10000
const TERMINAL_PHASES = new Set(['crashed', 'stale'])
const NON_TERMINAL_END_PHASES = new Set(['completed', 'interrupted'])
const ACTIVE_TOOL_PHASES = new Set(['running'])
const PENDING_INTERACTION_PHASES = new Set(['waitingForApproval', 'waitingForAnswer'])
const PENDING_RESOLUTION_EVENTS = new Set([
  AGENT_EVENTS.PERMISSION_RESOLVED,
  AGENT_EVENTS.QUESTION_ANSWERED
])
const TOOL_CLEAR_EVENTS = new Set([
  AGENT_EVENTS.SESSION_START,
  AGENT_EVENTS.PROMPT_SUBMIT,
  AGENT_EVENTS.POST_TOOL_USE,
  AGENT_EVENTS.POST_TOOL_USE_FAILURE,
  AGENT_EVENTS.PERMISSION_BYPASSED,
  AGENT_EVENTS.STOP,
  AGENT_EVENTS.STOP_FAILURE,
  AGENT_EVENTS.TURN_COMPLETE,
  AGENT_EVENTS.SESSION_END,
  AGENT_EVENTS.INTERRUPTED,
  AGENT_EVENTS.PROCESS_EXIT_DETECTED,
  AGENT_EVENTS.STALE
])
const PLAN_APPROVAL_TOOLS = new Set(['exitplanmode', 'enterplanmode'])
const GENERIC_WAIT_DETAILS = new Set([
  'needsattention',
  'needs attention',
  'waiting',
  'waitingforapproval',
  'waiting for approval',
  'waitingforanswer',
  'waiting for answer'
])

function normalizeSource(source) {
  if (!source) return 'unknown'
  if (source === 'codex-hooks' || source === 'claude-hooks') return 'hook'
  if (source === 'codex-jsonl') return 'jsonl'
  if (source === 'process-tree') return 'process'
  return source
}

function sourcePriority(source) {
  return SOURCE_PRIORITY[normalizeSource(source)] || SOURCE_PRIORITY.unknown
}

function currentPhase(session) {
  if (session.phase) return session.phase
  if (session.lifecycle && session.lifecycle.phase) return session.lifecycle.phase
  if (session.status === 'crashed') return 'crashed'
  if (session.status === 'stale') return 'stale'
  if (session.status === 'interrupted') return 'interrupted'
  if (session.needsAttention === 'waiting for answer') return 'waitingForAnswer'
  if (session.needsAttention) return 'waitingForApproval'
  if (session.status === 'working') return 'running'
  if (session.status === 'completed') return 'completed'
  if (session.status === 'idle') return 'idle'
  return 'idle'
}

function legacyStatusForPhase(phase) {
  switch (phase) {
    case 'idle': return 'idle'
    case 'running': return 'working'
    case 'waitingForApproval': return 'working'
    case 'waitingForAnswer': return 'working'
    case 'completed': return 'completed'
    case 'interrupted': return 'interrupted'
    case 'crashed': return 'crashed'
    case 'stale': return 'stale'
    default: return 'working'
  }
}

function attentionForPhase(phase, reason) {
  if (phase === 'waitingForApproval') return reason || 'waiting for approval'
  if (phase === 'waitingForAnswer') return reason || 'waiting for answer'
  return null
}

function isGenericWaitDetail(value) {
  const text = compactEvidenceText(value, 200)
  return text ? GENERIC_WAIT_DETAILS.has(text.toLowerCase()) : false
}

function isPlanApprovalReason(value) {
  const text = compactEvidenceText(value, 200)
  if (!text) return false
  const normalized = text.toLowerCase()
  return normalized.includes('plan approval') ||
    normalized.includes('plan confirmation') ||
    normalized.includes('confirm plan') ||
    normalized.includes('implement this plan')
}

function pendingInteractionType(phase, event, pendingTool) {
  if (phase === 'waitingForAnswer') return 'question'
  const tool = String(pendingTool.tool || event.activeTool || '').toLowerCase()
  if (PLAN_APPROVAL_TOOLS.has(tool) ||
    isPlanApprovalReason(event.attentionReason) ||
    isPlanApprovalReason(event.needsAttention)) {
    return 'plan'
  }
  return 'approval'
}

function requestIdForEvent(event) {
  return event.requestId || event.toolCallId || event.toolUseId || event.turnId
}

function samePendingInteraction(previous, phase, type, requestId, tool, details) {
  if (!previous || previous.phase !== phase || previous.type !== type) return false
  if (previous.requestId || requestId) return previous.requestId === requestId
  if (previous.tool || tool) return previous.tool === tool && previous.details === details
  return previous.details === details
}

function sameWaitRefresh(session, phase, event) {
  return PENDING_INTERACTION_PHASES.has(phase) &&
    session.pendingInteraction &&
    session.pendingInteraction.phase === phase &&
    event.pendingToolUse === undefined &&
    event.activeTool === undefined
}

function fallbackPendingTool(session, sameWait) {
  if (!sameWait) return null
  if (session.pendingToolUse && typeof session.pendingToolUse === 'object') return session.pendingToolUse
  const previous = session.pendingInteraction
  if (previous && (previous.tool || previous.details)) {
    return { tool: previous.tool, details: previous.details }
  }
  return null
}

function pendingInteractionForPhase(session, phase, event, now) {
  const sameWait = sameWaitRefresh(session, phase, event)
  const previousInteraction = sameWait ? session.pendingInteraction : null
  const pendingTool = event.pendingToolUse && typeof event.pendingToolUse === 'object'
    ? event.pendingToolUse
    : fallbackPendingTool(session, sameWait)
  const type = pendingInteractionType(phase, event, pendingTool || {})
  const tool = pendingTool && pendingTool.tool
    ? String(pendingTool.tool)
    : event.activeTool ? String(event.activeTool) : undefined
  const rawReason = event.attentionReason || event.needsAttention
  const reason = attentionForPhase(
    phase,
    rawReason && !isGenericWaitDetail(rawReason)
      ? rawReason
      : previousInteraction && previousInteraction.reason ? previousInteraction.reason : rawReason
  )
  const eventDetails = isGenericWaitDetail(event.details) ? undefined : event.details
  const details = compactEvidenceText(
    eventDetails ||
      (pendingTool && pendingTool.details) ||
      (previousInteraction && previousInteraction.details) ||
      (!sameWait ? event.reason : undefined) ||
      reason,
    200
  )
  const requestId = requestIdForEvent(event) || (previousInteraction && previousInteraction.requestId)
  const matchingPrevious = samePendingInteraction(session.pendingInteraction, phase, type, requestId, tool, details)
    ? session.pendingInteraction
    : null
  const source = normalizeSource(event.source)
  const priority = Number.isFinite(event.priority) ? event.priority : sourcePriority(source)
  const interaction = {
    type,
    phase,
    source,
    stateSource: event.stateSource || session.stateSource,
    rawEventName: event.rawEventName || event.type,
    startedAt: matchingPrevious && Number.isFinite(matchingPrevious.startedAt) ? matchingPrevious.startedAt : now,
    updatedAt: now,
    reason,
    details,
    tool,
    requestId,
    turnId: event.turnId || (matchingPrevious && matchingPrevious.turnId),
    transcriptPath: event.transcriptPath || session.transcriptPath,
    tmuxPane: event.tmuxPane || session.tmuxPane,
    pid: Number.isInteger(event.pid) ? event.pid : session.pid,
    confidence: Number.isFinite(event.confidence) ? event.confidence : priority,
    channelAlive: typeof event.channelAlive === 'boolean' ? event.channelAlive : undefined
  }

  const clean = {}
  for (const [key, value] of Object.entries(interaction)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value
  }
  return clean
}

function phaseForEvent(event) {
  switch (event.type) {
    case AGENT_EVENTS.SESSION_START: return 'idle'
    case AGENT_EVENTS.PROMPT_SUBMIT: return 'running'
    case AGENT_EVENTS.TOOL_USE: return 'running'
    case AGENT_EVENTS.POST_TOOL_USE: return 'running'
    case AGENT_EVENTS.POST_TOOL_USE_FAILURE: return 'running'
    case AGENT_EVENTS.PERMISSION_BYPASSED: return 'running'
    case AGENT_EVENTS.PERMISSION_RESOLVED: return 'running'
    case AGENT_EVENTS.QUESTION_ANSWERED: return 'running'
    case AGENT_EVENTS.PERMISSION_REQUEST: return 'waitingForApproval'
    case AGENT_EVENTS.QUESTION_ASKED: return 'waitingForAnswer'
    case AGENT_EVENTS.STOP: return 'completed'
    case AGENT_EVENTS.STOP_FAILURE: return 'completed'
    case AGENT_EVENTS.TURN_COMPLETE: return 'completed'
    case AGENT_EVENTS.SESSION_END: return 'completed'
    case AGENT_EVENTS.INTERRUPTED: return 'interrupted'
    case AGENT_EVENTS.PROCESS_EXIT_DETECTED: return 'crashed'
    case AGENT_EVENTS.STALE: return 'stale'
    case AGENT_EVENTS.PANE_STATE:
    case AGENT_EVENTS.TRANSCRIPT_STATUS:
      return event.phase || event.statusPhase || currentPhaseFromStatus(event.status, event.needsAttention)
    default:
      return event.phase
  }
}

function currentPhaseFromStatus(status, needsAttention) {
  if (needsAttention === 'waiting for answer') return 'waitingForAnswer'
  if (needsAttention) return 'waitingForApproval'
  if (status === 'working') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'crashed') return 'crashed'
  if (status === 'stale') return 'stale'
  if (status === 'idle') return 'idle'
  return null
}

function phaseDecision(session, event, nextPhase, now) {
  if (!nextPhase) return { apply: false, blockedReason: 'no phase change' }
  const current = currentPhase(session)
  if (TERMINAL_PHASES.has(nextPhase)) return { apply: true }

  const incomingPriority = Number.isFinite(event.priority)
    ? event.priority
    : sourcePriority(event.source)
  const lifecycle = session.lifecycle || {}
  const currentPriority = Number.isFinite(lifecycle.priority)
    ? lifecycle.priority
    : sourcePriority(session.stateSource)
  const currentUpdatedAt = Number.isFinite(lifecycle.updatedAt)
    ? lifecycle.updatedAt
    : (session.lastUpdated || 0)
  const currentAge = now - currentUpdatedAt
  const currentIsTerminal = TERMINAL_PHASES.has(current)
  const currentSource = normalizeSource(lifecycle.source || session.stateSource)

  if (currentIsTerminal && !TERMINAL_PHASES.has(nextPhase) && event.type !== AGENT_EVENTS.SESSION_START) {
    return { apply: false, blockedReason: `current phase ${current} is terminal` }
  }
  if (event.force) return { apply: true }
  if (nextPhase === 'interrupted') return { apply: true }
  if (event.type === AGENT_EVENTS.PANE_STATE && nextPhase === 'running' && currentSource === 'transcript'
    && (current === 'waitingForApproval' || current === 'waitingForAnswer')) {
    return { apply: true }
  }
  if (incomingPriority < currentPriority && currentAge < PROTECTED_PHASE_MS) {
    return {
      apply: false,
      blockedReason: `source priority ${incomingPriority} below ${currentPriority} within ${PROTECTED_PHASE_MS}ms protection window`
    }
  }
  if (current === nextPhase) return { apply: true }

  return { apply: true }
}

function shouldApplyPhase(session, event, nextPhase, now) {
  return phaseDecision(session, event, nextPhase, now).apply
}

function setPhase(session, phase, event, now) {
  const source = normalizeSource(event.source)
  const priority = Number.isFinite(event.priority) ? event.priority : sourcePriority(source)
  const status = legacyStatusForPhase(phase)

  session.phase = phase
  session.status = status
  session.needsAttention = attentionForPhase(phase, event.attentionReason || event.needsAttention)

  if (!ACTIVE_TOOL_PHASES.has(phase)) {
    session.activeTool = null
  }
  if (!PENDING_INTERACTION_PHASES.has(phase)) {
    session.pendingToolUse = null
  } else if (event.pendingToolUse === undefined && !sameWaitRefresh(session, phase, event)) {
    session.pendingToolUse = null
  }

  session.pendingInteraction = PENDING_INTERACTION_PHASES.has(phase)
    ? pendingInteractionForPhase(session, phase, event, now)
    : null

  if (event.type === AGENT_EVENTS.SESSION_END) {
    session.endedAt = event.endedAt || now
  } else if (TERMINAL_PHASES.has(phase)) {
    session.endedAt = event.endedAt || now
  } else if (NON_TERMINAL_END_PHASES.has(phase) || phase === 'running' || phase === 'waitingForApproval' || phase === 'waitingForAnswer' || phase === 'idle') {
    session.endedAt = null
  }

  session.stateSource = event.stateSource || event.source || session.stateSource
  session.stateConfidence = Number.isFinite(event.confidence) ? event.confidence : priority
  session.stateReason = event.reason || event.details || event.type
  session.lifecycle = {
    phase,
    source,
    priority,
    reason: session.stateReason,
    updatedAt: now
  }
}

function compactEvidenceText(value, max = 160) {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(/[\r\n\t]+/g, ' ').trim()
  if (!text) return undefined
  return text.length > max ? text.slice(0, max - 1) + '~' : text
}

function eventClearsPendingToolUse(event) {
  return event.pendingToolUse === null ||
    PENDING_RESOLUTION_EVENTS.has(event.type) ||
    TOOL_CLEAR_EVENTS.has(event.type)
}

function eventClearsActiveTool(event) {
  return event.activeTool === null ||
    event.pendingToolUse === null ||
    TOOL_CLEAR_EVENTS.has(event.type) ||
    event.type === AGENT_EVENTS.QUESTION_ASKED ||
    event.type === AGENT_EVENTS.PERMISSION_REQUEST
}

function activeToolAllowedForPhase(phase) {
  return ACTIVE_TOOL_PHASES.has(phase)
}

function evidenceForEvent(session, event, nextPhase, previousPhase, applied, blockedReason, now) {
  const phase = nextPhase || event.phase || previousPhase
  const activeTool = event.activeTool !== undefined && event.activeTool !== null && activeToolAllowedForPhase(phase)
    ? event.activeTool
    : eventClearsActiveTool(event) ? undefined : session.activeTool || undefined
  return {
    type: event.type,
    source: normalizeSource(event.source),
    rawEventName: event.rawEventName || event.type,
    timestamp: now,
    phase: nextPhase || event.phase || previousPhase,
    previousPhase,
    applied: Boolean(applied),
    blockedReason: applied ? undefined : compactEvidenceText(blockedReason),
    reason: compactEvidenceText(event.reason || event.details || event.type),
    details: compactEvidenceText(event.details),
    turnId: event.turnId,
    transcriptPath: event.transcriptPath || session.transcriptPath,
    tmuxPane: event.tmuxPane || session.tmuxPane,
    pid: Number.isInteger(event.pid) ? event.pid : session.pid,
    activeTool
  }
}

function evidenceKey(evidence) {
  return [
    evidence.type,
    evidence.source,
    evidence.rawEventName,
    evidence.phase,
    evidence.applied ? '1' : '0',
    evidence.blockedReason || '',
    evidence.reason || '',
    evidence.details || '',
    evidence.turnId || '',
    evidence.transcriptPath || '',
    evidence.tmuxPane || '',
    evidence.pid || '',
    evidence.activeTool || ''
  ].join('\u0001')
}

function appendStateEvidence(session, evidence) {
  if (!evidence || !evidence.type) return false
  const entries = Array.isArray(session.stateEvidence)
    ? session.stateEvidence.filter(Boolean)
    : []
  const last = entries[0]
  if (last && evidenceKey(last) === evidenceKey(evidence)
    && Number.isFinite(last.timestamp)
    && Math.abs(evidence.timestamp - last.timestamp) <= EVIDENCE_DEDUPE_MS) {
    return false
  }

  const clean = {}
  for (const [key, value] of Object.entries(evidence)) {
    if (value !== undefined && value !== null) clean[key] = value
  }
  session.stateEvidence = [clean].concat(entries).slice(0, MAX_STATE_EVIDENCE)
  return true
}

function applySessionEvent(session, event) {
  if (!session || !event || !event.type) return { changed: false, applied: false }
  event = normalizeAgentEvent(event, {
    transcriptPath: session.transcriptPath,
    tmuxPane: session.tmuxPane,
    pid: session.pid
  })
  const now = Number.isFinite(event.timestamp) ? event.timestamp : Date.now()
  const before = JSON.stringify(session)
  const previousPhase = currentPhase(session)

  if (event.updates && typeof event.updates === 'object') {
    for (const [key, value] of Object.entries(event.updates)) {
      if (value !== undefined) session[key] = value
    }
  }

  const nextPhase = phaseForEvent(event)
  const decision = phaseDecision(session, event, nextPhase, now)
  const applied = decision.apply
  if (applied) setPhase(session, nextPhase, event, now)

  const evidenceChanged = appendStateEvidence(
    session,
    evidenceForEvent(session, event, nextPhase, previousPhase, applied, decision.blockedReason, now)
  )

  if (applied || !nextPhase) {
    const phase = currentPhase(session)
    if (event.pendingToolUse !== undefined) {
      session.pendingToolUse = event.pendingToolUse
    } else if (eventClearsPendingToolUse(event)) {
      session.pendingToolUse = null
    }
    if (event.activeTool !== undefined) {
      if (event.activeTool === null || activeToolAllowedForPhase(phase)) {
        session.activeTool = event.activeTool
      }
    } else if (eventClearsActiveTool(event)) {
      session.activeTool = null
    }
    if (session.activeTool === undefined) session.activeTool = null
    session.lastEvent = {
      type: event.type,
      timestamp: now,
      details: event.details,
      turnId: event.turnId,
      source: normalizeSource(event.source),
      rawEventName: event.rawEventName,
      transcriptPath: event.transcriptPath,
      tmuxPane: event.tmuxPane,
      pid: event.pid
    }
    if (event.lastEvent) {
      session.lastEvent = Object.assign({}, session.lastEvent, event.lastEvent)
    }
    session.lastUpdated = now
  }

  if (!applied && nextPhase && event.updates && before !== JSON.stringify(session)) {
    session.lastUpdated = now
  }

  return { changed: before !== JSON.stringify(session), applied, evidenceChanged }
}

module.exports = {
  applySessionEvent,
  currentPhase,
  sourcePriority,
  normalizeSource,
  PROTECTED_PHASE_MS,
  MAX_STATE_EVIDENCE,
  EVIDENCE_DEDUPE_MS
}
