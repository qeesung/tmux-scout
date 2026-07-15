// Classify only structured Notification payloads that adapters map to
// state-machine events. Human-readable message prose is display metadata: it is
// never evidence for WAIT, DONE, or BUSY.
//
// Intents:
//   'permission' — blocked on tool approval        -> waitingForApproval (W:APP)
//   'question'   — blocked on a question/elicitation -> waitingForAnswer  (W:ANS)
//   'idle'       — turn ended / REPL back at prompt  -> completed (DONE)
//   'info'       — purely informational             -> no phase change

const INTENTS = Object.freeze({
  PERMISSION: 'permission',
  QUESTION: 'question',
  IDLE: 'idle',
  INFO: 'info'
})

// Kept for display/event-name callers. State routing below deliberately uses
// the exact notification_type spellings emitted by the corresponding
// adapters instead of accepting aliases from unrelated agents.
function normalizeType(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

// Best-effort human-readable text for display only.
function notificationText(data) {
  if (!data || typeof data !== 'object') return ''
  const details = data.details
  const nested = details && typeof details === 'object'
    ? (details.message || details.text || details.title)
    : (typeof details === 'string' ? details : undefined)
  return String(
    data.question ||
    data.message ||
    data.notification ||
    data.text ||
    data.reason ||
    data.title ||
    nested ||
    ''
  )
}

function structuredType(data) {
  if (!data || typeof data !== 'object') return ''
  return typeof data.notification_type === 'string' ? data.notification_type : ''
}

function classifyByStructuredType(data) {
  const type = structuredType(data)
  if (!type) return null
  if (type === 'idle_prompt') return INTENTS.IDLE
  if (type === 'ask_user_question' || type === 'document_review') return INTENTS.QUESTION
  if (type === 'permission_prompt') return INTENTS.PERMISSION
  if (type === 'ToolPermission') {
    // Gemini's ToolPermission notification also carries terminal-native
    // ask_user questions. Distinguish it through details.type.
    const details = data && data.details && typeof data.details === 'object' ? data.details : null
    if (details && details.type === 'ask_user') return INTENTS.QUESTION
    return INTENTS.PERMISSION
  }
  return null
}

// classifyNotification(data) -> { intent, details, tool }
// message/details are returned only for rendering; they never affect intent.
function classifyNotification(data) {
  const text = notificationText(data)
  const intent = classifyByStructuredType(data) || INTENTS.INFO
  return {
    intent,
    details: text || undefined,
    tool: undefined
  }
}

module.exports = {
  INTENTS,
  classifyNotification,
  notificationText,
  normalizeNotificationType: normalizeType
}
