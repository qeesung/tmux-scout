// Central session state reducer for tmux-scout.

const { AGENT_EVENTS, normalizeAgentEvent } = require('./agent-events')
const {
  SESSION_CONTRACT_VERSION,
  SESSION_PHASES,
  TERMINAL_SESSION_PHASES,
  NON_TERMINAL_END_PHASES,
  ACTIVE_TOOL_PHASES,
  PENDING_INTERACTION_PHASES,
  phaseFromLegacyStatus,
  phaseForAgentEvent,
  statusForPhase,
  attentionForPhase
} = require('./session-contract')

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

const MAX_STATE_EVIDENCE = 20
const EVIDENCE_DEDUPE_MS = 10000
const TERMINAL_PHASES = TERMINAL_SESSION_PHASES
const PENDING_RESOLUTION_EVENTS = new Set([
  AGENT_EVENTS.PERMISSION_RESOLVED,
  AGENT_EVENTS.QUESTION_ANSWERED
])
const TURN_START_EVENTS = new Set([
  AGENT_EVENTS.PROMPT_SUBMIT
])
const TURN_END_EVENTS = new Set([
  AGENT_EVENTS.STOP,
  AGENT_EVENTS.STOP_FAILURE,
  AGENT_EVENTS.TURN_COMPLETE,
  AGENT_EVENTS.SESSION_END,
  AGENT_EVENTS.INTERRUPTED,
  AGENT_EVENTS.PROCESS_EXIT_DETECTED,
  AGENT_EVENTS.STALE
])
// Adapters pass isSessionEnd: false for both turn starts and ordinary
// sessionCompleted events. Keep this distinct from generic activity: a late
// tool/message update may change phase, but must preserve the ended flag.
const SESSION_END_RESET_EVENTS = new Set([
  AGENT_EVENTS.SESSION_START,
  AGENT_EVENTS.PROMPT_SUBMIT,
  AGENT_EVENTS.STOP,
  AGENT_EVENTS.STOP_FAILURE,
  AGENT_EVENTS.TURN_COMPLETE
])

function eventResetsSessionEnd(event) {
  return SESSION_END_RESET_EVENTS.has(event.type) && event.preserveSessionEnd !== true
}
const DEFERRED_COMPLETION_EVENTS = new Set([
  // Distinguish an ordinary turn completion from a real session end.
  // An ordinary completion received during WAIT stays phase-neutral; resolving
  // that WAIT returns to RUNNING. Only a true SessionEnd may be finalized
  // after the matching resolver.
  AGENT_EVENTS.SESSION_END
])
const TOOL_CLEAR_EVENTS = new Set([
  AGENT_EVENTS.SESSION_START,
  AGENT_EVENTS.PROMPT_SUBMIT,
  AGENT_EVENTS.POST_TOOL_USE,
  AGENT_EVENTS.POST_TOOL_USE_FAILURE,
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
  return phaseFromLegacyStatus(session.status, session.needsAttention) || 'idle'
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
  return phaseForAgentEvent(event)
}

function isMatchingPendingResolution(session, eventType) {
  const phase = currentPhase(session)
  return (phase === 'waitingForApproval' && eventType === AGENT_EVENTS.PERMISSION_RESOLVED) ||
    (phase === 'waitingForAnswer' && eventType === AGENT_EVENTS.QUESTION_ANSWERED)
}

function isHookManagedSession(session, event) {
  return normalizeSource(event && event.source) === 'hook' ||
    normalizeSource(session && session.lifecycle && session.lifecycle.source) === 'hook' ||
    String(session && session.stateSource || '').endsWith('-hooks')
}

function phaseDecision(session, event, nextPhase, now) {
  if (!nextPhase) return { apply: false, blockedReason: 'no phase change' }
  const current = currentPhase(session)
  const lifecycle = session.lifecycle || {}
  const currentUpdatedAt = Number.isFinite(lifecycle.updatedAt)
    ? lifecycle.updatedAt
    : (session.lastUpdated || 0)
  const currentIsTerminal = TERMINAL_PHASES.has(current)

  // Deliberately guard only permissionResolved. questionAnswered (and
  // planConfirmationAnswered, represented by the same canonical event here)
  // always clears the question phase and returns to running/completed.
  if (event.type === AGENT_EVENTS.QUESTION_ANSWERED) return { apply: true }

  // Keep a pending approval/question visible across ordinary
  // activity and turn completion. Only the matching explicit resolver or a new
  // session start may leave the wait; a real SessionEnd is the sole completion
  // that may be parked for finalization. Pane/PID observations, notifications,
  // subagent activity and force flags cannot guess that the user acted.
  if (PENDING_INTERACTION_PHASES.has(current)) {
    const matchingResolver =
      (current === 'waitingForApproval' && event.type === AGENT_EVENTS.PERMISSION_RESOLVED) ||
      (current === 'waitingForAnswer' && event.type === AGENT_EVENTS.QUESTION_ANSWERED)
    const explicitWait =
      (nextPhase === 'waitingForApproval' && event.type === AGENT_EVENTS.PERMISSION_REQUEST) ||
      (nextPhase === 'waitingForAnswer' && event.type === AGENT_EVENTS.QUESTION_ASKED)
    const explicitSessionStart = event.type === AGENT_EVENTS.SESSION_START ||
      event.type === AGENT_EVENTS.PROMPT_SUBMIT
    const deferredEnd = NON_TERMINAL_END_PHASES.has(nextPhase) &&
      DEFERRED_COMPLETION_EVENTS.has(event.type)

    if (event.resolvedPendingInteraction || matchingResolver || explicitWait || explicitSessionStart || deferredEnd) {
      return { apply: true }
    }
    return {
      apply: false,
      blockedReason: `current phase ${current} only exits on its matching explicit resolution`
    }
  }

  // Pane inspection is transport/liveness metadata, not an agent lifecycle
  // event. Adapters never derive a semantic phase from terminal contents.
  if (event.type === AGENT_EVENTS.PANE_STATE) {
    return { apply: false, blockedReason: 'pane observations are phase-neutral' }
  }

  if (TERMINAL_PHASES.has(nextPhase)) return { apply: true }

  if (currentIsTerminal && !TERMINAL_PHASES.has(nextPhase) && event.type !== AGENT_EVENTS.SESSION_START) {
    // Stale is inferred from pid liveness, not observed from the agent.
    // A real hook event from the agent proves the inference was wrong, so allow
    // recovery and bypass the subsequent priority guard — the inferred stale
    // priority (95) would otherwise win against a hook event (90).
    // Crashed remains one-way: it carries higher-confidence proof of exit.
    //
    // The event must be NEWER than the stale transition: a delayed hook generated
    // before the stale decision can otherwise resurrect a session that has since
    // exited (and would also move lastUpdated/endedAt backwards).
    if (current === 'stale' && normalizeSource(event.source) === 'hook') {
      const eventTimestamp = Number.isFinite(event.timestamp) ? event.timestamp : now
      if (eventTimestamp > currentUpdatedAt) {
        return { apply: true }
      }
      return {
        apply: false,
        blockedReason: `stale recovery requires hook event newer than stale transition (event ${eventTimestamp} <= stale ${currentUpdatedAt})`
      }
    }
    return { apply: false, blockedReason: `current phase ${current} is terminal` }
  }
  if (NON_TERMINAL_END_PHASES.has(current) &&
    nextPhase === 'running' &&
    event.type !== AGENT_EVENTS.PROMPT_SUBMIT &&
    event.type !== AGENT_EVENTS.SESSION_START &&
    event.type !== AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE &&
    event.type !== AGENT_EVENTS.NOTIFICATION) {
    return { apply: false, blockedReason: `current phase ${current} only reopens on a new turn` }
  }
  if (event.force) return { apply: true }
  if (nextPhase === 'interrupted') return { apply: true }
  if (current === nextPhase) return { apply: true }

  return { apply: true }
}

function shouldApplyPhase(session, event, nextPhase, now) {
  return phaseDecision(session, event, nextPhase, now).apply
}

// A new turn is a clean slate: an error surfaced in turn N (via stop_failure /
// post_tool_use_failure) must not bleed into turn N+1, so clear error/errorDetail
// on sessionStarted/turnStarted (parity with the tool-residue reset elsewhere).
function clearTurnErrorResidue(session) {
  session.error = null
  session.errorDetail = null
  session.lastToolError = null
}

function updateTurnLifecycle(session, event, phase, now) {
  if (event.type === AGENT_EVENTS.SESSION_START) {
    session.currentTurnId = null
    session.turnStartedAt = null
    session.turnEndedAt = null
    clearTurnErrorResidue(session)
    return
  }

  if (event.turnId) {
    session.lastTurnId = event.turnId
  }

  if (TURN_START_EVENTS.has(event.type)) {
    session.currentTurnId = event.turnId || null
    session.turnStartedAt = now
    session.turnEndedAt = null
    clearTurnErrorResidue(session)
    return
  }

  if (event.turnId && !session.currentTurnId) {
    session.currentTurnId = event.turnId
    session.turnStartedAt = Number.isFinite(session.turnStartedAt) ? session.turnStartedAt : now
    session.turnEndedAt = null
  }

  if (TURN_END_EVENTS.has(event.type) || TERMINAL_PHASES.has(phase) || NON_TERMINAL_END_PHASES.has(phase)) {
    if (event.turnId && !session.currentTurnId) session.currentTurnId = event.turnId
    if (session.currentTurnId || event.turnId || Number.isFinite(session.turnStartedAt)) {
      session.turnEndedAt = now
    }
  }
}

function terminalKindForEvent(event, phase) {
  if (event.terminalKind) return event.terminalKind
  if (event.type === AGENT_EVENTS.PROCESS_EXIT_DETECTED) return 'processExit'
  if (event.type === AGENT_EVENTS.STALE) return 'stale'
  if (event.type === AGENT_EVENTS.INTERRUPTED || phase === 'interrupted') return 'interrupted'
  if (event.type === AGENT_EVENTS.STOP_FAILURE) return 'stopFailure'
  if (phase === 'completed') return 'completed'
  if (phase === 'crashed') return 'crashed'
  return undefined
}

function isEndPhase(phase) {
  return TERMINAL_PHASES.has(phase) || NON_TERMINAL_END_PHASES.has(phase)
}

function cleanDeferredCompletion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!NON_TERMINAL_END_PHASES.has(value.phase)) return null
  return value
}

function deferredCompletionForEvent(event, phase, now) {
  const terminalKind = terminalKindForEvent(event, phase)
  const reason = compactEvidenceText(event.reason || event.details || event.type, 200)
  const deferred = {
    phase,
    type: event.type,
    source: normalizeSource(event.source),
    stateSource: event.stateSource,
    rawEventName: event.rawEventName || event.type,
    timestamp: now,
    originalTimestamp: event.timestamp,
    reason,
    details: compactEvidenceText(event.details, 200),
    turnId: event.turnId,
    transcriptPath: event.transcriptPath,
    tmuxPane: event.tmuxPane,
    pid: Number.isInteger(event.pid) ? event.pid : undefined,
    confidence: event.confidence,
    priority: Number.isFinite(event.priority) ? event.priority : sourcePriority(event.source),
    terminalKind,
    terminalReason: reason
  }
  const clean = {}
  for (const [key, value] of Object.entries(deferred)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value
  }
  return clean
}

function shouldDeferCompletion(session, event, nextPhase) {
  return PENDING_INTERACTION_PHASES.has(currentPhase(session)) &&
    NON_TERMINAL_END_PHASES.has(nextPhase) &&
    DEFERRED_COMPLETION_EVENTS.has(event.type)
}

function rememberDeferredCompletion(session, event, nextPhase, now) {
  const next = deferredCompletionForEvent(event, nextPhase, now)
  const previous = cleanDeferredCompletion(session.deferredCompletion)
  if (!previous || next.phase === 'interrupted' || previous.phase !== 'interrupted') {
    session.deferredCompletion = next
  }
}

function eventFromDeferredCompletion(deferred, resolver, now) {
  const source = deferred.source || normalizeSource(resolver.source)
  const rawEventName = deferred.rawEventName
    ? `${deferred.rawEventName}:${resolver.type}`
    : resolver.rawEventName || resolver.type
  return {
    type: deferred.type,
    source,
    stateSource: deferred.stateSource || resolver.stateSource,
    rawEventName,
    timestamp: now,
    originalTimestamp: deferred.originalTimestamp || deferred.timestamp,
    endedAt: deferred.originalTimestamp || deferred.timestamp,
    reason: deferred.terminalReason || deferred.reason || resolver.reason,
    details: deferred.details || resolver.details,
    turnId: deferred.turnId || resolver.turnId,
    transcriptPath: deferred.transcriptPath || resolver.transcriptPath,
    tmuxPane: deferred.tmuxPane || resolver.tmuxPane,
    pid: Number.isInteger(deferred.pid) ? deferred.pid : resolver.pid,
    confidence: Number.isFinite(deferred.confidence) ? deferred.confidence : resolver.confidence,
    priority: Number.isFinite(deferred.priority) ? deferred.priority : sourcePriority(source),
    terminalKind: deferred.terminalKind,
    terminalReason: deferred.terminalReason || deferred.reason,
    resolvedPendingInteraction: true,
    force: true,
    lastEvent: {
      type: deferred.type,
      timestamp: now,
      details: deferred.details || deferred.terminalReason || deferred.reason,
      turnId: deferred.turnId || resolver.turnId,
      source,
      rawEventName,
      transcriptPath: deferred.transcriptPath || resolver.transcriptPath,
      tmuxPane: deferred.tmuxPane || resolver.tmuxPane,
      pid: Number.isInteger(deferred.pid) ? deferred.pid : resolver.pid,
      resolvedBy: resolver.type
    }
  }
}

function setPhase(session, phase, event, now) {
  const source = normalizeSource(event.source)
  const priority = Number.isFinite(event.priority) ? event.priority : sourcePriority(source)
  const status = statusForPhase(phase)

  session.stateContractVersion = SESSION_CONTRACT_VERSION
  session.phase = phase
  session.status = status
  session.needsAttention = attentionForPhase(phase, event.attentionReason || event.needsAttention)
  updateTurnLifecycle(session, event, phase, now)

  if (event.activeTool !== undefined &&
    (event.activeTool === null || ACTIVE_TOOL_PHASES.has(phase))) {
    session.activeTool = event.activeTool
  } else if (!ACTIVE_TOOL_PHASES.has(phase)) {
    session.activeTool = null
  }
  if (!PENDING_INTERACTION_PHASES.has(phase)) {
    session.pendingToolUse = null
  } else if (event.pendingToolUse === undefined && !sameWaitRefresh(session, phase, event)) {
    session.pendingToolUse = null
  }
  if (isEndPhase(phase)) {
    session.activeSubagents = []
  }

  session.pendingInteraction = PENDING_INTERACTION_PHASES.has(phase)
    ? pendingInteractionForPhase(session, phase, event, now)
    : null

  if (event.type === AGENT_EVENTS.SESSION_END) {
    session.endedAt = event.endedAt || now
  } else if (TERMINAL_PHASES.has(phase)) {
    session.endedAt = event.endedAt || now
  } else if (eventResetsSessionEnd(event)) {
    // Clear isSessionEnded on sessionStarted, turnStarted and
    // ordinary sessionCompleted. Late activity must not resurrect an ended row.
    session.endedAt = null
  }

  session.stateSource = event.stateSource || event.source || session.stateSource
  session.stateConfidence = Number.isFinite(event.confidence) ? event.confidence : priority
  session.stateReason = event.reason || event.details || event.type
  if (isEndPhase(phase)) {
    session.terminalKind = terminalKindForEvent(event, phase)
    session.terminalReason = event.terminalReason || session.stateReason
  } else {
    session.terminalKind = null
    session.terminalReason = null
  }
  if (!PENDING_INTERACTION_PHASES.has(phase)) {
    session.deferredCompletion = null
  }
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
  if (event.activeTool === null) return true
  return TOOL_CLEAR_EVENTS.has(event.type)
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

  // permissionResolved outside an approval wait is a
  // true reducer no-op. A duplicate resolver must not refresh updatedAt and
  // thereby extend a phantom BUSY timeout window.
  if (event.type === AGENT_EVENTS.PERMISSION_RESOLVED && currentPhase(session) !== 'waitingForApproval') {
    return {
      changed: false,
      applied: false,
      evidenceChanged: false,
      blockedReason: 'permission_resolved requires waitingForApproval'
    }
  }

  const before = JSON.stringify(session)
  const previousPhase = currentPhase(session)

  if (event.updates && typeof event.updates === 'object') {
    for (const [key, value] of Object.entries(event.updates)) {
      if (value !== undefined) session[key] = value
    }
  }

  const deferredCompletion = cleanDeferredCompletion(session.deferredCompletion)
  const resolvingDeferred = Boolean(deferredCompletion && (
    isMatchingPendingResolution(session, event.type) ||
    event.type === AGENT_EVENTS.QUESTION_ANSWERED
  ))
  const phaseEvent = resolvingDeferred
    ? eventFromDeferredCompletion(deferredCompletion, event, now)
    : event
  const endedHookResolution = !resolvingDeferred && Boolean(session.endedAt) &&
    !TERMINAL_PHASES.has(previousPhase) &&
    isHookManagedSession(session, event) &&
    (event.type === AGENT_EVENTS.QUESTION_ANSWERED ||
      (event.type === AGENT_EVENTS.PERMISSION_RESOLVED && previousPhase === 'waitingForApproval'))
  let nextPhase = resolvingDeferred || endedHookResolution
    ? SESSION_PHASES.COMPLETED
    : phaseForEvent(event)
  const decision = phaseDecision(session, phaseEvent, nextPhase, now)
  let applied = decision.apply
  let deferredPhase = false
  if (!resolvingDeferred && applied && shouldDeferCompletion(session, event, nextPhase)) {
    rememberDeferredCompletion(session, event, nextPhase, now)
    if (event.type === AGENT_EVENTS.SESSION_END) session.endedAt = event.endedAt || now
    applied = false
    deferredPhase = true
    decision.blockedReason = 'deferred until pending interaction resolves'
  }
  if (applied) setPhase(session, nextPhase, phaseEvent, now)
  if (!applied && PENDING_INTERACTION_PHASES.has(previousPhase) &&
    eventResetsSessionEnd(event) &&
    event.type !== AGENT_EVENTS.SESSION_START &&
    event.type !== AGENT_EVENTS.PROMPT_SUBMIT) {
    // Preserve the pending phase but still apply sessionCompleted's
    // explicit isSessionEnd:false field.
    session.endedAt = null
    if (session.deferredCompletion) session.deferredCompletion = null
  }

  const evidenceChanged = appendStateEvidence(
    session,
    evidenceForEvent(session, phaseEvent, nextPhase, previousPhase, applied, decision.blockedReason, now)
  )

  if (deferredPhase) {
    session.lastEvent = {
      type: event.type,
      timestamp: now,
      details: event.details,
      turnId: event.turnId,
      source: normalizeSource(event.source),
      rawEventName: event.rawEventName,
      transcriptPath: event.transcriptPath,
      tmuxPane: event.tmuxPane,
      pid: event.pid,
      deferred: true
    }
    if (event.lastEvent) {
      session.lastEvent = Object.assign({}, session.lastEvent, event.lastEvent)
    }
    session.lastUpdated = now
  } else if (applied || !nextPhase) {
    const phase = currentPhase(session)
    if (phaseEvent.pendingToolUse !== undefined) {
      session.pendingToolUse = phaseEvent.pendingToolUse
    } else if (eventClearsPendingToolUse(phaseEvent)) {
      session.pendingToolUse = null
    }
    if (phaseEvent.activeTool !== undefined) {
      if (phaseEvent.activeTool === null || activeToolAllowedForPhase(phase)) {
        session.activeTool = phaseEvent.activeTool
      }
    } else if (eventClearsActiveTool(phaseEvent)) {
      session.activeTool = null
    }
    if (session.activeTool === undefined) session.activeTool = null
    session.lastEvent = {
      type: phaseEvent.type,
      timestamp: now,
      details: phaseEvent.details,
      turnId: phaseEvent.turnId,
      source: normalizeSource(phaseEvent.source),
      rawEventName: phaseEvent.rawEventName,
      transcriptPath: phaseEvent.transcriptPath,
      tmuxPane: phaseEvent.tmuxPane,
      pid: phaseEvent.pid
    }
    if (phaseEvent.lastEvent) {
      session.lastEvent = Object.assign({}, session.lastEvent, phaseEvent.lastEvent)
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
  MAX_STATE_EVIDENCE,
  EVIDENCE_DEDUPE_MS
}
