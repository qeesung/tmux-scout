#!/usr/bin/env node
// Sync session data: reconcile crashed processes and narrowly check known transcripts.
// Writes results back to status.json. Should run before rendering picker/status lines.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { applySessionEvent, currentPhase } = require('../lib/session-state')
const { DEFAULT_TAIL_BYTES } = require('../lib/jsonl-tail-reader')
const { readProcessTable, findAgentProcessFromPane } = require('../lib/process-tree')
const { isHiddenCodexSession } = require('../lib/codex-session-classifier')
const { AGENT_EVENTS } = require('../lib/agent-events')
const { AGENTS, agentConfig } = require('../lib/agents')
const { findLatestCodexTurnEnd } = require('../lib/codex-transcript-detector')
const { deleteSession, pruneSessions } = require('../lib/session-registry')

let statusFile = process.argv[2] || ''
let sessionsDir = statusFile ? path.join(path.dirname(statusFile), 'sessions') : ''
const pidStateCache = new Map()
const CLAUDE_TRANSCRIPT_TAIL_BYTES = DEFAULT_TAIL_BYTES
const CLAUDE_INTERRUPT_MARKER = '[Request interrupted by user]'
// Claude also writes a '[Request interrupted by user for tool use]' variant;
// matching on the shared prefix + closing ']' covers it and any future '...for X'.
const CLAUDE_INTERRUPT_MARKER_PREFIX = '[Request interrupted by user'
const CODEX_TRANSCRIPT_SETTLE_GATE_MS = 3000
const CODEX_TRANSCRIPT_SCAN_VERSION = 2
const CODEX_STUCK_INTERRUPT_THRESHOLD_MS = 180000
const CLAUDE_IDLE_INTERRUPT_THRESHOLD_MS = 120000

function createStats(options = {}) {
  return {
    startedAt: Date.now(),
    mode: options.codexMode === 'none' || options.codexTranscript === false
      ? 'none'
      : 'known-transcripts',
    reconcile: {
      processExits: 0,
      paneShellExits: 0,
      paneVanished: 0,
      pidBindings: 0,
      paneDiscoveries: 0,
      discoveryUpdates: 0,
      discoveryReplacements: 0
    },
    codex: {
      discovered: 0,
      updated: 0,
      completed: 0,
      interrupted: 0,
      idleInterrupted: 0,
      stale: 0,
      filesRead: 0,
      skippedSettling: 0,
      skippedUnchanged: 0,
      eventsParsed: 0,
      parseErrors: 0
    },
    claudeTranscript: {
      interrupted: 0,
      idleInterrupted: 0,
      filesRead: 0,
      skippedUnchanged: 0,
      parseErrors: 0
    },
    evidence: {
      written: 0
    },
    registry: {
      deleted: 0,
      expired: 0,
      terminal: 0,
      hidden: 0,
      overflow: 0
    }
  }
}

function ensureStats(options = {}) {
  const defaults = createStats(options)
  const stats = options.stats || defaults
  for (const key of ['reconcile', 'codex', 'claudeTranscript', 'evidence', 'registry']) {
    stats[key] = Object.assign({}, defaults[key], stats[key] || {})
  }
  if (!stats.mode) stats.mode = defaults.mode
  return stats
}

// --- I/O helpers ---

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function writeJsonAtomic(filePath, data) {
  const tempPath = filePath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

// --- Status write batching ---
// One sync.run() mutates the in-memory `status` across many sweeps. Each sweep
// historically re-serialized and atomically renamed the WHOLE status.json at its
// own end, so a single churny tick could rewrite the entire registry up to ~9
// times, all producing the same final content. We persist exactly once per run
// instead. Inside run() the sweep-level writes only mark the registry dirty and
// run() flushes one write at the end. A sweep invoked standalone (e.g. a unit test calling
// sync.sweepDeadProcesses directly) still persists immediately, preserving its
// write-through contract.
let statusWriteBatching = false
let statusWriteDirty = false

function persistStatus(status) {
  if (!statusFile) return
  if (statusWriteBatching) {
    statusWriteDirty = true
    return
  }
  writeJsonAtomic(statusFile, status)
}

function sessionFilePath(sessionId) {
  return path.join(sessionsDir, sessionId.replace(/[/\\:]/g, '_') + '.json')
}

function sameAgentType(left, right) {
  return agentConfig(left).id === agentConfig(right).id
}

function discoveryAgentType(agent, proc) {
  if (!agent || agent.id !== 'coco') return agent && agent.id
  const text = String(proc && (proc.basename || proc.command || proc.commandLine || proc.args) || '').toLowerCase()
  if (text.includes('trae')) return 'trae'
  if (text.includes('coco')) return 'coco'
  return 'trae'
}

function discoverySessionId(agentType, paneId) {
  return `tmux-pane:${paneId}:${agentType}`
}

function isDiscoverySession(session) {
  return Boolean(session && (
    session.stateSource === 'pane-discovery' ||
    (session.discovery && session.discovery.source === 'tmux-pane') ||
    (session.lastEvent && session.lastEvent.type === AGENT_EVENTS.DISCOVERED)
  ))
}

function isLiveRealPaneSession(session, paneId, agentType) {
  if (!session || isDiscoverySession(session)) return false
  if (session.tmuxPane !== paneId) return false
  if (!sameAgentType(session.agentType, agentType)) return false
  const phase = currentPhase(session)
  return !session.endedAt && phase !== 'crashed' && phase !== 'stale'
}

function bestAgentProcessForPane(pane, processTable) {
  if (!pane || pane.paneDead || !Number.isInteger(pane.panePid)) return null
  let best = null
  for (const agent of AGENTS) {
    const proc = findAgentProcessFromPane(pane.panePid, agent.id, processTable)
    if (!proc) continue
    if (!best || (proc.score || 0) > (best.proc.score || 0)) {
      best = { agent, proc, agentType: discoveryAgentType(agent, proc) }
    }
  }
  return best
}

function discoveryMetadata(sessionId, pane, hit, now) {
  const proc = hit.proc
  const command = String(proc.commandLine || proc.args || proc.command || '').trim()
  return {
    sessionId,
    agentType: hit.agentType,
    startedAt: Number.isFinite(proc.startedAtMs) ? proc.startedAtMs : now,
    // Discovered sessions have no hook payload cwd; fall back to the pane's
    // current path so the picker shows the project instead of "?".
    workingDirectory: pane.currentPath || undefined,
    tmuxPane: pane.paneId,
    tmuxSessionName: pane.sessionName,
    tmuxWindowIndex: pane.windowIndex,
    tmuxWindowName: pane.windowName,
    pid: proc.pid,
    pidSource: 'process-tree',
    pidCommand: command,
    discoveredAt: now,
    discovery: {
      source: 'tmux-pane',
      paneId: pane.paneId,
      panePid: pane.panePid,
      currentCommand: pane.currentCommand,
      processCommand: command,
      processStartedAt: Number.isFinite(proc.startedAtMs) ? proc.startedAtMs : undefined
    }
  }
}

function compactObject(value) {
  const clean = {}
  for (const [key, item] of Object.entries(value || {})) {
    if (item !== undefined && item !== null && item !== '') clean[key] = item
  }
  return clean
}

function metadataChanged(session, metadata) {
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'discovery') continue
    if (session[key] !== value) return true
  }
  const previous = session.discovery || {}
  const next = metadata.discovery || {}
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] !== value) return true
  }
  return false
}

function preserveStableDiscoveryMetadata(session, metadata) {
  if (!session || !metadata) return
  if (Number.isFinite(session.discoveredAt)) metadata.discoveredAt = session.discoveredAt
  if (session.pid !== metadata.pid) return

  if (Number.isFinite(session.startedAt)) metadata.startedAt = session.startedAt
  if (!metadata.discovery) metadata.discovery = {}
  if (Number.isFinite(session.discovery && session.discovery.processStartedAt)) {
    metadata.discovery.processStartedAt = session.discovery.processStartedAt
  }
}

function writeSessionIfNeeded(sessionId, session, options = {}) {
  if (options.writeSession === false) return
  writeJsonAtomic(sessionFilePath(sessionId), session)
}

function writeStatusIfNeeded(status, options = {}) {
  if (options.writeStatus === false || !statusFile) return
  persistStatus(status)
}

function removeDiscoverySession(status, sessionId, stats, options = {}) {
  let changed = false
  if (options.writeSession === false) {
    changed = Object.prototype.hasOwnProperty.call(status.sessions || {}, sessionId)
    if (changed) delete status.sessions[sessionId]
  } else {
    changed = deleteSession(status, { sessionsDir }, sessionId, 'replaced-by-real-session').changed
  }
  if (!changed) return false
  if (stats && stats.reconcile) stats.reconcile.discoveryReplacements++
  writeStatusIfNeeded(status, options)
  return true
}

function upsertDiscoverySession(status, sessionId, pane, hit, stats, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const existing = status.sessions[sessionId]
  const phase = existing ? currentPhase(existing) : null
  const replace = existing && (existing.endedAt || phase === 'crashed' || phase === 'stale')
  const base = replace ? null : existing
  const metadata = compactObject(discoveryMetadata(sessionId, pane, hit, now))
  metadata.discovery = compactObject(metadata.discovery)
  preserveStableDiscoveryMetadata(base, metadata)
  if (base && !metadataChanged(base, metadata)) return false
  if (replace) {
    if (options.writeSession === false) delete status.sessions[sessionId]
    else deleteSession(status, { sessionsDir }, sessionId, 'discovery-reused')
  }

  const session = base || {
    sessionId,
    agentType: hit.agentType,
    startedAt: metadata.startedAt || now
  }
  const before = JSON.stringify(session)
  const event = {
    type: AGENT_EVENTS.DISCOVERED,
    source: 'pane',
    stateSource: 'pane-discovery',
    rawEventName: 'tmux_pane_discovered',
    timestamp: now,
    phase: 'idle',
    details: `${hit.agentType} process discovered in tmux pane ${pane.paneId}`,
    pid: hit.proc.pid,
    tmuxPane: pane.paneId,
    updates: metadata
  }
  applySessionEvent(session, event)
  if (!session.sessionTitle) session.sessionTitle = `${hit.agentType} session`
  status.sessions[sessionId] = session
  writeSessionIfNeeded(sessionId, session, options)

  if (before !== JSON.stringify(session)) {
    if (stats && stats.reconcile) {
      if (base) stats.reconcile.discoveryUpdates++
      else stats.reconcile.paneDiscoveries++
    }
    return true
  }
  return false
}

function discoverPaneSessions(status, panes, processTable, stats, options = {}) {
  if (!status || !status.sessions || !panes || panes.tmuxAvailable !== true) return false
  let changed = false

  for (const pane of panes.values()) {
    if (!pane || pane.paneDead) continue
    const hit = bestAgentProcessForPane(pane, processTable)
    if (!hit || !hit.agentType) continue
    const sessionId = discoverySessionId(hit.agentType, pane.paneId)
    const hasRealSession = Object.values(status.sessions || {}).some(session => {
      return isLiveRealPaneSession(session, pane.paneId, hit.agentType)
    })
    if (hasRealSession) {
      changed = removeDiscoverySession(status, sessionId, stats, options) || changed
      continue
    }
    changed = upsertDiscoverySession(status, sessionId, pane, hit, stats, options) || changed
  }

  if (changed) {
    status.lastUpdated = Number.isFinite(options.now) ? options.now : Date.now()
    writeStatusIfNeeded(status, options)
  }
  return changed
}

// --- tmux pane snapshot ---

function getPaneSnapshot() {
  const panes = new Map()
  panes.tmuxAvailable = false
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_current_path}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    panes.tmuxAvailable = true

    if (!output) return panes

    for (const line of output.split('\n')) {
      const [paneId, panePid, currentCommand, paneDead, sessionName, windowIndex, windowName, currentPath] = line.split('\t')
      if (paneId) {
        panes.set(paneId.trim(), {
          paneId: paneId.trim(),
          panePid: Number.parseInt(panePid, 10) || null,
          currentCommand: currentCommand || '',
          paneDead: paneDead === '1',
          sessionName: sessionName || '',
          windowIndex: Number.parseInt(windowIndex, 10) || 0,
          windowName: windowName || '',
          currentPath: (currentPath || '').trim()
        })
      }
    }
  } catch (_) {}
  return panes
}

// --- PID helpers ---

function hasTrackedPid(session) {
  return Number.isInteger(session.pid) && session.pid > 0
}

function isRecordedProcessExit(session) {
  return currentPhase(session) === 'interrupted' && session.terminalKind === 'processExit'
}

function getPidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  if (pidStateCache.has(pid)) return pidStateCache.get(pid)

  let state = 'unknown'
  try {
    process.kill(pid, 0)
    state = 'alive'
  } catch (error) {
    if (error && error.code === 'ESRCH') state = 'dead'
    else if (error && error.code === 'EPERM') state = 'alive'
  }

  pidStateCache.set(pid, state)
  return state
}

function clearPidStateCache() {
  pidStateCache.clear()
}

// --- Crash detection ---

function enrichSessionEvent(session, event) {
  return Object.assign({
    transcriptPath: session && session.transcriptPath,
    tmuxPane: session && session.tmuxPane,
    pid: session && session.pid
  }, event || {})
}

function applySessionUpdate(status, sessionId, session, event, stats) {
  const result = applySessionEvent(session, enrichSessionEvent(session, event))
  if (!result.changed) return false
  if (result.evidenceChanged && stats && stats.evidence) stats.evidence.written++
  status.sessions[sessionId] = session
  writeJsonAtomic(sessionFilePath(sessionId), session)
  return true
}

function sweepPidBindings(status, panes, processTable, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (!session || session.endedAt || !pane) continue

    const phase = currentPhase(session)
    if (phase !== 'running' && phase !== 'waitingForApproval' && phase !== 'waitingForAnswer') continue

    const agentProcess = findAgentProcessFromPane(pane.panePid, session.agentType, processTable)
    if (!agentProcess || agentProcess.pid === session.pid) continue

    session.pid = agentProcess.pid
    session.pidSource = 'process-tree'
    session.pidCommand = agentProcess.command
    session.pidBoundAt = now
    session.lastUpdated = now
    writeJsonAtomic(sessionFilePath(sessionId), session)
    if (stats) stats.reconcile.pidBindings++
    changed = true
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

function exitEventForSession(session, reason, source, now) {
  const phase = currentPhase(session)
  const active = phase === 'running' || phase === 'waitingForApproval' || phase === 'waitingForAnswer'
  if (active && source !== 'pane') {
    session.terminalKind = 'processExit'
    session.terminalReason = reason
    return {
      type: AGENT_EVENTS.PROCESS_EXIT_DETECTED,
      source,
      timestamp: now,
      reason,
      details: reason,
      force: true
    }
  }

  session.staleReason = reason
  session.terminalKind = source === 'pane' ? 'paneGone' : 'stale'
  session.terminalReason = reason
  return {
    type: AGENT_EVENTS.STALE,
    source,
    timestamp: now,
    reason,
    details: reason,
    terminalKind: source === 'pane' ? 'paneGone' : 'stale',
    terminalReason: reason,
    force: true
  }
}

function sweepDeadProcesses(status, panes, processTable, stats) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || isHiddenCodexSession(session)) continue
    const pane = session && session.tmuxPane ? panes.get(session.tmuxPane) : null
    if (isRecordedProcessExit(session)) continue
    if (session.endedAt || !pane || !hasTrackedPid(session)) continue
    if (getPidState(session.pid) !== 'dead') continue

    // Stored pid is dead, but the agent may still be alive under the pane —
    // the previous binding could have been a transient child process. Rebind
    // to a live descendant ONLY when it has been running since before the
    // session started; a newer process is a fresh agent that needs its own
    // session, not a continuation of the dead one.
    const liveAgent = findAgentProcessFromPane(pane.panePid, session.agentType, processTable)
    if (liveAgent && getPidState(liveAgent.pid) !== 'dead') {
      const sessionStartedAt = Number.isFinite(session.startedAt) ? session.startedAt : null
      const procStartedAt = Number.isFinite(liveAgent.startedAtMs) ? liveAgent.startedAtMs : null
      if (procStartedAt !== null && sessionStartedAt !== null && procStartedAt <= sessionStartedAt) {
        session.pid = liveAgent.pid
        session.pidSource = 'process-tree'
        session.pidCommand = liveAgent.commandLine || liveAgent.args || liveAgent.command
        session.pidBoundAt = now
        session.lastUpdated = now
        writeJsonAtomic(sessionFilePath(sessionId), session)
        if (stats) stats.reconcile.pidBindings++
        changed = true
        continue
      }
    }

    const reason = `pid ${session.pid} exited while pane ${session.tmuxPane} remained open`
    const updated = applySessionUpdate(status, sessionId, session, exitEventForSession(session, reason, 'pid', now), stats)
    if (updated && stats) stats.reconcile.processExits++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

function sweepVanishedPanes(status, panes, stats) {
  if (!panes || panes.tmuxAvailable !== true) return
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || session.endedAt) continue
    if (isHiddenCodexSession(session)) continue
    if (!session.tmuxPane) continue
    if (panes.has(session.tmuxPane)) continue

    const reason = `pane ${session.tmuxPane} no longer exists`
    const updated = applySessionUpdate(status, sessionId, session, exitEventForSession(session, reason, 'pane', now), stats)
    if (updated && stats) stats.reconcile.paneVanished++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

function reconcileSessions(status, panes, stats, options = {}) {
  const processTable = readProcessTable()
  if (options.paneDiscovery !== false) {
    discoverPaneSessions(status, panes, processTable, stats)
  }
  sweepVanishedPanes(status, panes, stats)
  // Rebind before liveness check so a stale binding gets a chance to move
  // to a live agent descendant before sweepDeadProcesses sees the dead pid.
  sweepPidBindings(status, panes, processTable, stats)
  sweepDeadProcesses(status, panes, processTable, stats)
}

// --- Codex transcript helpers ---

function codexTurnEndForSession(session) {
  const transcriptPath = session && session.transcriptPath
  if (!transcriptPath) return null

  const expectedTurnId = session && session.lastTurnId
  const minTimestampMs = Math.max(0, (session.lastUpdated || session.startedAt || 0) - 1000)

  if (expectedTurnId) {
    // Never degrade an exact turn lookup into timestamp matching. A
    // different or missing turn_id is not evidence that the current turn
    // ended, even if its timestamp is recent.
    return findLatestCodexTurnEnd(transcriptPath, { expectTurnId: expectedTurnId })
  }

  return findLatestCodexTurnEnd(transcriptPath, { minTimestampMs })
}

function codexTranscriptState(options) {
  const state = options && options.codexTranscriptState
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null
}

function codexTranscriptSettleGateMs(options) {
  if (options && Number.isFinite(options.codexTranscriptSettleGateMs)) {
    return Math.max(0, options.codexTranscriptSettleGateMs)
  }
  return CODEX_TRANSCRIPT_SETTLE_GATE_MS
}

function optionDisabled(options, key) {
  return options && options[key] === false
}

function thresholdMs(options, key, fallback) {
  if (options && Number.isFinite(options[key])) return Math.max(0, options[key])
  return fallback
}

function latestTurnKey(session) {
  return session && session.lastTurnId ? String(session.lastTurnId) : null
}

function statTranscriptFile(transcriptPath) {
  try {
    return fs.statSync(transcriptPath)
  } catch (_) {
    return null
  }
}

function shouldSkipCodexTranscriptScan(sessionId, session, options, stats, now) {
  const settleGateMs = codexTranscriptSettleGateMs(options)
  const lastChangedAt = Math.max(
    Number.isFinite(session.lastUpdated) ? session.lastUpdated : 0,
    Number.isFinite(session.lastHookAt) ? session.lastHookAt : 0
  )
  if (settleGateMs > 0 && lastChangedAt > 0 && now - lastChangedAt < settleGateMs) {
    if (stats && stats.codex) stats.codex.skippedSettling++
    return { skip: true }
  }

  const state = codexTranscriptState(options)
  if (!state) return { skip: false }

  const stat = statTranscriptFile(session.transcriptPath)
  if (!stat) return { skip: true }

  const cache = state[sessionId]
  const turnKey = latestTurnKey(session)
  if (cache &&
    cache.scanVersion === CODEX_TRANSCRIPT_SCAN_VERSION &&
    cache.transcriptPath === session.transcriptPath &&
    cache.latestTurnId === turnKey &&
    cache.lastScannedSize === stat.size &&
    cache.lastScannedMtimeMs === stat.mtimeMs &&
    cache.lastScannedInode === stat.ino) {
    if (stats && stats.codex) stats.codex.skippedUnchanged++
    return { skip: true, stat }
  }

  return { skip: false, stat }
}

function updateCodexTranscriptScanState(sessionId, session, options, stat, now) {
  const state = codexTranscriptState(options)
  if (!state) return
  const nextStat = stat || statTranscriptFile(session.transcriptPath)
  if (!nextStat) return
  state[sessionId] = {
    scanVersion: CODEX_TRANSCRIPT_SCAN_VERSION,
    transcriptPath: session.transcriptPath,
    latestTurnId: latestTurnKey(session),
    lastScannedSize: nextStat.size,
    lastScannedMtimeMs: nextStat.mtimeMs,
    lastScannedInode: nextStat.ino,
    lastScannedAt: now
  }
}

function pruneCodexTranscriptScanState(status, options) {
  const state = codexTranscriptState(options)
  if (!state) return
  const keep = new Set()
  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (!session || session.agentType !== 'codex' || session.endedAt || !session.transcriptPath) continue
    if (session.isRemote || session.parentSessionId) continue
    if (!isActiveCodexTranscriptPhase(currentPhase(session))) continue
    keep.add(sessionId)
  }
  for (const sessionId of Object.keys(state)) {
    if (!keep.has(sessionId)) delete state[sessionId]
  }
}

function isActiveCodexTranscriptPhase(phase) {
  return phase === 'running'
}

function sweepCompletedCodexTranscripts(status, stats, options = {}) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (!session || session.agentType !== 'codex' || session.endedAt) continue
    if (session.isRemote) continue
    if (session.parentSessionId) continue
    if (!isActiveCodexTranscriptPhase(currentPhase(session))) continue
    if (!session.transcriptPath) continue

    const scan = shouldSkipCodexTranscriptScan(sessionId, session, options, stats, now)
    if (scan.skip) continue

    if (stats && stats.codex) stats.codex.filesRead++
    const hit = codexTurnEndForSession(session)
    updateCodexTranscriptScanState(sessionId, session, options, scan.stat, now)
    if (!hit) continue

    const interrupted = hit.completionKind === 'interrupted'

    const updated = applySessionUpdate(status, sessionId, session, {
      type: AGENT_EVENTS.TURN_COMPLETE,
      source: 'transcript',
      timestamp: hit.endedAtMs || now,
      reason: interrupted
        ? 'Codex transcript recorded turn_aborted/interrupted'
        : 'Codex transcript recorded task_complete',
      details: interrupted ? 'interrupted' : 'completed',
      rawEventName: hit.rawEventName || (interrupted ? 'turn_aborted' : 'task_complete'),
      turnId: hit.turnId,
      transcriptPath: session.transcriptPath,
      force: false
    }, stats)
    if (updated && stats && stats.codex) {
      if (interrupted) stats.codex.interrupted++
      else stats.codex.completed++
    }
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

function sweepStuckCodexSessions(status, stats, options = {}) {
  if (optionDisabled(options, 'stuckSweep') || optionDisabled(options, 'idleInterrupt')) return
  const now = Date.now()
  const maxIdleMs = thresholdMs(options, 'codexStuckInterruptMs', CODEX_STUCK_INTERRUPT_THRESHOLD_MS)
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (isHiddenCodexSession(session)) continue
    if (!session || session.agentType !== 'codex' || session.endedAt) continue
    if (session.isRemote) continue
    if (session.parentSessionId) continue
    if (currentPhase(session) !== 'running') continue
    if (!session.activeTool) continue

    const updatedAt = Number.isFinite(session.lastUpdated) ? session.lastUpdated : 0
    if (!updatedAt || now - updatedAt < maxIdleMs) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: AGENT_EVENTS.TURN_COMPLETE,
      source: 'transcript',
      timestamp: now,
      reason: `Codex active tool ${session.activeTool} idle for ${Math.floor((now - updatedAt) / 1000)}s`,
      details: 'codex active tool idle without a stop hook',
      rawEventName: 'codex_stuck_sweep',
      transcriptPath: session.transcriptPath,
      force: true
    }, stats)
    if (updated && stats && stats.codex) {
      stats.codex.interrupted++
      stats.codex.idleInterrupted++
    }
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

function syncCodexSessions(status, panes, options = {}, stats) {
  if (options.codexMode === 'none' || options.codexTranscript === false) return
  sweepCompletedCodexTranscripts(status, stats, options)
  sweepStuckCodexSessions(status, stats, options)
  pruneCodexTranscriptScanState(status, options)
}

function pruneRegistrySessions(status, stats, options = {}) {
  if (options.registryPrune === false) return { changed: false, deleted: [] }
  const result = pruneSessions(status, { sessionsDir }, {
    now: Number.isFinite(options.registryNow) ? options.registryNow : undefined,
    retentionMs: options.sessionRetentionMs,
    staleSessionMs: options.staleSessionMs,
    terminalDisplayMs: options.terminalDisplayMs,
    maxSessions: options.maxSessions
  })
  if (!result.changed) return result

  const now = Date.now()
  status.lastUpdated = now
  persistStatus(status)

  if (stats && stats.registry) {
    stats.registry.deleted += result.deleted.length
    for (const item of result.deleted) {
      if (item.reason === 'terminal') stats.registry.terminal++
      else if (item.reason === 'hidden') stats.registry.hidden++
      else if (item.reason === 'overflow') stats.registry.overflow++
      else stats.registry.expired++
    }
  }
  pruneCodexTranscriptScanState(status, options)
  pruneClaudeTranscriptScanState(status, options)
  return result
}

// --- Claude transcript helpers ---

function readFileTail(filePath, maxBytes, preStat) {
  try {
    const stat = preStat || fs.statSync(filePath)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    if (length <= 0) return { text: '', mtimeMs: stat.mtimeMs }

    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = fs.readSync(fd, buffer, 0, length, start)
      let text = buffer.toString('utf-8', 0, bytesRead)
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
      }
      return { text, mtimeMs: stat.mtimeMs }
    } finally {
      fs.closeSync(fd)
    }
  } catch (_) {
    return null
  }
}

// Strict structural match: the interrupt marker is a `type:'user'` message whose
// content carries a text block whose text starts with the marker prefix and ends
// ']'. Matching the phrase anywhere in the object (the old recursive behaviour)
// false-positives whenever a prompt or an assistant message merely quotes
// '[Request interrupted by user]'.
function isClaudeInterruptText(value) {
  const text = String(value == null ? '' : value).trim()
  return text.startsWith(CLAUDE_INTERRUPT_MARKER_PREFIX) && text.endsWith(']')
}

function isClaudeInterruptObject(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'user') return false
  const message = obj.message
  if (!message || typeof message !== 'object') return false
  const content = message.content
  if (Array.isArray(content)) {
    return content.some(block =>
      block && typeof block === 'object' &&
      block.type === 'text' && typeof block.text === 'string' &&
      isClaudeInterruptText(block.text))
  }
  if (typeof content === 'string') return isClaudeInterruptText(content)
  return false
}

function eventTimestampMs(obj) {
  if (!obj || typeof obj !== 'object') return null
  for (const key of ['timestamp', 'created_at', 'createdAt']) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = new Date(value).getTime()
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function findLatestClaudeInterrupt(transcriptPath, sinceMs, stats, preStat) {
  const tail = readFileTail(transcriptPath, CLAUDE_TRANSCRIPT_TAIL_BYTES, preStat)
  if (!tail) return null
  if (stats) stats.claudeTranscript.filesRead++

  const hits = []
  for (const line of tail.text.split('\n')) {
    if (!line.trim()) continue
    let obj = null
    try {
      obj = JSON.parse(line)
    } catch (_) {
      if (stats) stats.claudeTranscript.parseErrors++
    }

    const hit = obj ? isClaudeInterruptObject(obj) : false
    if (!hit) continue
    hits.push({
      timestamp: eventTimestampMs(obj),
      rawLine: line
    })
  }

  const threshold = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs - 1000 : 0
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index]
    if (Number.isFinite(hit.timestamp)) {
      if (!threshold || hit.timestamp >= threshold) return hit
      continue
    }
    if (!threshold || tail.mtimeMs >= threshold) return hit
  }
  return null
}

function claudeTranscriptState(options) {
  const state = options && options.claudeTranscriptState
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null
}

// Skip the 128KB tail read + per-line JSON.parse when a running Claude
// transcript has not changed since the last scan. Mirrors the Codex scan cache
// (keyed on transcriptPath/size/mtimeMs/inode). No settle gate: unlike Codex, the
// Claude sweep must react to an
// interrupt marker the moment it lands, and an appended marker always grows
// size+mtimeMs -> cache miss -> rescan, so a genuine interrupt is never skipped.
// Returns { skip, stat } so a cache miss reuses the stat for readFileTail
// (one statSync per changed transcript, not two). No cache configured -> never
// skip (preserves standalone / picker behaviour).
function shouldSkipClaudeTranscriptScan(sessionId, session, options, stats) {
  const state = claudeTranscriptState(options)
  if (!state) return { skip: false }

  const stat = statTranscriptFile(session.transcriptPath)
  if (!stat) return { skip: false }

  const cache = state[sessionId]
  if (cache &&
    cache.transcriptPath === session.transcriptPath &&
    cache.lastScannedSize === stat.size &&
    cache.lastScannedMtimeMs === stat.mtimeMs &&
    cache.lastScannedInode === stat.ino) {
    if (stats && stats.claudeTranscript) stats.claudeTranscript.skippedUnchanged++
    return { skip: true, stat }
  }
  return { skip: false, stat }
}

function updateClaudeTranscriptScanState(sessionId, session, options, stat, now) {
  const state = claudeTranscriptState(options)
  if (!state) return
  const nextStat = stat || statTranscriptFile(session.transcriptPath)
  if (!nextStat) return
  state[sessionId] = {
    transcriptPath: session.transcriptPath,
    lastScannedSize: nextStat.size,
    lastScannedMtimeMs: nextStat.mtimeMs,
    lastScannedInode: nextStat.ino,
    lastScannedAt: now
  }
}

function pruneClaudeTranscriptScanState(status, options) {
  const state = claudeTranscriptState(options)
  if (!state) return
  const keep = new Set()
  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || session.agentType !== 'claude' || session.endedAt || !session.transcriptPath) continue
    if (currentPhase(session) !== 'running') continue
    keep.add(sessionId)
  }
  for (const sessionId of Object.keys(state)) {
    if (!keep.has(sessionId)) delete state[sessionId]
  }
}

function sweepInterruptedClaudeTranscripts(status, stats, options = {}) {
  const now = Date.now()
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || session.agentType !== 'claude' || session.endedAt || session.isRemote) continue
    if (currentPhase(session) !== 'running') continue
    if (!session.transcriptPath) continue

    const scan = shouldSkipClaudeTranscriptScan(sessionId, session, options, stats)
    if (scan.skip) continue

    const hit = findLatestClaudeInterrupt(session.transcriptPath, session.lastUpdated || session.startedAt, stats, scan.stat)
    updateClaudeTranscriptScanState(sessionId, session, options, scan.stat, now)
    if (!hit) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: AGENT_EVENTS.TURN_COMPLETE,
      source: 'transcript',
      timestamp: now,
      reason: 'Claude transcript recorded request interruption',
      details: CLAUDE_INTERRUPT_MARKER,
      force: false
    }, stats)
    if (updated && stats) stats.claudeTranscript.interrupted++
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
  pruneClaudeTranscriptScanState(status, options)
}

// Claude-only interrupt fallback. The condition is exact:
// local Claude + running + no activeTool + 120s since updatedAt. Transcript
// mtime, prose, pending display fields and all other agents are irrelevant.
function sweepIdleRunningSessions(status, stats, options = {}) {
  if (optionDisabled(options, 'idleComplete')) return
  const now = Date.now()
  const maxIdleMs = thresholdMs(options, 'idleCompleteMs', CLAUDE_IDLE_INTERRUPT_THRESHOLD_MS)
  let changed = false

  for (const [sessionId, session] of Object.entries(status.sessions || {})) {
    if (!session || session.endedAt) continue
    if (session.agentType !== 'claude') continue
    if (currentPhase(session) !== 'running') continue
    if (session.activeTool) continue
    if (session.isRemote) continue

    const updatedAt = Number.isFinite(session.lastUpdated) ? session.lastUpdated : 0
    if (!updatedAt || now - updatedAt < maxIdleMs) continue

    const updated = applySessionUpdate(status, sessionId, session, {
      type: AGENT_EVENTS.TURN_COMPLETE,
      source: 'stale',
      timestamp: now,
      reason: `Claude idle for ${Math.floor((now - updatedAt) / 1000)}s without an active tool`,
      details: 'Claude idle interrupt fallback',
      rawEventName: 'claude_idle_interrupt_sweep',
      transcriptPath: session.transcriptPath,
      force: true
    }, stats)
    if (updated && stats && stats.claudeTranscript) {
      stats.claudeTranscript.idleInterrupted++
    }
    changed = updated || changed
  }

  if (changed) {
    status.lastUpdated = now
    persistStatus(status)
  }
}

// --- Main ---

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function isWatcherRunning() {
  const pidFile = path.join(os.homedir(), '.tmux-scout', 'watcher.pid')
  const lock = readJson(pidFile, null)
  const pid = Number.parseInt(lock && lock.pid, 10)
  return isPidAlive(pid)
}

function run(file, options = {}) {
  clearPidStateCache()
  const stats = ensureStats(options)
  stats.startedAt = Date.now()

  if (file) {
    statusFile = file
    sessionsDir = path.join(path.dirname(file), 'sessions')
  }
  if (!statusFile) return { status: null, panes: new Map(), stats }
  const status = readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const panes = getPaneSnapshot()

  // Batch every sweep's status.json write into a single flush at the end of the
  // run — the whole reconcile pass persists the registry exactly once.
  statusWriteBatching = true
  statusWriteDirty = false
  try {
    if (options.reconcile !== false) reconcileSessions(status, panes, stats, options)
    syncCodexSessions(status, panes, options, stats)
    if (options.claudeTranscript !== false) sweepInterruptedClaudeTranscripts(status, stats, options)
    sweepIdleRunningSessions(status, stats, options)
    pruneRegistrySessions(status, stats, options)
  } finally {
    statusWriteBatching = false
    if (statusWriteDirty && options.writeStatus !== false) {
      writeJsonAtomic(statusFile, status)
    }
    statusWriteDirty = false
  }

  stats.durationMs = Date.now() - stats.startedAt
  return { status, panes, stats }
}

module.exports = {
  run,
  isWatcherRunning,
  clearPidStateCache,
  createStats,
  sweepVanishedPanes,
  sweepDeadProcesses,
  pruneRegistrySessions,
  discoverPaneSessions,
  discoverySessionId,
  isDiscoverySession
}

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
