// Classify an agent's Notification payload into a state-machine intent.
//
// A wrapper that owns the terminal can derive WAIT from explicit permission /
// question events; tmux-scout instead relies on standard agent hooks, where the only
// "the agent needs the user" signal is often a Notification — either by a
// structured notification_type (gemini / trae / coco / traex) OR, for Claude,
// by the message text alone ("Claude needs your permission", "...approval for
// the plan", "Claude is waiting for your input"). Dropping that signal is what
// leaves a session stuck showing BUSY, so this maps it to a canonical intent
// that the hook adapters turn into a WAIT / completed lifecycle event.
//
// Intents:
//   'permission' — blocked on tool approval        -> waitingForApproval (W:APP)
//   'plan'       — blocked on plan/spec approval    -> waitingForApproval (W:PLAN)
//   'question'   — blocked on a question/elicitation -> waitingForAnswer  (W:ANS)
//   'idle'       — turn ended / REPL back at prompt  -> completed (DONE)
//   'info'       — purely informational             -> no phase change

const INTENTS = Object.freeze({
  PERMISSION: 'permission',
  PLAN: 'plan',
  QUESTION: 'question',
  IDLE: 'idle',
  INFO: 'info'
})

// Mirror generic.js: camelCase / hyphen / space -> snake_case, lowercased.
function normalizeType(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

// Best-effort human-readable text for a notification. Ordering mirrors the
// previous generic.js notificationDetails() (question first) so callers that
// relied on it keep the same value, plus a couple of extra field names.
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
  return normalizeType(
    data.notification_type ||
    data.notificationType ||
    data.kind ||
    data.type ||
    ''
  )
}

const STRUCTURED_QUESTION = new Set([
  'ask_user_question', 'ask_user', 'ask_user_questions', 'askuserquestion',
  'elicitation_dialog', 'document_review', 'question'
])
const STRUCTURED_PERMISSION = new Set([
  'permission_prompt', 'permission_request', 'permission', 'tool_permission'
])

function classifyByStructuredType(data) {
  const type = structuredType(data)
  if (!type) return null
  if (type === 'idle_prompt') return INTENTS.IDLE
  if (STRUCTURED_QUESTION.has(type)) return INTENTS.QUESTION
  if (STRUCTURED_PERMISSION.has(type)) {
    // A tool-permission notification that is really an ask_user question.
    const details = data && data.details && typeof data.details === 'object' ? data.details : null
    if (details && normalizeType(details.type) === 'ask_user') return INTENTS.QUESTION
    return INTENTS.PERMISSION
  }
  return null
}

// Message-text patterns (English + 中文). Order matters below: plan is a kind of
// approval, so it must be tested before the generic permission pattern.
const PLAN_RE = /approv\w*\s+(?:for|of)\s+(?:the\s+)?plan|plan[\s\S]{0,40}?\bapprov|(?:确认|批准).{0,6}(?:计划|方案)|(?:计划|方案).{0,6}(?:确认|批准)/i
const PERMISSION_RE = /needs?\s+your\s+permission|permission\s+to\s+(?:use|run|access)|needs?\s+(?:your\s+)?approval|grant[\s\S]{0,20}permission|授权|批准|需要.{0,4}许可|请.{0,4}允许/i
const QUESTION_RE = /\b(?:has|have)\s+a\s+question|waiting\s+for\s+your\s+(?:answer|response|reply)|needs?\s+your\s+(?:answer|response|input to continue)|需要你.{0,6}(?:回答|回复|选择)|请.{0,4}(?:回答|回复|选择)/i
const IDLE_RE = /waiting\s+for\s+your\s+input|is\s+idle\b|finished\s+and\s+is\s+waiting|awaiting\s+(?:your\s+)?input|返回.{0,4}提示符|空闲.{0,4}等待|等待.{0,4}(?:输入|下一)/i

function classifyByText(text) {
  if (!text) return INTENTS.INFO
  if (PLAN_RE.test(text)) return INTENTS.PLAN
  if (PERMISSION_RE.test(text)) return INTENTS.PERMISSION
  if (QUESTION_RE.test(text)) return INTENTS.QUESTION
  if (IDLE_RE.test(text)) return INTENTS.IDLE
  return INTENTS.INFO
}

// Pull a tool name out of "...permission to use Bash" so the WAIT card can name it.
function extractToolFromText(text) {
  const match = /permission\s+to\s+(?:use|run|access)\s+([A-Za-z0-9_.:-]+)/i.exec(text || '')
  return match ? match[1] : undefined
}

// classifyNotification(data) -> { intent, details, tool }
// Structured notification_type wins (it is unambiguous); message text is the
// fallback that Claude and text-only agents depend on.
function classifyNotification(data) {
  const text = notificationText(data)
  const intent = classifyByStructuredType(data) || classifyByText(text)
  return {
    intent,
    details: text || undefined,
    tool: extractToolFromText(text)
  }
}

module.exports = {
  INTENTS,
  classifyNotification,
  notificationText,
  normalizeNotificationType: normalizeType
}
