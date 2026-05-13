// Central session state reducer for tmux-scout.

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
const TERMINAL_PHASES = new Set(['crashed', 'stale'])
const NON_TERMINAL_END_PHASES = new Set(['completed', 'interrupted'])
const ACTIVE_TOOL_PHASES = new Set(['running', 'waitingForApproval'])

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

function phaseForEvent(event) {
  switch (event.type) {
    case 'session_start': return 'idle'
    case 'prompt_submit': return 'running'
    case 'tool_use': return 'running'
    case 'post_tool_use': return 'running'
    case 'post_tool_use_failure': return 'running'
    case 'permission_bypassed': return 'running'
    case 'permission_request': return 'waitingForApproval'
    case 'question_asked': return 'waitingForAnswer'
    case 'stop': return 'completed'
    case 'stop_failure': return 'completed'
    case 'turn_complete': return 'completed'
    case 'session_end': return 'completed'
    case 'interrupted': return 'interrupted'
    case 'process_exit_detected': return 'crashed'
    case 'stale': return 'stale'
    case 'pane_state':
    case 'transcript_status':
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

function shouldApplyPhase(session, event, nextPhase, now) {
  if (!nextPhase) return false
  const current = currentPhase(session)
  if (TERMINAL_PHASES.has(nextPhase)) return true

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

  if (currentIsTerminal && !TERMINAL_PHASES.has(nextPhase) && event.type !== 'session_start') return false
  if (event.force) return true
  if (nextPhase === 'interrupted') return true
  if (incomingPriority < currentPriority && currentAge < PROTECTED_PHASE_MS) return false
  if (current === nextPhase) return true

  return true
}

function setPhase(session, phase, event, now) {
  const source = normalizeSource(event.source)
  const priority = Number.isFinite(event.priority) ? event.priority : sourcePriority(source)
  const status = legacyStatusForPhase(phase)

  session.phase = phase
  session.status = status
  session.needsAttention = attentionForPhase(phase, event.attentionReason)

  if (!ACTIVE_TOOL_PHASES.has(phase)) {
    session.pendingToolUse = null
    session.activeTool = null
  }

  if (event.type === 'session_end') {
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

function applySessionEvent(session, event) {
  if (!session || !event || !event.type) return { changed: false, applied: false }
  const now = Number.isFinite(event.timestamp) ? event.timestamp : Date.now()
  const before = JSON.stringify(session)

  if (event.updates && typeof event.updates === 'object') {
    for (const [key, value] of Object.entries(event.updates)) {
      if (value !== undefined) session[key] = value
    }
  }

  const nextPhase = phaseForEvent(event)
  const applied = shouldApplyPhase(session, event, nextPhase, now)
  if (applied) setPhase(session, nextPhase, event, now)

  if (applied || !nextPhase) {
    if (event.pendingToolUse !== undefined) session.pendingToolUse = event.pendingToolUse
    if (event.activeTool !== undefined) {
      session.activeTool = event.activeTool
    } else if (event.pendingToolUse && event.pendingToolUse.tool) {
      session.activeTool = event.pendingToolUse.tool
    } else if (event.pendingToolUse === null) {
      session.activeTool = null
    }
    session.lastEvent = {
      type: event.type,
      timestamp: now,
      details: event.details,
      turnId: event.turnId
    }
    if (event.lastEvent) {
      session.lastEvent = Object.assign({}, session.lastEvent, event.lastEvent)
    }
    session.lastUpdated = now
  }

  if (!applied && nextPhase && event.updates && before !== JSON.stringify(session)) {
    session.lastUpdated = now
  }

  return { changed: before !== JSON.stringify(session), applied }
}

module.exports = {
  applySessionEvent,
  currentPhase,
  sourcePriority,
  normalizeSource,
  PROTECTED_PHASE_MS
}
