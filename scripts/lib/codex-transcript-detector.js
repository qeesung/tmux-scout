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
    const hitTimestamp = Number.isFinite(hit.abortedAtMs)
      ? hit.abortedAtMs
      : Number.isFinite(hit.completedAtMs) ? hit.completedAtMs : hit.timestampMs
    return hitTimestamp >= options.minTimestampMs
  }
  return true
}

function parsePlanItemCompletedEvent(obj, fallbackNow = Date.now()) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (!payload || typeof payload !== 'object') return null
  if (payload.type !== 'item_completed') return null
  const item = payload.item
  if (!item || typeof item !== 'object') return null
  if (item.type !== 'Plan') return null

  return {
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
    threadId: typeof payload.thread_id === 'string' ? payload.thread_id : undefined,
    planId: typeof item.id === 'string' ? item.id : undefined,
    planText: typeof item.text === 'string' ? item.text : undefined,
    timestampMs: timestampMs(obj.timestamp, fallbackNow),
    rawEventName: 'item_completed:Plan'
  }
}

function payloadTimestampMs(obj, payload, fallbackNow = Date.now()) {
  const fromEvent = timestampMs(obj && obj.timestamp, NaN)
  if (Number.isFinite(fromEvent)) return fromEvent
  const completedAt = payload && payload.completed_at
  if (Number.isFinite(completedAt)) {
    return completedAt < 1000000000000 ? completedAt * 1000 : completedAt
  }
  return fallbackNow
}

function parseTaskCompleteEvent(obj, fallbackNow = Date.now()) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (!payload || typeof payload !== 'object') return null
  if (payload.type !== 'task_complete') return null

  return {
    turnId: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
    completedAtMs: payloadTimestampMs(obj, payload, fallbackNow),
    rawEventName: 'task_complete'
  }
}

function responseItemTurnId(payload) {
  const meta = payload && payload.internal_chat_message_metadata_passthrough
  return meta && typeof meta.turn_id === 'string' ? meta.turn_id : undefined
}

function parseTurnActivityEvent(obj, fallbackNow = Date.now()) {
  if (!obj || typeof obj !== 'object') return null
  const timestamp = timestampMs(obj.timestamp, fallbackNow)
  if (obj.type === 'response_item') {
    const payload = obj.payload
    const turnId = responseItemTurnId(payload)
    if (!turnId) return null
    const payloadType = payload && typeof payload.type === 'string' ? payload.type : 'unknown'
    return {
      turnId,
      timestampMs: timestamp,
      rawEventName: `response_item:${payloadType}`
    }
  }

  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (!payload || typeof payload !== 'object') return null
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
  if (!turnId) return null
  const payloadType = typeof payload.type === 'string' ? payload.type : 'unknown'
  return {
    turnId,
    timestampMs: timestamp,
    rawEventName: `event_msg:${payloadType}`,
    terminal: payloadType === 'task_complete' || payloadType === 'turn_aborted'
  }
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

function findLatestCodexPlanWait(transcriptPath, options = {}) {
  if (!transcriptPath) return null
  const tail = readFileTail(transcriptPath, options.maxBytes || CODEX_TRANSCRIPT_TAIL_BYTES)
  if (!tail) return null

  const plansByTurn = new Map()
  let latestPlanWithoutTurn = null
  let latest = null

  for (const line of splitJsonlLines(tail.text)) {
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {
      continue
    }

    const plan = parsePlanItemCompletedEvent(obj)
    if (plan) {
      if (plan.turnId) plansByTurn.set(plan.turnId, plan)
      latestPlanWithoutTurn = plan
      continue
    }

    const completion = parseTaskCompleteEvent(obj)
    if (!completion) continue
    const matchedPlan = completion.turnId
      ? plansByTurn.get(completion.turnId)
      : latestPlanWithoutTurn
    if (!matchedPlan) continue

    const hit = {
      turnId: completion.turnId || matchedPlan.turnId,
      threadId: matchedPlan.threadId,
      planId: matchedPlan.planId,
      planText: matchedPlan.planText,
      planCompletedAtMs: matchedPlan.timestampMs,
      completedAtMs: completion.completedAtMs,
      rawEventName: `${matchedPlan.rawEventName}/${completion.rawEventName}`
    }
    if (!matchesOptions(hit, options)) continue
    if (!latest || hit.completedAtMs > latest.completedAtMs) {
      latest = hit
    }
  }

  return latest
}

function findLatestCodexOpenTurnActivity(transcriptPath, options = {}) {
  if (!transcriptPath) return null
  const tail = readFileTail(transcriptPath, options.maxBytes || CODEX_TRANSCRIPT_TAIL_BYTES)
  if (!tail) return null

  const turns = new Map()
  for (const line of splitJsonlLines(tail.text)) {
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {
      continue
    }

    const hit = parseTurnActivityEvent(obj)
    if (!hit) continue
    const record = turns.get(hit.turnId) || { turnId: hit.turnId }
    if (hit.terminal) {
      record.terminalAtMs = hit.timestampMs
      record.terminalRawEventName = hit.rawEventName
    } else if (!record.lastActivityAtMs || hit.timestampMs >= record.lastActivityAtMs) {
      record.lastActivityAtMs = hit.timestampMs
      record.rawEventName = hit.rawEventName
    }
    turns.set(hit.turnId, record)
  }

  let latest = null
  for (const record of turns.values()) {
    if (!Number.isFinite(record.lastActivityAtMs)) continue
    if (Number.isFinite(record.terminalAtMs) && record.terminalAtMs >= record.lastActivityAtMs) continue
    const hit = {
      turnId: record.turnId,
      timestampMs: record.lastActivityAtMs,
      rawEventName: record.rawEventName
    }
    if (!matchesOptions(hit, options)) continue
    if (!latest || hit.timestampMs > latest.timestampMs) latest = hit
  }
  return latest
}

module.exports = {
  CODEX_TRANSCRIPT_TAIL_BYTES,
  parseTurnAbortedEvent,
  parsePlanItemCompletedEvent,
  parseTaskCompleteEvent,
  parseTurnActivityEvent,
  findLatestCodexInterrupt,
  findLatestCodexPlanWait,
  findLatestCodexOpenTurnActivity
}
