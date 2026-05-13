#!/usr/bin/env node
// Optional tmux-managed watcher for tmux-scout.
// It keeps hooks as the primary source, then performs fast lifecycle checks,
// incremental Codex transcript reads, and slower full reconciles.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')
const sync = require('./picker/sync')

const STATUS_DIR = path.join(os.homedir(), '.tmux-scout')
const STATUS_FILE = path.join(STATUS_DIR, 'status.json')
const PID_FILE = path.join(STATUS_DIR, 'watcher.pid')
const STATE_FILE = path.join(STATUS_DIR, 'watcher-state.json')
const LOG_FILE = path.join(STATUS_DIR, 'watcher.log')

const DEFAULT_FAST_INTERVAL_MS = 2000
const DEFAULT_DISCOVERY_INTERVAL_MS = 30000
const DEFAULT_FULL_INTERVAL_MS = 60000
const STALE_STATE_MS = 24 * 60 * 60 * 1000

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
  return ['1', 'on', 'true', 'yes', 'enabled'].includes(String(value || '').trim().toLowerCase())
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
  const state = readJson(STATE_FILE, { version: 1, codexFiles: {} })
  if (!state || typeof state !== 'object') return { version: 1, codexFiles: {} }
  if (!state.codexFiles || typeof state.codexFiles !== 'object') state.codexFiles = {}
  return state
}

function pruneState(state) {
  const cutoff = Date.now() - STALE_STATE_MS
  for (const [filePath, fileState] of Object.entries(state.codexFiles || {})) {
    const lastReadAt = Number.isFinite(fileState && fileState.lastReadAt) ? fileState.lastReadAt : 0
    if (lastReadAt && lastReadAt >= cutoff) continue
    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs >= cutoff) continue
    } catch (_) {}
    delete state.codexFiles[filePath]
  }
}

function summarizeStats(stats, durationMs, mode, startedAt, finishedAt) {
  const reconcile = stats && stats.reconcile ? stats.reconcile : {}
  const codex = stats && stats.codex ? stats.codex : {}
  const claudeTranscript = stats && stats.claudeTranscript ? stats.claudeTranscript : {}
  const paneGroundTruth = stats && stats.paneGroundTruth ? stats.paneGroundTruth : {}
  const stuckTools = stats && stats.stuckTools ? stats.stuckTools : {}
  const reconcileChanges = (reconcile.processExits || 0)
    + (reconcile.paneShellExits || 0)
    + (reconcile.pidBindings || 0)
  const codexChanges = (codex.discovered || 0) + (codex.updated || 0) + (codex.stale || 0)
  const paneUpdates = paneGroundTruth.updates || 0
  const stuckInterruptions = stuckTools.interrupted || 0
  const claudeInterruptions = claudeTranscript.interrupted || 0

  return {
    mode,
    startedAt,
    finishedAt,
    durationMs,
    changes: reconcileChanges + codexChanges + paneUpdates + stuckInterruptions + claudeInterruptions,
    reconcileChanges,
    processExits: reconcile.processExits || 0,
    paneShellExits: reconcile.paneShellExits || 0,
    pidBindings: reconcile.pidBindings || 0,
    codexDiscovered: codex.discovered || 0,
    codexUpdated: codex.updated || 0,
    codexStale: codex.stale || 0,
    codexFilesRead: codex.filesRead || 0,
    codexEventsParsed: codex.eventsParsed || 0,
    codexParseErrors: codex.parseErrors || 0,
    claudeTranscriptRead: claudeTranscript.filesRead || 0,
    claudeTranscriptParseErrors: claudeTranscript.parseErrors || 0,
    claudeInterrupted: claudeInterruptions,
    paneUpdates,
    stuckToolInterruptions: stuckInterruptions
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
  if (Number.isFinite(summary.codexFilesRead)) parts.push(`codexRead=${summary.codexFilesRead}`)
  if (Number.isFinite(summary.codexEventsParsed)) parts.push(`codexParsed=${summary.codexEventsParsed}`)
  if (summary.codexParseErrors > 0) parts.push(`codexParseErrors=${summary.codexParseErrors}`)
  if (Number.isFinite(summary.claudeTranscriptRead)) parts.push(`claudeRead=${summary.claudeTranscriptRead}`)
  if (summary.claudeTranscriptParseErrors > 0) parts.push(`claudeParseErrors=${summary.claudeTranscriptParseErrors}`)
  if (summary.claudeInterrupted > 0) parts.push(`claudeInterrupted=${summary.claudeInterrupted}`)
  if (summary.codexDiscovered > 0) parts.push(`codexDiscovered=${summary.codexDiscovered}`)
  if (summary.codexUpdated > 0) parts.push(`codexUpdated=${summary.codexUpdated}`)
  if (summary.codexStale > 0) parts.push(`codexStale=${summary.codexStale}`)
  if (summary.paneUpdates > 0) parts.push(`paneUpdates=${summary.paneUpdates}`)
  if (summary.stuckToolInterruptions > 0) parts.push(`stuckTools=${summary.stuckToolInterruptions}`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function runTick(state, forceFull = false) {
  const startedAt = Date.now()
  const now = startedAt
  const discoveryIntervalMs = optionSeconds('@scout-watchdog-discovery-interval', DEFAULT_DISCOVERY_INTERVAL_MS, 5000)
  const fullIntervalMs = optionSeconds('@scout-watchdog-full-interval', DEFAULT_FULL_INTERVAL_MS, 10000)
  const discoverDue = now - (state.lastDiscoveryAt || 0) >= discoveryIntervalMs
  const fullDue = forceFull || now - (state.lastFullReconcileAt || 0) >= fullIntervalMs
  let result

  if (fullDue) {
    result = sync.run(STATUS_FILE)
    state.lastFullReconcileAt = now
    state.lastDiscoveryAt = now
    state.lastMode = 'full'
  } else {
    result = sync.run(STATUS_FILE, {
      codexMode: 'incremental',
      watcherState: state,
      discoverCodex: discoverDue
    })
    if (discoverDue) state.lastDiscoveryAt = now
    state.lastMode = discoverDue ? 'incremental+discover' : 'incremental'
  }

  const finishedAt = Date.now()
  const stats = result && result.stats ? result.stats : null
  const summary = summarizeStats(stats, finishedAt - startedAt, state.lastMode, startedAt, finishedAt)
  state.pid = process.pid
  state.lastTickAt = finishedAt
  state.lastError = null
  saveTickSummary(state, summary)
  pruneState(state)
  writeJsonAtomic(STATE_FILE, state)
}

async function runLoop({ requireTmuxOption }) {
  ensureDir()

  if (requireTmuxOption && !watchdogEnabled()) return

  const existing = readLock()
  if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) return

  writeLock()
  process.on('exit', removeOwnLock)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      removeOwnLock()
      process.exit(0)
    })
  }

  appendLog(`started pid=${process.pid}`)
  const state = loadState()

  while (true) {
    if (requireTmuxOption && !watchdogEnabled()) break

    try {
      runTick(state)
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
  removeOwnLock()
}

function status() {
  const lock = readLock()
  const state = loadState()
  const files = Object.keys(state.codexFiles || {}).length
  const lastTick = state.lastTickAt ? new Date(state.lastTickAt).toISOString() : 'never'
  const error = state.lastError ? ` error=${JSON.stringify(state.lastError)}` : ''
  const diagnostics = formatTickDiagnostics(state.lastTickSummary)
  if (lock && isPidAlive(lock.pid)) {
    console.log(`running pid=${lock.pid} lastTick=${lastTick} mode=${state.lastMode || 'unknown'} codexFiles=${files}${diagnostics}${error}`)
    return
  }
  console.log(`stopped lastTick=${lastTick} mode=${state.lastMode || 'unknown'} codexFiles=${files}${diagnostics}${error}`)
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

main().catch(error => {
  appendLog(`fatal: ${error && error.message ? error.message : String(error)}`)
  removeOwnLock()
  process.exit(1)
})
