// Shared canonical event names for hook adapters and the session reducer.
//
// Keep the persisted values stable: status.json already stores these snake_case
// strings, so new adapters should import AGENT_EVENTS instead of inventing
// per-agent names.

const AGENT_EVENTS = Object.freeze({
  SESSION_START: 'session_start',
  PROMPT_SUBMIT: 'prompt_submit',
  TOOL_USE: 'tool_use',
  POST_TOOL_USE: 'post_tool_use',
  POST_TOOL_USE_FAILURE: 'post_tool_use_failure',
  PERMISSION_BYPASSED: 'permission_bypassed',
  PERMISSION_REQUEST: 'permission_request',
  PERMISSION_RESOLVED: 'permission_resolved',
  QUESTION_ASKED: 'question_asked',
  QUESTION_ANSWERED: 'question_answered',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  TURN_COMPLETE: 'turn_complete',
  SESSION_END: 'session_end',
  SESSION_DELETE: 'session_delete',
  INTERRUPTED: 'interrupted',
  PROCESS_EXIT_DETECTED: 'process_exit_detected',
  STALE: 'stale',
  PANE_STATE: 'pane_state',
  TRANSCRIPT_STATUS: 'transcript_status',
  DISCOVERED: 'discovered',
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_STOP: 'subagent_stop',
  SUBAGENT_TOOL_ACTIVITY: 'subagent_tool_activity',
  NOTIFICATION: 'notification',
  PRE_COMPACT: 'pre_compact',
  ASSISTANT_MESSAGE_UPDATE: 'assistant_message_update'
})

const AGENT_EVENT_ALIASES = Object.freeze({
  sessionStarted: AGENT_EVENTS.SESSION_START,
  turnStarted: AGENT_EVENTS.PROMPT_SUBMIT,
  activityUpdated: AGENT_EVENTS.TOOL_USE,
  permissionRequested: AGENT_EVENTS.PERMISSION_REQUEST,
  permissionResolved: AGENT_EVENTS.PERMISSION_RESOLVED,
  questionAsked: AGENT_EVENTS.QUESTION_ASKED,
  questionAnswered: AGENT_EVENTS.QUESTION_ANSWERED,
  toolUseStarted: AGENT_EVENTS.TOOL_USE,
  toolUseCompleted: AGENT_EVENTS.POST_TOOL_USE,
  sessionCompleted: AGENT_EVENTS.STOP,
  sessionDeleted: AGENT_EVENTS.SESSION_DELETE,
  processDetached: AGENT_EVENTS.PROCESS_EXIT_DETECTED,
  subagentStarted: AGENT_EVENTS.SUBAGENT_START,
  subagentStopped: AGENT_EVENTS.SUBAGENT_STOP,
  subagentToolActivity: AGENT_EVENTS.SUBAGENT_TOOL_ACTIVITY
})

function normalizeAgentEventType(type) {
  if (!type) return type
  return AGENT_EVENT_ALIASES[type] || type
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function normalizeTimestamp(value, fallback = Date.now()) {
  if (Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function normalizeAgentEvent(event, defaults = {}) {
  const input = event && typeof event === 'object' ? event : { type: event }
  const base = defaults && typeof defaults === 'object' ? defaults : {}
  const timestamp = normalizeTimestamp(firstDefined(input.timestamp, base.timestamp))
  const type = normalizeAgentEventType(firstDefined(input.type, base.type))

  const normalized = Object.assign({}, base, input, {
    type,
    timestamp,
    source: firstDefined(input.source, base.source, 'unknown'),
    stateSource: firstDefined(input.stateSource, base.stateSource),
    rawEventName: firstDefined(
      input.rawEventName,
      input.hookEventName,
      input.hook_event_name,
      base.rawEventName,
      base.hookEventName,
      base.hook_event_name
    ),
    turnId: firstDefined(input.turnId, input.turn_id, base.turnId, base.turn_id),
    requestId: firstDefined(input.requestId, input.request_id, base.requestId, base.request_id),
    toolCallId: firstDefined(input.toolCallId, input.tool_call_id, base.toolCallId, base.tool_call_id),
    toolUseId: firstDefined(input.toolUseId, input.tool_use_id, base.toolUseId, base.tool_use_id),
    channelAlive: firstDefined(input.channelAlive, input.channel_alive, base.channelAlive, base.channel_alive),
    transcriptPath: firstDefined(input.transcriptPath, input.transcript_path, base.transcriptPath, base.transcript_path),
    tmuxPane: firstDefined(input.tmuxPane, base.tmuxPane),
    pid: firstDefined(input.pid, base.pid)
  })

  if (normalized.rawEventName === undefined && type) {
    normalized.rawEventName = type
  }
  return normalized
}

function createAgentEvent(type, fields = {}) {
  if (type && typeof type === 'object') return normalizeAgentEvent(type, fields)
  return normalizeAgentEvent(Object.assign({}, fields, { type }))
}

module.exports = {
  AGENT_EVENTS,
  AGENT_EVENT_ALIASES,
  normalizeAgentEventType,
  normalizeAgentEvent,
  createAgentEvent
}
