// Session registry maintenance helpers.
//
// The reducer owns per-session lifecycle fields. This module owns aggregate
// registry hygiene: explicit deletes, per-session file removal, and old snapshot
// pruning.

const fs = require('fs')
const path = require('path')
const {
  SESSION_PHASES,
  TERMINAL_SESSION_PHASES,
  phaseFromLegacyStatus
} = require('./session-contract')

const DEFAULT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000
// Stale snapshots are removed after the default auto-collapse interval regardless
// of phase so an obsolete RUNNING/WAIT cannot survive forever.
const DEFAULT_STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_TERMINAL_DISPLAY_MS = 5 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 200

function safeSessionId(sessionId) {
  return String(sessionId).replace(/[/\\:]/g, '_')
}

function sessionFilePath(sessionsDir, sessionId) {
  return path.join(sessionsDir, `${safeSessionId(sessionId)}.json`)
}

function currentPhase(session) {
  if (!session) return SESSION_PHASES.IDLE
  if (session.phase) return session.phase
  if (session.lifecycle && session.lifecycle.phase) return session.lifecycle.phase
  return phaseFromLegacyStatus(session.status, session.needsAttention) || SESSION_PHASES.IDLE
}

function timestampValue(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function lastTouchedAt(session) {
  if (!session) return 0
  return Math.max(
    timestampValue(session.lastUpdated),
    timestampValue(session.lastHookAt),
    timestampValue(session.endedAt),
    timestampValue(session.startedAt),
    session.lastEvent ? timestampValue(session.lastEvent.timestamp) : 0
  )
}

function isActivePhase(phase) {
  return phase === SESSION_PHASES.IDLE ||
    phase === SESSION_PHASES.RUNNING ||
    phase === SESSION_PHASES.WAITING_FOR_APPROVAL ||
    phase === SESSION_PHASES.WAITING_FOR_ANSWER
}

function shouldPruneSession(session, now, options = {}) {
  if (!session || typeof session !== 'object') return 'invalid'
  const retentionMs = Number.isFinite(options.retentionMs)
    ? Math.max(0, options.retentionMs)
    : DEFAULT_SESSION_RETENTION_MS
  const terminalDisplayMs = Number.isFinite(options.terminalDisplayMs)
    ? Math.max(0, options.terminalDisplayMs)
    : DEFAULT_TERMINAL_DISPLAY_MS
  const staleSessionMs = Number.isFinite(options.staleSessionMs)
    ? Math.max(0, options.staleSessionMs)
    : DEFAULT_STALE_SESSION_MS
  const phase = currentPhase(session)
  const endedAt = timestampValue(session.endedAt)

  if (session.isHiddenFromScout && endedAt && now - endedAt >= terminalDisplayMs) {
    return 'hidden'
  }

  if (TERMINAL_SESSION_PHASES.has(phase) && endedAt && now - endedAt >= terminalDisplayMs) {
    return 'terminal'
  }

  if (endedAt && retentionMs > 0 && now - endedAt >= retentionMs) {
    return 'ended-expired'
  }

  const touchedAt = lastTouchedAt(session)
  if (touchedAt && staleSessionMs > 0 && now - touchedAt >= staleSessionMs) {
    return 'stale-expired'
  }

  return null
}

function removeSessionFiles(paths, sessionId) {
  if (!paths || !paths.sessionsDir || !sessionId) return
  try { fs.unlinkSync(sessionFilePath(paths.sessionsDir, sessionId)) } catch (_) {}
}

function deleteSession(status, paths, sessionId, reason = 'deleted') {
  if (!status || !status.sessions || !sessionId) {
    return { changed: false, deleted: [] }
  }
  if (!Object.prototype.hasOwnProperty.call(status.sessions, sessionId)) {
    removeSessionFiles(paths, sessionId)
    return { changed: false, deleted: [] }
  }
  delete status.sessions[sessionId]
  removeSessionFiles(paths, sessionId)
  return { changed: true, deleted: [{ sessionId, reason }] }
}

function pruneOverflow(status, paths, maxSessions) {
  if (!Number.isFinite(maxSessions) || maxSessions <= 0) return []
  const entries = Object.entries(status.sessions || {})
  if (entries.length <= maxSessions) return []

  const active = []
  const inactive = []
  for (const entry of entries) {
    const phase = currentPhase(entry[1])
    if (!entry[1].endedAt && isActivePhase(phase)) active.push(entry)
    else inactive.push(entry)
  }

  const keep = new Set(active.map(([id]) => id))
  const remainingSlots = Math.max(0, maxSessions - keep.size)
  inactive
    .sort((left, right) => lastTouchedAt(right[1]) - lastTouchedAt(left[1]))
    .slice(0, remainingSlots)
    .forEach(([id]) => keep.add(id))

  const deleted = []
  for (const [id] of entries) {
    if (keep.has(id)) continue
    delete status.sessions[id]
    removeSessionFiles(paths, id)
    deleted.push({ sessionId: id, reason: 'overflow' })
  }
  return deleted
}

function pruneSessions(status, paths, options = {}) {
  if (!status || !status.sessions || typeof status.sessions !== 'object') {
    return { changed: false, deleted: [] }
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const deleted = []

  for (const [sessionId, session] of Object.entries(status.sessions)) {
    const reason = shouldPruneSession(session, now, options)
    if (!reason) continue
    delete status.sessions[sessionId]
    removeSessionFiles(paths, sessionId)
    deleted.push({ sessionId, reason })
  }

  deleted.push(...pruneOverflow(
    status,
    paths,
    Number.isFinite(options.maxSessions) ? options.maxSessions : DEFAULT_MAX_SESSIONS
  ))

  return { changed: deleted.length > 0, deleted }
}

module.exports = {
  DEFAULT_SESSION_RETENTION_MS,
  DEFAULT_STALE_SESSION_MS,
  DEFAULT_TERMINAL_DISPLAY_MS,
  DEFAULT_MAX_SESSIONS,
  safeSessionId,
  sessionFilePath,
  currentPhase,
  lastTouchedAt,
  shouldPruneSession,
  deleteSession,
  pruneSessions
}
