// Central session state reducer for tmux-scout.

const { AGENT_EVENTS, normalizeAgentEvent } = require('./agent-events')
const {
  SESSION_CONTRACT_VERSION,
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

const PROTECTED_PHASE_MS = 120000
const MAX_STATE_EVIDENCE = 20
const EVIDENCE_DEDUPE_MS = 10000
const TERMINAL_PHASES = TERMINAL_SESSION_PHASES
const PENDING_RESOLUTION_EVENTS = new Set([
  AGENT_EVENTS.PERMISSION_RESOLVED,
  AGENT_EVENTS.QUESTION_ANSWERED
])
// While a WAIT is pending the agent is blocked on the user. A parent that now
// spawns a subagent must have just approved that launch out-of-band (the user
// acted in the terminal, which produces no explicit resolve hook), so treat
// subagent_start as a resolution and return the phase to running. This event
// carries no phase of its own, so without this it is dropped as "no phase
// change". The pending interaction is cleared on the next lifecycle hook.
// Only subagent_START qualifies: subagent_stop /
// subagent_tool_activity come from an ALREADY-running subagent and do not prove
// the parent's current wait was resolved, so including them could clear an
// unrelated fresh approval. assistant_message_update is likewise excluded (it
// may be the streamed question text) to keep genuine waits sticky.
const WAIT_RESUME_EVENTS = new Set([
  AGENT_EVENTS.SUBAGENT_START
])
// A sweep-INFERRED end state (an `interrupted` from the transcript/idle sweeps, or
// a `completed` synthesised by the idle-complete sweep) reopens when a genuinely
// NEW tool STARTS — proof the agent is working again after a false inference or a
// missed reopening UserPromptSubmit. Only PreToolUse-class START signals qualify:
// `tool_use` (PreToolUse) and `permission_bypassed` (emitted at permission-check
// time, before the tool runs) both mean "a new tool is starting". POST_* events are
// EXCLUDED on purpose — a delayed `post_tool_use` / `post_tool_use_failure` from the
// just-aborted turn carries a hook-processing timestamp that can be newer than the
// interrupt and would wrongly resurrect a genuinely interrupted turn (whose tool
// never completed). A real Stop-hook `completed` (source 'hook') is NOT inferred and
// stays sticky, so a normally-finished turn is never un-finished; only a sweep's own
// inference is allowed to be overturned by the next genuine activity. A real
// Stop-hook `completed` can also be reopened by a tool start carrying a DIFFERENT
// turn id: Flux models this as `turnStarted`, and Codex goal continuations can
// start a fresh turn without a UserPromptSubmit hook. Same-turn delayed tool
// events remain blocked. See phaseDecision for both newer-than gates.
const INFERRED_END_RESUME_EVENTS = new Set([
  AGENT_EVENTS.TOOL_USE,
  AGENT_EVENTS.PERMISSION_BYPASSED
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
const DEFERRED_COMPLETION_EVENTS = new Set([
  AGENT_EVENTS.STOP,
  AGENT_EVENTS.STOP_FAILURE,
  AGENT_EVENTS.TURN_COMPLETE,
  AGENT_EVENTS.SESSION_END,
  AGENT_EVENTS.INTERRUPTED
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
    event.type !== AGENT_EVENTS.SESSION_START) {
    // Recover a sweep-INFERRED end when a genuinely new tool starts and the event is
    // newer than the inference: an `interrupted` (always inferred) or an idle-sweep
    // `completed` whose lifecycle source is 'stale'. A real Stop-hook completion
    // (source 'hook') is observed ground truth and stays sticky, so a normal turn is
    // never un-finished. The newer-than gate stops a delayed in-flight event from the
    // aborted turn from resurrecting a genuinely ended turn (which emits nothing new
    // until the user's next prompt — already allowed above).
    const eventTimestamp = Number.isFinite(event.timestamp) ? event.timestamp : now
    const previousTurnId = session.lastTurnId || session.currentTurnId
    const startsDifferentTurn = current === 'completed' &&
      INFERRED_END_RESUME_EVENTS.has(event.type) &&
      event.turnId &&
      previousTurnId &&
      event.turnId !== previousTurnId
    if (startsDifferentTurn && eventTimestamp >= currentUpdatedAt) {
      return { apply: true }
    }

    const inferredEnd = current === 'interrupted' ||
      (current === 'completed' && currentSource === 'stale')
    if (inferredEnd && INFERRED_END_RESUME_EVENTS.has(event.type)) {
      if (eventTimestamp >= currentUpdatedAt) return { apply: true }
    }
    return { apply: false, blockedReason: `current phase ${current} only reopens on a new turn` }
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

  if (!ACTIVE_TOOL_PHASES.has(phase)) {
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
  } else if (NON_TERMINAL_END_PHASES.has(phase) || phase === 'running' || phase === 'waitingForApproval' || phase === 'waitingForAnswer' || phase === 'idle') {
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
  if (event.preserveActiveTool) return false
  return event.pendingToolUse === null ||
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

  const deferredCompletion = cleanDeferredCompletion(session.deferredCompletion)
  const resolvingDeferred = Boolean(deferredCompletion && PENDING_RESOLUTION_EVENTS.has(event.type))
  const phaseEvent = resolvingDeferred
    ? eventFromDeferredCompletion(deferredCompletion, event, now)
    : event
  let nextPhase = resolvingDeferred ? deferredCompletion.phase : phaseForEvent(event)
  if (!nextPhase &&
    !resolvingDeferred &&
    PENDING_INTERACTION_PHASES.has(currentPhase(session)) &&
    WAIT_RESUME_EVENTS.has(event.type)) {
    nextPhase = 'running'
  }
  const decision = phaseDecision(session, phaseEvent, nextPhase, now)
  let applied = decision.apply
  let deferredPhase = false
  if (!resolvingDeferred && applied && shouldDeferCompletion(session, event, nextPhase)) {
    rememberDeferredCompletion(session, event, nextPhase, now)
    applied = false
    deferredPhase = true
    decision.blockedReason = 'deferred until pending interaction resolves'
  }
  if (applied) setPhase(session, nextPhase, phaseEvent, now)

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
  PROTECTED_PHASE_MS,
  MAX_STATE_EVIDENCE,
  EVIDENCE_DEDUPE_MS
}
