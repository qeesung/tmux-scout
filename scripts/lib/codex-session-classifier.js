// Codex session classification helpers.
// Keeps Codex app/CLI internal threads and subagents out of tmux-scout's
// top-level session list.

const CODEX_IDE_SETUP_PREFIX = '# Context from my IDE setup:'
const CODEX_IDE_REQUEST_HEADER = '## My request for Codex:'

const TITLE_AGENT_BODY = /short title for a task/i
const USER_PROMPT_TAIL = 'User prompt:'
const AMBIENT_SUGGESTIONS_WORKER_HEADER =
  /^\s*Generate\s+\d+\s+to\s+\d+\s+ambient\s+suggestions\b/i
const HYPERPERSONALIZED_SUGGESTIONS_WORKER_HEADER =
  /^\s*#\s*Overview\s+Generate\s+\d+\s+to\s+\d+\s+hyperpersonalized\s+suggestions\b/i
const AMBIENT_SUGGESTIONS_REVIEWER_HEADER =
  /^\s*You\s+are\s+an\s+expert\s+at\s+upholding\s+safety\s+and\s+compliance\s+standards\s+for\s+Codex\s+ambient\s+suggestions\b/i
const PR_METADATA_HEADER =
  /^\s*You\s+are\s+a\s+helpful\s+assistant\.\s*Generate\s+a\s+pull\s+request\s+title\s+and\s+body\b/i
const SUMMARY_GENERATOR_HEADER =
  /^\s*You\s+are\s+writing\s+a\s+short\s+summary\s+of\s+a\s+final\s+assistant\s+message\b/i
const MEMORY_WRITING_AGENT_HEADER = /^\s*##\s+Memory\s+Writing\s+Agent\s*:/i
const GUARDIAN_REVIEWER_HEADER =
  /^\s*You\s+are\s+judging\s+one\s+planned\s+coding-agent\s+action\b/i

function stripCodexIdeContextWrapper(raw) {
  if (!raw) return ''
  const text = String(raw)
  const head = text.trimStart()
  if (!head.startsWith(CODEX_IDE_SETUP_PREFIX)) return text
  const idx = head.indexOf(CODEX_IDE_REQUEST_HEADER)
  if (idx < 0) return text
  const after = head.slice(idx + CODEX_IDE_REQUEST_HEADER.length)
  const cleaned = after.replace(/^[ \t]*\r?\n?/, '').trimEnd()
  return cleaned || text
}

function cleanCodexPrompt(prompt) {
  if (!prompt) return ''
  let clean = stripCodexIdeContextWrapper(String(prompt))
  clean = clean.replace(/<system[-_]?(?:instruction|reminder)[^>]*>[\s\S]*?<\/system[-_]?(?:instruction|reminder)>/gi, '')
  return clean.trim()
}

function internalPromptReason(prompt) {
  const clean = cleanCodexPrompt(prompt)
  if (!clean) return null

  const tail = clean.lastIndexOf(USER_PROMPT_TAIL)
  if (tail >= 0 && TITLE_AGENT_BODY.test(clean.slice(0, tail))) {
    return 'codex-title-generation'
  }
  if (AMBIENT_SUGGESTIONS_WORKER_HEADER.test(clean)) return 'codex-ambient-suggestions'
  if (HYPERPERSONALIZED_SUGGESTIONS_WORKER_HEADER.test(clean)) return 'codex-hyperpersonalized-suggestions'
  if (AMBIENT_SUGGESTIONS_REVIEWER_HEADER.test(clean)) return 'codex-ambient-suggestions-reviewer'
  if (PR_METADATA_HEADER.test(clean)) return 'codex-pr-metadata'
  if (SUMMARY_GENERATOR_HEADER.test(clean)) return 'codex-summary-generator'
  if (MEMORY_WRITING_AGENT_HEADER.test(clean)) return 'codex-memory-writing'
  if (GUARDIAN_REVIEWER_HEADER.test(clean)) return 'codex-guardian-reviewer'

  return null
}

function sourceObject(meta) {
  const src = meta && meta.source
  return src && typeof src === 'object' && !Array.isArray(src) ? src : null
}

function subagentObject(meta) {
  const src = sourceObject(meta)
  const sub = src && src.subagent
  return sub && typeof sub === 'object' && !Array.isArray(sub) ? sub : null
}

function internalSourceReason(meta) {
  const src = sourceObject(meta)
  if (!src) return null
  if (typeof src.internal === 'string') return `codex-internal-${src.internal || 'session'}`
  if (src.subagent === 'memory_consolidation') return 'codex-memory-consolidation'
  const sub = subagentObject(meta)
  if (sub && sub.other === 'guardian') return 'codex-guardian-reviewer'
  return null
}

function subagentInfo(meta) {
  if (!meta || typeof meta !== 'object') return null
  const sub = subagentObject(meta)
  const threadSpawn = sub && sub.thread_spawn && typeof sub.thread_spawn === 'object'
    ? sub.thread_spawn
    : null
  const src = sourceObject(meta)
  const parentSessionId = meta.forked_from_id || (threadSpawn && threadSpawn.parent_thread_id)
  // Standalone Codex review sessions use source.subagent = "review"
  // without a parent thread; those should remain visible.
  if (!parentSessionId) return null

  return {
    parentSessionId: parentSessionId || null,
    depth: Number.isFinite(threadSpawn && threadSpawn.depth) ? threadSpawn.depth : null,
    nickname: meta.agent_nickname || (threadSpawn && threadSpawn.agent_nickname) || null,
    source: src && src.subagent ? src.subagent : null
  }
}

function classifyCodexSession(options = {}) {
  const meta = options.sessionMeta || options.meta || null
  const sourceReason = internalSourceReason(meta)
  if (sourceReason) {
    return {
      hidden: true,
      isInternal: true,
      isSubagent: false,
      reason: sourceReason
    }
  }

  const promptReason = internalPromptReason(options.prompt || '')
  if (promptReason) {
    return {
      hidden: true,
      isInternal: true,
      isSubagent: false,
      reason: promptReason
    }
  }

  const subagent = subagentInfo(meta)
  if (subagent) {
    return {
      hidden: true,
      isInternal: false,
      isSubagent: true,
      reason: 'codex-subagent',
      parentSessionId: subagent.parentSessionId,
      subagentDepth: subagent.depth,
      subagentNickname: subagent.nickname
    }
  }

  return {
    hidden: false,
    isInternal: false,
    isSubagent: false,
    reason: null
  }
}

function isHiddenCodexSession(session) {
  return Boolean(session && session.agentType === 'codex' && session.isHiddenFromScout)
}

module.exports = {
  classifyCodexSession,
  cleanCodexPrompt,
  internalPromptReason,
  internalSourceReason,
  isHiddenCodexSession,
  stripCodexIdeContextWrapper,
  subagentInfo
}
