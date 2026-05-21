#!/usr/bin/env node
// Optional tmux-managed watcher for tmux-scout.
// It keeps hooks as the primary source, then performs fast lifecycle checks,
// bridge delivery, and narrow transcript interruption checks.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')
const sync = require('./picker/sync')
const { ClaudeTranscriptWatchManager } = require('./lib/claude-transcript-watcher')
const { startBridgeServer } = require('./lib/bridge-server')

const STATUS_DIR = path.join(os.homedir(), '.tmux-scout')
const STATUS_FILE = path.join(STATUS_DIR, 'status.json')
const PID_FILE = path.join(STATUS_DIR, 'watcher.pid')
const STATE_FILE = path.join(STATUS_DIR, 'watcher-state.json')
const LOG_FILE = path.join(STATUS_DIR, 'watcher.log')
const BRIDGE_SOCKET = path.join(STATUS_DIR, 'run', 'bridge.sock')

const DEFAULT_FAST_INTERVAL_MS = 2000

function ensureDir() {
  fs.mkdirSync(STATUS_DIR, { recursive: true })
}

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
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function appendLog(message) {
  try {
    ensureDir()
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch (_) {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

function tmuxOption(name) {
  try {
    return execFileSync('tmux', ['show-option', '-gqv', name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (_) {
    return ''
  }
}

function optionEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['0', 'off', 'false', 'no', 'disabled'].includes(normalized)) return false
  if (['1', 'on', 'true', 'yes', 'enabled'].includes(normalized)) return true
  return true
}

function watchdogEnabled() {
  return optionEnabled(tmuxOption('@scout-watchdog'))
}

function optionSeconds(name, fallbackMs, minMs) {
  const raw = tmuxOption(name)
  const seconds = Number.parseFloat(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.max(minMs, Math.round(seconds * 1000))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readLock() {
  const lock = readJson(PID_FILE, null)
  if (!lock || typeof lock !== 'object') return null
  const pid = Number.parseInt(lock.pid, 10)
  return Number.isInteger(pid) && pid > 0 ? Object.assign({}, lock, { pid }) : null
}

function writeLock() {
  ensureDir()
  writeJsonAtomic(PID_FILE, {
    pid: process.pid,
    startedAt: Date.now(),
    script: __filename
  })
}

function removeOwnLock() {
  const lock = readLock()
  if (lock && lock.pid === process.pid) {
    try { fs.unlinkSync(PID_FILE) } catch (_) {}
  }
}

function loadState() {
  const state = readJson(STATE_FILE, { version: 1 })
  if (!state || typeof state !== 'object') return { version: 1 }
  if (state.codexFiles) delete state.codexFiles
  if (!state.codexTranscripts || typeof state.codexTranscripts !== 'object' || Array.isArray(state.codexTranscripts)) {
    state.codexTranscripts = {}
  }
  return state
}

function pruneState(state) {
  if (state && state.codexFiles) delete state.codexFiles
}

function summarizeStats(stats, durationMs, mode, startedAt, finishedAt) {
  const reconcile = stats && stats.reconcile ? stats.reconcile : {}
  const codex = stats && stats.codex ? stats.codex : {}
  const claudeTranscript = stats && stats.claudeTranscript ? stats.claudeTranscript : {}
  const reconcileChanges = (reconcile.processExits || 0)
    + (reconcile.paneShellExits || 0)
    + (reconcile.paneVanished || 0)
    + (reconcile.pidBindings || 0)
    + (reconcile.paneDiscoveries || 0)
    + (reconcile.discoveryUpdates || 0)
    + (reconcile.discoveryReplacements || 0)
  const evidence = stats && stats.evidence ? stats.evidence : {}
  const registry = stats && stats.registry ? stats.registry : {}
  const claudeInterruptions = claudeTranscript.interrupted || 0
  const codexInterruptions = codex.interrupted || 0
  const claudeIdleInterruptions = claudeTranscript.idleInterrupted || 0
  const codexIdleInterruptions = codex.idleInterrupted || 0

  return {
    mode,
    startedAt,
    finishedAt,
    durationMs,
    changes: reconcileChanges + codexInterruptions + claudeInterruptions + (registry.deleted || 0),
    reconcileChanges,
    processExits: reconcile.processExits || 0,
    paneShellExits: reconcile.paneShellExits || 0,
    paneVanished: reconcile.paneVanished || 0,
    pidBindings: reconcile.pidBindings || 0,
    paneDiscoveries: reconcile.paneDiscoveries || 0,
    discoveryUpdates: reconcile.discoveryUpdates || 0,
    discoveryReplacements: reconcile.discoveryReplacements || 0,
    codexInterrupted: codexInterruptions,
    codexIdleInterrupted: codexIdleInterruptions,
    codexTranscriptRead: codex.filesRead || 0,
    claudeTranscriptRead: claudeTranscript.filesRead || 0,
    claudeTranscriptParseErrors: claudeTranscript.parseErrors || 0,
    claudeInterrupted: claudeInterruptions,
    claudeIdleInterrupted: claudeIdleInterruptions,
    evidenceWritten: evidence.written || 0,
    registryDeleted: registry.deleted || 0,
    registryExpired: registry.expired || 0,
    registryTerminal: registry.terminal || 0,
    registryHidden: registry.hidden || 0,
    registryOverflow: registry.overflow || 0
  }
}

function saveTickSummary(state, summary) {
  state.lastTickDurationMs = summary.durationMs
  state.lastTickSummary = summary
  state.recentTicks = Array.isArray(state.recentTicks) ? state.recentTicks : []
  state.recentTicks.unshift(summary)
  state.recentTicks = state.recentTicks.slice(0, 10)
}

function formatTickDiagnostics(summary) {
  if (!summary || typeof summary !== 'object') return ''
  const parts = []
  if (Number.isFinite(summary.durationMs)) parts.push(`duration=${summary.durationMs}ms`)
  if (Number.isFinite(summary.changes)) parts.push(`changes=${summary.changes}`)
  if (Number.isFinite(summary.reconcileChanges)) parts.push(`reconcile=${summary.reconcileChanges}`)
  if (summary.paneDiscoveries > 0) parts.push(`discover=${summary.paneDiscoveries}`)
  if (summary.discoveryUpdates > 0) parts.push(`discoverUpdate=${summary.discoveryUpdates}`)
  if (summary.discoveryReplacements > 0) parts.push(`discoverReplace=${summary.discoveryReplacements}`)
  if (Number.isFinite(summary.codexTranscriptRead)) parts.push(`codexRead=${summary.codexTranscriptRead}`)
  if (Number.isFinite(summary.claudeTranscriptRead)) parts.push(`claudeRead=${summary.claudeTranscriptRead}`)
  if (summary.claudeTranscriptParseErrors > 0) parts.push(`claudeParseErrors=${summary.claudeTranscriptParseErrors}`)
  if (summary.claudeInterrupted > 0) parts.push(`claudeInterrupted=${summary.claudeInterrupted}`)
  if (summary.claudeIdleInterrupted > 0) parts.push(`claudeIdle=${summary.claudeIdleInterrupted}`)
  if (summary.codexInterrupted > 0) parts.push(`codexInterrupted=${summary.codexInterrupted}`)
  if (summary.codexIdleInterrupted > 0) parts.push(`codexIdle=${summary.codexIdleInterrupted}`)
  if (summary.evidenceWritten > 0) parts.push(`evidence=${summary.evidenceWritten}`)
  if (summary.registryDeleted > 0) parts.push(`deleted=${summary.registryDeleted}`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function bridgeStatus(running) {
  let exists = false
  let isSocket = false
  try {
    const stat = fs.statSync(BRIDGE_SOCKET)
    exists = true
    isSocket = stat.isSocket()
  } catch (_) {}
  if (running) return isSocket ? 'ready' : 'missing'
  return exists ? 'stale' : 'off'
}

function runTick(state, forceFull = false, transcriptWatchManager = null) {
  const startedAt = Date.now()
  if (!state.codexTranscripts || typeof state.codexTranscripts !== 'object' || Array.isArray(state.codexTranscripts)) {
    state.codexTranscripts = {}
  }
  const result = sync.run(STATUS_FILE, {
    codexTranscriptState: state.codexTranscripts
  })
  state.lastMode = forceFull ? 'reconcile:forced' : 'reconcile'

  const finishedAt = Date.now()
  const stats = result && result.stats ? result.stats : null
  const summary = summarizeStats(stats, finishedAt - startedAt, state.lastMode, startedAt, finishedAt)
  state.pid = process.pid
  state.lastTickAt = finishedAt
  state.lastError = null
  saveTickSummary(state, summary)
  pruneState(state)
  writeJsonAtomic(STATE_FILE, state)
  if (transcriptWatchManager && result && result.status) {
    transcriptWatchManager.reconcile(result.status)
  }
  return result
}

async function startOptionalBridge(start = startBridgeServer, log = appendLog) {
  try {
    return await start({ log })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (log) log(`bridge disabled: ${message}`)
    return {
      disabled: true,
      error,
      close() {}
    }
  }
}

async function runLoop({ requireTmuxOption }) {
  ensureDir()

  if (requireTmuxOption && !watchdogEnabled()) return

  const existing = readLock()
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) return

  writeLock()
  process.env.TMUX_SCOUT_BRIDGE_SERVER = '1'
  const bridge = await startOptionalBridge()
  const transcriptWatchManager = new ClaudeTranscriptWatchManager(STATUS_FILE, appendLog)
  process.on('exit', () => {
    bridge.close()
    transcriptWatchManager.close()
    removeOwnLock()
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      bridge.close()
      transcriptWatchManager.close()
      removeOwnLock()
      process.exit(0)
    })
  }

  appendLog(`started pid=${process.pid}`)
  const state = loadState()

  while (true) {
    if (requireTmuxOption && !watchdogEnabled()) break

    try {
      runTick(state, false, transcriptWatchManager)
    } catch (error) {
      state.pid = process.pid
      state.lastTickAt = Date.now()
      state.lastError = error && error.message ? error.message : String(error)
      try { writeJsonAtomic(STATE_FILE, state) } catch (_) {}
      appendLog(`tick error: ${state.lastError}`)
    }

    const fastIntervalMs = optionSeconds('@scout-watchdog-interval', DEFAULT_FAST_INTERVAL_MS, 1000)
    await sleep(fastIntervalMs)
  }

  appendLog(`stopped pid=${process.pid}`)
  bridge.close()
  transcriptWatchManager.close()
  removeOwnLock()
}

function status() {
  const lock = readLock()
  const state = loadState()
  const lastTick = state.lastTickAt ? new Date(state.lastTickAt).toISOString() : 'never'
  const error = state.lastError ? ` error=${JSON.stringify(state.lastError)}` : ''
  const diagnostics = formatTickDiagnostics(state.lastTickSummary)
  const running = Boolean(lock && isPidAlive(lock.pid))
  const bridge = bridgeStatus(running)
  if (running) {
    console.log(`running pid=${lock.pid} bridge=${bridge} lastTick=${lastTick} mode=${state.lastMode || 'unknown'}${diagnostics}${error}`)
    return
  }
  console.log(`stopped bridge=${bridge} lastTick=${lastTick} mode=${state.lastMode || 'unknown'}${diagnostics}${error}`)
}

function stop(quiet) {
  const lock = readLock()
  if (!lock || !isPidAlive(lock.pid)) {
    if (!quiet) console.log('stopped')
    try { fs.unlinkSync(PID_FILE) } catch (_) {}
    return
  }
  try {
    process.kill(lock.pid, 'SIGTERM')
    if (!quiet) console.log(`stopping pid=${lock.pid}`)
  } catch (error) {
    if (!quiet) console.log(`failed to stop pid=${lock.pid}: ${error.message}`)
  }
}

async function main() {
  const command = process.argv[2] || 'start'
  const quiet = process.argv.includes('--quiet')

  if (command === 'start') {
    await runLoop({ requireTmuxOption: true })
  } else if (command === 'run') {
    await runLoop({ requireTmuxOption: false })
  } else if (command === 'once') {
    ensureDir()
    const state = loadState()
    runTick(state, process.argv.includes('--full'))
  } else if (command === 'status') {
    status()
  } else if (command === 'stop') {
    stop(quiet)
  } else {
    console.log('Usage: node watcher.js <start|run|once|status|stop> [--full] [--quiet]')
    process.exit(1)
  }
}

module.exports = {
  runLoop,
  runTick,
  startOptionalBridge,
  optionEnabled,
  watchdogEnabled
}

if (require.main === module) {
  main().catch(error => {
    appendLog(`fatal: ${error && error.message ? error.message : String(error)}`)
    removeOwnLock()
    process.exit(1)
  })
}
