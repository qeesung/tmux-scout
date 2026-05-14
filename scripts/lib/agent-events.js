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
  QUESTION_ASKED: 'question_asked',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  TURN_COMPLETE: 'turn_complete',
  SESSION_END: 'session_end',
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
  questionAsked: AGENT_EVENTS.QUESTION_ASKED,
  toolUseStarted: AGENT_EVENTS.TOOL_USE,
  toolUseCompleted: AGENT_EVENTS.POST_TOOL_USE,
  sessionCompleted: AGENT_EVENTS.STOP,
  processDetached: AGENT_EVENTS.PROCESS_EXIT_DETECTED,
  subagentStarted: AGENT_EVENTS.SUBAGENT_START,
  subagentStopped: AGENT_EVENTS.SUBAGENT_STOP,
  subagentToolActivity: AGENT_EVENTS.SUBAGENT_TOOL_ACTIVITY
})

function normalizeAgentEventType(type) {
  if (!type) return type
  return AGENT_EVENT_ALIASES[type] || type
}

module.exports = {
  AGENT_EVENTS,
  AGENT_EVENT_ALIASES,
  normalizeAgentEventType
}
