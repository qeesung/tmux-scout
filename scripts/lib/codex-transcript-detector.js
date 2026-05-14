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

  return {
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
    abortedAtMs: timestampMs(obj.timestamp, fallbackNow),
    rawEventName: 'turn_aborted'
  }
}

function matchesOptions(hit, options = {}) {
  if (!hit) return false
  if (options.expectTurnId !== undefined && options.expectTurnId !== null && options.expectTurnId !== '') {
    return hit.turnId === String(options.expectTurnId)
  }
  if (Number.isFinite(options.minTimestampMs)) {
    return hit.abortedAtMs >= options.minTimestampMs
  }
  return true
}

function findLatestCodexInterrupt(transcriptPath, options = {}) {
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
    const hit = parseTurnAbortedEvent(obj)
    if (!matchesOptions(hit, options)) continue
    if (!latest || hit.abortedAtMs > latest.abortedAtMs) {
      latest = hit
    }
  }
  return latest
}

module.exports = {
  CODEX_TRANSCRIPT_TAIL_BYTES,
  parseTurnAbortedEvent,
  findLatestCodexInterrupt
}
