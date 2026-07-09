// Detect explicit "a shell is still running in the background" activity.
//
// This is not a new session state. Callers map a positive hit back into the
// existing Flux-equivalent lifecycle: a live turn plus active Bash tool.

const TEXT_KEYS = [
  'last_assistant_message',
  'lastAssistantMessage',
  'assistant_message',
  'assistantMessage',
  'prompt_response',
  'promptResponse',
  'response',
  'output',
  'text',
  'text_content',
  'textContent',
  'message',
  'notification',
  'reason',
  'title',
  'currentActivity',
  'details'
]

function collectText(value, parts, seen) {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    if (value.trim()) parts.push(value)
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)

  for (const key of TEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectText(value[key], parts, seen)
    }
  }
  if (value.lastEvent && typeof value.lastEvent === 'object') {
    collectText(value.lastEvent.details, parts, seen)
  }
}

function backgroundActivityText(value) {
  const parts = []
  collectText(value, parts, new Set())
  const seen = new Set()
  return parts
    .map(part => String(part).trim())
    .filter(Boolean)
    .filter(part => {
      if (seen.has(part)) return false
      seen.add(part)
      return true
    })
    .join('\n')
}

const BACKGROUND_RE = /\bbackground\b|后台/i
const RUNNING_RE = /\b(?:running|working|in\s+progress)\b|(?:仍在|正在|运行中|执行中)/i
const SHELL_RE = /\bbackground\s+shells?\b|\bshells?\s+(?:still\s+)?running\s+in\s+background\b|后台\s*shell/i
const ARTIFACT_POLL_RE = /\bartifact\s+poll\b/i

function isBackgroundShellRunningText(value) {
  const text = typeof value === 'string' ? value : backgroundActivityText(value)
  if (!text) return false
  if (SHELL_RE.test(text) && RUNNING_RE.test(text)) return true
  if (ARTIFACT_POLL_RE.test(text) && BACKGROUND_RE.test(text) && RUNNING_RE.test(text)) return true
  if (/\bstill\s+running\s+in\s+background\b/i.test(text)) return true
  return false
}

function backgroundShellDetails(value) {
  const text = backgroundActivityText(value)
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const line = lines.find(isBackgroundShellRunningText) || lines[0] || 'background shell running'
  return line.length > 180 ? line.slice(0, 179) + '~' : line
}

module.exports = {
  backgroundActivityText,
  backgroundShellDetails,
  isBackgroundShellRunningText
}
