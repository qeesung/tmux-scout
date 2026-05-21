// Runtime contract for tmux-scout session state.
//
// This module is intentionally dependency-light: the project persists plain
// JSON, so the contract is a small set of canonical values plus validation
// helpers instead of a TypeScript build step.

const { AGENT_EVENTS, normalizeAgentEventType } = require('./agent-events')

const SESSION_CONTRACT_VERSION = 1

/**
 * @typedef {'idle'|'running'|'waitingForApproval'|'waitingForAnswer'|'completed'|'interrupted'|'crashed'|'stale'} SessionPhase
 * @typedef {'idle'|'working'|'completed'|'interrupted'|'crashed'|'stale'} LegacySessionStatus
 * @typedef {'approval'|'question'|'plan'} PendingInteractionType
 *
 * @typedef {Object} PendingInteraction
 * @property {PendingInteractionType} type
 * @property {SessionPhase} phase
 * @property {string=} source
 * @property {string=} rawEventName
 * @property {number=} startedAt
 * @property {number=} updatedAt
 * @property {string=} reason
 * @property {string=} details
 * @property {string=} tool
 * @property {string=} requestId
 * @property {string=} turnId
 * @property {number=} confidence
 *
 * @typedef {Object} StateEvidence
 * @property {string} type
 * @property {string=} source
 * @property {string=} rawEventName
 * @property {number} timestamp
 * @property {SessionPhase=} phase
 * @property {SessionPhase=} previousPhase
 * @property {boolean=} applied
 * @property {string=} blockedReason
 * @property {string=} reason
 * @property {string=} details
 * @property {string=} turnId
 * @property {string=} transcriptPath
 * @property {string=} tmuxPane
 * @property {number=} pid
 * @property {string=} activeTool
 *
 * @typedef {Object} AgentEvent
 * @property {string} type
 * @property {number|string=} timestamp
 * @property {string=} source
 * @property {string=} stateSource
 * @property {string=} rawEventName
 * @property {SessionPhase=} phase
 * @property {LegacySessionStatus=} status
 * @property {string|null=} attentionReason
 * @property {string|null=} needsAttention
 * @property {{tool?: string, details?: string, timestamp?: number}|null=} pendingToolUse
 * @property {string|null=} activeTool
 * @property {string=} turnId
 * @property {string=} requestId
 * @property {string=} toolCallId
 * @property {string=} toolUseId
 * @property {boolean=} force
 * @property {boolean=} preserveActiveTool
 *
 * @typedef {Object} SessionSnapshot
 * @property {string} sessionId
 * @property {string} agentType
 * @property {SessionPhase} phase
 * @property {LegacySessionStatus} status
 * @property {string|null=} needsAttention
 * @property {{tool?: string, details?: string, timestamp?: number}|null=} pendingToolUse
 * @property {PendingInteraction|null=} pendingInteraction
 * @property {string|null=} activeTool
 * @property {StateEvidence[]=} stateEvidence
 */

const FIELD_TYPES = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  OBJECT: 'object',
  ARRAY: 'array',
  TIMESTAMP: 'timestamp',
  ANY: 'any'
})

const SESSION_PHASES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_FOR_APPROVAL: 'waitingForApproval',
  WAITING_FOR_ANSWER: 'waitingForAnswer',
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  CRASHED: 'crashed',
  STALE: 'stale'
})

const SESSION_PHASE_VALUES = Object.freeze(Object.values(SESSION_PHASES))

const LEGACY_STATUS_BY_PHASE = Object.freeze({
  [SESSION_PHASES.IDLE]: 'idle',
  [SESSION_PHASES.RUNNING]: 'working',
  [SESSION_PHASES.WAITING_FOR_APPROVAL]: 'working',
  [SESSION_PHASES.WAITING_FOR_ANSWER]: 'working',
  [SESSION_PHASES.COMPLETED]: 'completed',
  [SESSION_PHASES.INTERRUPTED]: 'interrupted',
  [SESSION_PHASES.CRASHED]: 'crashed',
  [SESSION_PHASES.STALE]: 'stale'
})

const PENDING_INTERACTION_TYPES = Object.freeze({
  APPROVAL: 'approval',
  QUESTION: 'question',
  PLAN: 'plan'
})

const PENDING_INTERACTION_TYPE_VALUES = Object.freeze(Object.values(PENDING_INTERACTION_TYPES))

const AGENT_EVENT_SCHEMA = Object.freeze({
  name: 'AgentEvent',
  required: Object.freeze({
    type: FIELD_TYPES.STRING
  }),
  optional: Object.freeze({
    timestamp: FIELD_TYPES.TIMESTAMP,
    source: FIELD_TYPES.STRING,
    stateSource: FIELD_TYPES.STRING,
    rawEventName: FIELD_TYPES.STRING,
    phase: FIELD_TYPES.STRING,
    status: FIELD_TYPES.STRING,
    attentionReason: FIELD_TYPES.STRING,
    needsAttention: FIELD_TYPES.STRING,
    pendingToolUse: FIELD_TYPES.OBJECT,
    activeTool: FIELD_TYPES.STRING,
    turnId: FIELD_TYPES.STRING,
    requestId: FIELD_TYPES.STRING,
    toolCallId: FIELD_TYPES.STRING,
    toolUseId: FIELD_TYPES.STRING,
    transcriptPath: FIELD_TYPES.STRING,
    tmuxPane: FIELD_TYPES.STRING,
    pid: FIELD_TYPES.NUMBER,
    force: FIELD_TYPES.BOOLEAN,
    preserveActiveTool: FIELD_TYPES.BOOLEAN,
    updates: FIELD_TYPES.OBJECT
  })
})

const PENDING_INTERACTION_SCHEMA = Object.freeze({
  name: 'PendingInteraction',
  required: Object.freeze({
    type: FIELD_TYPES.STRING,
    phase: FIELD_TYPES.STRING
  }),
  optional: Object.freeze({
    source: FIELD_TYPES.STRING,
    stateSource: FIELD_TYPES.STRING,
    rawEventName: FIELD_TYPES.STRING,
    startedAt: FIELD_TYPES.NUMBER,
    updatedAt: FIELD_TYPES.NUMBER,
    reason: FIELD_TYPES.STRING,
    details: FIELD_TYPES.STRING,
    tool: FIELD_TYPES.STRING,
    requestId: FIELD_TYPES.STRING,
    turnId: FIELD_TYPES.STRING,
    transcriptPath: FIELD_TYPES.STRING,
    tmuxPane: FIELD_TYPES.STRING,
    pid: FIELD_TYPES.NUMBER,
    confidence: FIELD_TYPES.NUMBER,
    channelAlive: FIELD_TYPES.BOOLEAN
  })
})

const STATE_EVIDENCE_SCHEMA = Object.freeze({
  name: 'StateEvidence',
  required: Object.freeze({
    type: FIELD_TYPES.STRING,
    timestamp: FIELD_TYPES.NUMBER
  }),
  optional: Object.freeze({
    source: FIELD_TYPES.STRING,
    rawEventName: FIELD_TYPES.STRING,
    phase: FIELD_TYPES.STRING,
    previousPhase: FIELD_TYPES.STRING,
    applied: FIELD_TYPES.BOOLEAN,
    blockedReason: FIELD_TYPES.STRING,
    reason: FIELD_TYPES.STRING,
    details: FIELD_TYPES.STRING,
    turnId: FIELD_TYPES.STRING,
    transcriptPath: FIELD_TYPES.STRING,
    tmuxPane: FIELD_TYPES.STRING,
    pid: FIELD_TYPES.NUMBER,
    activeTool: FIELD_TYPES.STRING
  })
})

const SESSION_SNAPSHOT_SCHEMA = Object.freeze({
  name: 'SessionSnapshot',
  required: Object.freeze({
    sessionId: FIELD_TYPES.STRING,
    agentType: FIELD_TYPES.STRING,
    phase: FIELD_TYPES.STRING,
    status: FIELD_TYPES.STRING
  }),
  optional: Object.freeze({
    stateContractVersion: FIELD_TYPES.NUMBER,
    startedAt: FIELD_TYPES.NUMBER,
    lastUpdated: FIELD_TYPES.NUMBER,
    endedAt: FIELD_TYPES.NUMBER,
    workingDirectory: FIELD_TYPES.STRING,
    sessionTitle: FIELD_TYPES.STRING,
    lastUserPrompt: FIELD_TYPES.STRING,
    lastAssistantMessage: FIELD_TYPES.STRING,
    needsAttention: FIELD_TYPES.STRING,
    pendingToolUse: FIELD_TYPES.OBJECT,
    pendingInteraction: FIELD_TYPES.OBJECT,
    activeTool: FIELD_TYPES.STRING,
    currentTurnId: FIELD_TYPES.STRING,
    turnStartedAt: FIELD_TYPES.NUMBER,
    turnEndedAt: FIELD_TYPES.NUMBER,
    lastTurnId: FIELD_TYPES.STRING,
    stateSource: FIELD_TYPES.STRING,
    stateConfidence: FIELD_TYPES.NUMBER,
    stateReason: FIELD_TYPES.STRING,
    terminalKind: FIELD_TYPES.STRING,
    terminalReason: FIELD_TYPES.STRING,
    deferredCompletion: FIELD_TYPES.OBJECT,
    lifecycle: FIELD_TYPES.OBJECT,
    lastEvent: FIELD_TYPES.OBJECT,
    stateEvidence: FIELD_TYPES.ARRAY,
    tmuxPane: FIELD_TYPES.STRING,
    pid: FIELD_TYPES.NUMBER,
    transcriptPath: FIELD_TYPES.STRING,
    activeSubagents: FIELD_TYPES.ARRAY
  })
})

const SESSION_SCHEMAS = Object.freeze({
  AgentEvent: AGENT_EVENT_SCHEMA,
  PendingInteraction: PENDING_INTERACTION_SCHEMA,
  StateEvidence: STATE_EVIDENCE_SCHEMA,
  SessionSnapshot: SESSION_SNAPSHOT_SCHEMA
})

const TERMINAL_SESSION_PHASES = new Set([
  SESSION_PHASES.CRASHED,
  SESSION_PHASES.STALE
])

const NON_TERMINAL_END_PHASES = new Set([
  SESSION_PHASES.COMPLETED,
  SESSION_PHASES.INTERRUPTED
])

const ACTIVE_TOOL_PHASES = new Set([
  SESSION_PHASES.RUNNING
])

const PENDING_INTERACTION_PHASES = new Set([
  SESSION_PHASES.WAITING_FOR_APPROVAL,
  SESSION_PHASES.WAITING_FOR_ANSWER
])

const AGENT_EVENT_PHASES = Object.freeze({
  [AGENT_EVENTS.SESSION_START]: SESSION_PHASES.IDLE,
  [AGENT_EVENTS.PROMPT_SUBMIT]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.TOOL_USE]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.POST_TOOL_USE]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.POST_TOOL_USE_FAILURE]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.PERMISSION_BYPASSED]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.PERMISSION_RESOLVED]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.QUESTION_ANSWERED]: SESSION_PHASES.RUNNING,
  [AGENT_EVENTS.PERMISSION_REQUEST]: SESSION_PHASES.WAITING_FOR_APPROVAL,
  [AGENT_EVENTS.QUESTION_ASKED]: SESSION_PHASES.WAITING_FOR_ANSWER,
  [AGENT_EVENTS.STOP]: SESSION_PHASES.COMPLETED,
  [AGENT_EVENTS.STOP_FAILURE]: SESSION_PHASES.COMPLETED,
  [AGENT_EVENTS.TURN_COMPLETE]: SESSION_PHASES.COMPLETED,
  [AGENT_EVENTS.SESSION_END]: SESSION_PHASES.COMPLETED,
  [AGENT_EVENTS.SESSION_DELETE]: undefined,
  [AGENT_EVENTS.DISCOVERED]: SESSION_PHASES.IDLE,
  [AGENT_EVENTS.INTERRUPTED]: SESSION_PHASES.INTERRUPTED,
  [AGENT_EVENTS.PROCESS_EXIT_DETECTED]: SESSION_PHASES.INTERRUPTED,
  [AGENT_EVENTS.STALE]: SESSION_PHASES.STALE
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalPhase(value) {
  if (typeof value !== 'string') return null
  const phase = value.trim()
  return SESSION_PHASE_VALUES.includes(phase) ? phase : null
}

function statusForPhase(phase) {
  return LEGACY_STATUS_BY_PHASE[phase] || 'working'
}

function attentionForPhase(phase, reason) {
  if (phase === SESSION_PHASES.WAITING_FOR_APPROVAL) return reason || 'waiting for approval'
  if (phase === SESSION_PHASES.WAITING_FOR_ANSWER) return reason || 'waiting for answer'
  return null
}

function phaseFromLegacyStatus(status, needsAttention) {
  if (status === 'crashed') return SESSION_PHASES.CRASHED
  if (status === 'stale') return SESSION_PHASES.STALE
  if (status === 'interrupted') return SESSION_PHASES.INTERRUPTED
  if (needsAttention === 'waiting for answer') return SESSION_PHASES.WAITING_FOR_ANSWER
  if (needsAttention) return SESSION_PHASES.WAITING_FOR_APPROVAL
  if (status === 'working') return SESSION_PHASES.RUNNING
  if (status === 'completed') return SESSION_PHASES.COMPLETED
  if (status === 'idle') return SESSION_PHASES.IDLE
  return null
}

function phaseForAgentEvent(event) {
  const input = isPlainObject(event) ? event : { type: event }
  const type = normalizeAgentEventType(input.type)
  if (type === AGENT_EVENTS.PANE_STATE || type === AGENT_EVENTS.TRANSCRIPT_STATUS) {
    return canonicalPhase(input.phase) ||
      canonicalPhase(input.statusPhase) ||
      phaseFromLegacyStatus(input.status, input.needsAttention)
  }
  if (Object.prototype.hasOwnProperty.call(AGENT_EVENT_PHASES, type)) {
    return AGENT_EVENT_PHASES[type]
  }
  return canonicalPhase(input.phase)
}

function isTimestampLike(value) {
  if (value === undefined || value === null) return true
  if (Number.isFinite(value)) return true
  if (typeof value === 'string' && value.trim()) {
    return Number.isFinite(new Date(value).getTime())
  }
  return false
}

function valueMatchesFieldType(value, type) {
  if (value === undefined || value === null) return true
  if (type === FIELD_TYPES.ANY) return true
  if (type === FIELD_TYPES.TIMESTAMP) return isTimestampLike(value)
  if (type === FIELD_TYPES.ARRAY) return Array.isArray(value)
  if (type === FIELD_TYPES.OBJECT) return isPlainObject(value)
  return typeof value === type
}

function validateAgainstSchema(value, schema) {
  const errors = []
  const warnings = []
  if (!isPlainObject(value)) {
    return { valid: false, errors: [`${schema.name} must be an object`], warnings }
  }
  for (const [key, type] of Object.entries(schema.required || {})) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
      errors.push(`${schema.name}.${key} is required`)
    } else if (!valueMatchesFieldType(value[key], type)) {
      errors.push(`${schema.name}.${key} must be ${type}`)
    }
  }
  for (const [key, type] of Object.entries(schema.optional || {})) {
    if (!valueMatchesFieldType(value[key], type)) {
      warnings.push(`${schema.name}.${key} should be ${type} when present`)
    }
  }
  return { valid: errors.length === 0, errors, warnings }
}

function validateAgentEvent(event) {
  const errors = []
  const warnings = []
  const input = isPlainObject(event) ? event : { type: event }
  const shape = validateAgainstSchema(input, AGENT_EVENT_SCHEMA)
  errors.push(...shape.errors.map(error => error.replace(/^AgentEvent\./, 'event.')))
  warnings.push(...shape.warnings.map(warning => warning.replace(/^AgentEvent\./, 'event.')))
  const type = normalizeAgentEventType(input.type)

  if (!type) {
    if (!errors.includes('event.type is required')) errors.push('event.type is required')
  } else if (!Object.prototype.hasOwnProperty.call(AGENT_EVENT_PHASES, type) &&
    type !== AGENT_EVENTS.PANE_STATE &&
    type !== AGENT_EVENTS.TRANSCRIPT_STATUS &&
    !canonicalPhase(input.phase)) {
    warnings.push(`event.type ${type} is not canonical and does not declare a canonical phase`)
  }

  if (!isTimestampLike(input.timestamp)) {
    errors.push('event.timestamp must be a number, ISO string, or omitted')
  }

  if (input.phase !== undefined && !canonicalPhase(input.phase)) {
    errors.push(`event.phase ${input.phase} is not canonical`)
  }

  if (input.pendingToolUse !== undefined &&
    input.pendingToolUse !== null &&
    !isPlainObject(input.pendingToolUse)) {
    errors.push('event.pendingToolUse must be an object, null, or omitted')
  }

  if (input.activeTool !== undefined &&
    input.activeTool !== null &&
    typeof input.activeTool !== 'string') {
    warnings.push('event.activeTool should be a string, null, or omitted')
  }

  for (const key of ['turnId', 'requestId', 'toolCallId', 'toolUseId']) {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== 'string') {
      warnings.push(`event.${key} should be a string when present`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validatePendingInteraction(pending, phase, warnings) {
  if (!isPlainObject(pending)) {
    warnings.push('session.pendingInteraction should be an object when present')
    return
  }
  const shape = validateAgainstSchema(pending, PENDING_INTERACTION_SCHEMA)
  for (const warning of shape.warnings) warnings.push(`session.${warning}`)
  for (const error of shape.errors) warnings.push(`session.${error}`)
  if (pending.type && !PENDING_INTERACTION_TYPE_VALUES.includes(pending.type)) {
    warnings.push(`session.pendingInteraction.type ${pending.type} is not canonical`)
  }
  if (pending.phase && pending.phase !== phase) {
    warnings.push(`session.pendingInteraction.phase ${pending.phase} does not match session.phase ${phase}`)
  }
  if (phase === SESSION_PHASES.WAITING_FOR_APPROVAL && pending.type === PENDING_INTERACTION_TYPES.QUESTION) {
    warnings.push('approval waits should not carry question pending interactions')
  }
  if (phase === SESSION_PHASES.WAITING_FOR_ANSWER && pending.type && pending.type !== PENDING_INTERACTION_TYPES.QUESTION) {
    warnings.push('answer waits should carry question pending interactions')
  }
}

function validateSessionSnapshot(session) {
  const errors = []
  const warnings = []
  if (!isPlainObject(session)) {
    return { valid: false, errors: ['session must be an object'], warnings }
  }
  const shape = validateAgainstSchema(session, SESSION_SNAPSHOT_SCHEMA)
  errors.push(...shape.errors.map(error => error.replace(/^SessionSnapshot\./, 'session.')))
  warnings.push(...shape.warnings.map(warning => warning.replace(/^SessionSnapshot\./, 'session.')))

  if (!session.sessionId && !errors.includes('session.sessionId is required')) errors.push('session.sessionId is required')
  if (!session.agentType && !errors.includes('session.agentType is required')) errors.push('session.agentType is required')

  const phase = canonicalPhase(session.phase) || phaseFromLegacyStatus(session.status, session.needsAttention)
  if (!phase) {
    errors.push('session.phase is required and must be canonical')
  } else {
    const expectedStatus = statusForPhase(phase)
    if (session.status && session.status !== expectedStatus) {
      warnings.push(`session.status ${session.status} does not match phase ${phase} (expected ${expectedStatus})`)
    }
    if (!PENDING_INTERACTION_PHASES.has(phase) && session.needsAttention) {
      warnings.push(`session.needsAttention is set while phase is ${phase}`)
    }
    if (PENDING_INTERACTION_PHASES.has(phase) && !session.needsAttention) {
      warnings.push(`session.needsAttention is missing while phase is ${phase}`)
    }
    if (!ACTIVE_TOOL_PHASES.has(phase) && session.activeTool) {
      warnings.push(`session.activeTool is set while phase is ${phase}`)
    }
    if (!PENDING_INTERACTION_PHASES.has(phase) && session.pendingInteraction) {
      warnings.push(`session.pendingInteraction is set while phase is ${phase}`)
    }
    if (PENDING_INTERACTION_PHASES.has(phase) && !session.pendingInteraction) {
      warnings.push(`session.pendingInteraction is missing while phase is ${phase}`)
    }
    if (session.pendingInteraction) validatePendingInteraction(session.pendingInteraction, phase, warnings)
    if (session.lifecycle && session.lifecycle.phase && session.lifecycle.phase !== phase) {
      warnings.push(`session.lifecycle.phase ${session.lifecycle.phase} does not match session.phase ${phase}`)
    }
    if (TERMINAL_SESSION_PHASES.has(phase) && !Number.isFinite(session.endedAt)) {
      warnings.push(`terminal phase ${phase} should include endedAt`)
    }
    if ((phase === SESSION_PHASES.RUNNING || PENDING_INTERACTION_PHASES.has(phase) || phase === SESSION_PHASES.IDLE) &&
      Number.isFinite(session.endedAt)) {
      warnings.push(`active phase ${phase} should not include endedAt`)
    }
  }

  if (session.stateEvidence !== undefined && !Array.isArray(session.stateEvidence)) {
    warnings.push('session.stateEvidence should be an array when present')
  }

  return { valid: errors.length === 0, errors, warnings }
}

module.exports = {
  FIELD_TYPES,
  SESSION_CONTRACT_VERSION,
  SESSION_PHASES,
  SESSION_PHASE_VALUES,
  LEGACY_STATUS_BY_PHASE,
  PENDING_INTERACTION_TYPES,
  PENDING_INTERACTION_TYPE_VALUES,
  AGENT_EVENT_SCHEMA,
  PENDING_INTERACTION_SCHEMA,
  STATE_EVIDENCE_SCHEMA,
  SESSION_SNAPSHOT_SCHEMA,
  SESSION_SCHEMAS,
  TERMINAL_SESSION_PHASES,
  NON_TERMINAL_END_PHASES,
  ACTIVE_TOOL_PHASES,
  PENDING_INTERACTION_PHASES,
  AGENT_EVENT_PHASES,
  canonicalPhase,
  statusForPhase,
  attentionForPhase,
  phaseFromLegacyStatus,
  phaseForAgentEvent,
  validateAgainstSchema,
  validateAgentEvent,
  validateSessionSnapshot
}
