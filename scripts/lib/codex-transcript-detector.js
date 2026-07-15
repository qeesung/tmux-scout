// Codex transcript detectors used by reconciliation.

const { readFileTail, splitJsonlLines } = require('./jsonl-tail-reader')

const CODEX_TRANSCRIPT_TAIL_BYTES = 128 * 1024

function timestampMs(value, fallback = Date.now()) {
  if (Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function parseTurnAbortedEvent(obj, fallbackNow = Date.now()) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (!payload || typeof payload !== 'object') return null
  if (payload.type !== 'turn_aborted') return null
  if (payload.reason !== 'interrupted') return null

  const endedAtMs = timestampMs(obj.timestamp, fallbackNow)
  return {
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
    abortedAtMs: endedAtMs,
    endedAtMs,
    completionKind: 'interrupted',
    rawEventName: 'turn_aborted'
  }
}

function parseTaskCompleteEvent(obj, fallbackNow = Date.now()) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (!payload || typeof payload !== 'object') return null
  if (payload.type !== 'task_complete') return null

  const endedAtMs = timestampMs(obj.timestamp, fallbackNow)
  return {
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
    completedAtMs: endedAtMs,
    endedAtMs,
    completionKind: 'completed',
    rawEventName: 'task_complete',
    lastAgentMessage: typeof payload.last_agent_message === 'string'
      ? payload.last_agent_message
      : undefined
  }
}

function parseTurnEndEvent(obj, fallbackNow = Date.now()) {
  return parseTaskCompleteEvent(obj, fallbackNow) || parseTurnAbortedEvent(obj, fallbackNow)
}

function hitTimestampMs(hit) {
  if (Number.isFinite(hit && hit.endedAtMs)) return hit.endedAtMs
  if (Number.isFinite(hit && hit.completedAtMs)) return hit.completedAtMs
  return hit && hit.abortedAtMs
}

function matchesOptions(hit, options = {}) {
  if (!hit) return false
  if (options.expectTurnId !== undefined && options.expectTurnId !== null && options.expectTurnId !== '') {
    return hit.turnId === String(options.expectTurnId)
  }
  if (Number.isFinite(options.minTimestampMs)) {
    return hitTimestampMs(hit) >= options.minTimestampMs
  }
  return true
}

function findLatestCodexEvent(transcriptPath, parser, options = {}) {
  if (!transcriptPath) return null
  const tail = readFileTail(transcriptPath, options.maxBytes || CODEX_TRANSCRIPT_TAIL_BYTES)
  if (!tail) return null

  let latest = null
  for (const line of splitJsonlLines(tail.text)) {
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {
      continue
    }
    const hit = parser(obj)
    if (!matchesOptions(hit, options)) continue
    if (!latest || hitTimestampMs(hit) > hitTimestampMs(latest)) {
      latest = hit
    }
  }
  return latest
}

function findLatestCodexInterrupt(transcriptPath, options = {}) {
  return findLatestCodexEvent(transcriptPath, parseTurnAbortedEvent, options)
}

function findLatestCodexTurnEnd(transcriptPath, options = {}) {
  return findLatestCodexEvent(transcriptPath, parseTurnEndEvent, options)
}

module.exports = {
  CODEX_TRANSCRIPT_TAIL_BYTES,
  parseTurnAbortedEvent,
  parseTaskCompleteEvent,
  findLatestCodexInterrupt,
  findLatestCodexTurnEnd
}
