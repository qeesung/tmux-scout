#!/usr/bin/env node
// Optional tmux-managed watcher for tmux-scout.
// It keeps hooks as the primary source, then performs fast lifecycle checks,
// bridge delivery, and narrow transcript interruption checks.

const fs = require('fs')
const path = require('path')
const os = require('os')
const sync = require('./picker/sync')
const { ClaudeTranscriptWatchManager } = require('./lib/claude-transcript-watcher')
const { startBridgeServer } = require('./lib/bridge-server')
const { createPaneObserver, normalizeMode, toAgentSet, DEFAULTS: PANE_DEFAULTS } = require('./lib/pane-observer')
const {
  effectivePaneMode,
  paneModelAgents,
  paneModelThresholds,
  readTmuxOption,
  readTmuxOptionStrict
} = require('./lib/state-source')

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

// The same reader state-source uses, so every option in this process is read
// one way.
const tmuxOption = readTmuxOption

function optionEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['0', 'off', 'false', 'no', 'disabled'].includes(normalized)) return false
  if (['1', 'on', 'true', 'yes', 'enabled'].includes(normalized)) return true
  return true
}

function watchdogEnabled() {
  return optionEnabled(tmuxOption('@scout-watchdog'))
}

function optionSeconds(name, fallbackMs, minMs, read = tmuxOption) {
  const raw = read(name)
  const seconds = Number.parseFloat(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.max(minMs, Math.round(seconds * 1000))
}

function optionNumber(name, fallback, read = tmuxOption) {
  const value = Number.parseFloat(read(name))
  return Number.isFinite(value) ? value : fallback
}

// `@scout-state-source = jev` turns the pane model on outright. Everything else
// falls through to `@scout-pane-model`, which is what keeps `shadow` — read the
// screen, record the verdict, change nothing — reachable while hooks stay in
// charge. That is the mode to run before flipping the switch.
function paneModelSettings(read = tmuxOption) {
  const mode = normalizeMode(effectivePaneMode(read))
  if (mode === 'off') return { mode }
  return {
    mode,
    intervalMs: optionSeconds('@scout-pane-model-interval', PANE_DEFAULTS.intervalMs, PANE_DEFAULTS.minIntervalMs, read),
    tailLines: Math.round(optionNumber('@scout-pane-model-lines', PANE_DEFAULTS.tailLines, read)),
    agents: toAgentSet(paneModelAgents(read)),
    // Strict opt-in, unlike optionEnabled() which treats an unset option as on.
    // A line per call is the only way to see the one slow response that mattered,
    // but most of the time the live aggregates in `watcher status` are enough and
    // an unasked-for append-per-call is not.
    logCalls: ['1', 'on', 'true', 'yes'].includes(String(read('@scout-jev-log-calls') || '').trim().toLowerCase()),
    thresholds: paneModelThresholds(read)
  }
}

// No logger: this runs every settings poll while a client is unavailable, and
// the key-file permission warning would otherwise repeat each time.
function probeClient() {
  const { createJevClient, resolveApiKey } = require('./lib/jev-client')
  return createJevClient({ apiKey: resolveApiKey(null) })
}

// An unavailable client (no key, no SDK, Node too old) is not an error: the
// observer simply never calls out, and every hook path and timeout fallback
// keeps working exactly as before.
//
// `carry` hands the answer cache and the cost metrics to a replacement built
// after a settings change, so reconfiguring does not re-buy every screen on the
// wall or reset the spend report. It may also carry a client already probed as
// ready, so recovery does not build a second one.
function startPaneObserver(settings = paneModelSettings(), carry = {}) {
  if (settings.mode === 'off') return null
  const { createJevClient, resolveApiKey } = require('./lib/jev-client')
  const client = carry.client ||
    createJevClient({ apiKey: resolveApiKey(null, appendLog), log: appendLog })
  if (!client.available) {
    appendLog(`pane model ${settings.mode} requested but unavailable (${client.reason})`)
  }
  const observer = createPaneObserver(Object.assign({ client, log: appendLog }, carry, settings))
  appendLog(`pane model ${settings.mode} client=${client.available ? client.model : client.reason}`)
  return observer
}

// The watcher is not restarted by a tmux config reload: `watcher.js start` sees
// the live pid and returns, so without this a process built at boot keeps its
// settings for its whole life. Switching a session's state source over would do
// nothing, and — the one that actually costs money — switching it OFF would
// keep sending pane contents to the API indefinitely.
//
// Every option is an `execFileSync` to tmux, so this is deliberately not done
// on every 2-second tick.
const SETTINGS_POLL_MS = 15000

function settingsSignature(settings) {
  return JSON.stringify(Object.assign({}, settings, {
    agents: settings.agents ? [...settings.agents].sort() : undefined
  }))
}

// One settings poll. Returns the pane state to carry forward — the same object
// when nothing needed doing. Two reasons to rebuild, and they are different:
//
//   * the settings changed — a fresh client, but the cache and the spend
//     report are handed over so a config edit neither re-buys every screen
//     nor zeroes the bill
//   * the settings did not change but the client is unavailable — enabling the
//     feature and then supplying the key (or running npm install) is the
//     documented order, and neither moves the signature. Probed quietly, and
//     rebuilt only once a client is actually ready, so a feature left waiting
//     on a key does not log every 15 seconds.
function refreshPaneObserver(current, next, deps = {}) {
  const start = deps.start || startPaneObserver
  const probe = deps.probe || probeClient
  const log = deps.log || appendLog
  const signature = settingsSignature(next)

  // The replacement is built before the old observer is closed: if building it
  // throws, the poll keeps the old one, and it must still be running — closed,
  // it reported ready while dispatching nothing.
  if (signature !== current.signature) {
    log(`pane model settings changed (${current.settings.mode} -> ${next.mode}); rebuilding`)
    const carry = current.observer ? current.observer.handoff() : {}
    const observer = start(next, carry)
    if (current.observer) current.observer.close()
    if (observer && !carry.cache) {
      try { observer.seed() } catch (_) {}
    }
    return { settings: next, signature, observer }
  }

  if (!current.observer) return current
  const stats = current.observer.stats()
  // Two ways a running observer can be stuck with a client that will not work:
  // it never had one, or the key it was built with is being refused. The
  // second is how a rotated key looks — `tmux set-environment` does not reach
  // a client already constructed, so every call stays a 401 until a new one is
  // built with the key a fresh lookup now finds.
  if (stats.available && !stats.authFailing) return current
  // A Node too old for the SDK stays too old; probing again only forks tmux.
  if (!stats.available && stats.reason === 'node-too-old') return current
  const client = probe()
  if (!client.available) return current
  if (stats.available && client.keyId === stats.keyId) return current
  log(stats.available
    ? 'pane model API key changed; rebuilding'
    : `pane model client became available (${client.model}); rebuilding`)
  const carry = Object.assign(current.observer.handoff(), { client })
  const observer = start(current.settings, carry)
  current.observer.close()
  return Object.assign({}, current, { observer })
}

// One settings poll, never fatal. It runs outside the tick's own try/catch, and
// a throw here — tmux gone mid-reload, a client constructor that rejects its
// options — would otherwise end the loop, and with it every liveness sweep. The
// pane model is optional; the watcher is not.
//
// Read strictly: a failed read is not an unset option. Read as one, a single
// tmux hiccup meant `off`, and the observer was torn down along with its spend
// report, its 429 cooldown and its token bucket. A failed poll keeps what runs.
function pollPaneSettings(pane, deps = {}) {
  const read = deps.read || readTmuxOptionStrict
  const log = deps.log || appendLog
  try {
    return refreshPaneObserver(pane, paneModelSettings(read), deps)
  } catch (error) {
    log(`pane model settings poll failed: ${error && error.message ? error.message : String(error)}`)
    return pane
  }
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
  if (!state.claudeTranscripts || typeof state.claudeTranscripts !== 'object' || Array.isArray(state.claudeTranscripts)) {
    state.claudeTranscripts = {}
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

// `watcher.js once` has no observer of its own, but the daemon's may well be
// watching these sessions. Without its observation times the one-shot tick's
// idle sweeps would force-complete a session the daemon is deliberately
// keeping BUSY. They are the daemon's persisted ones — at most a minute old,
// inside the 120s window they are checked against.
function persistedObservations() {
  if (effectivePaneMode(tmuxOption) !== 'on') return undefined
  const { readObserved } = require('./lib/pane-store')
  const observed = new Map()
  for (const [sessionId, at] of Object.entries(readObserved())) {
    if (Number.isFinite(at)) observed.set(sessionId, at)
  }
  return observed
}

function runTick(state, forceFull = false, transcriptWatchManager = null, observer = null, extra = {}) {
  const startedAt = Date.now()
  if (!state.codexTranscripts || typeof state.codexTranscripts !== 'object' || Array.isArray(state.codexTranscripts)) {
    state.codexTranscripts = {}
  }
  if (!state.claudeTranscripts || typeof state.claudeTranscripts !== 'object' || Array.isArray(state.claudeTranscripts)) {
    state.claudeTranscripts = {}
  }
  // Classifications finished since the last tick describe screens as they were
  // a moment ago, so they are applied before the sweeps that reason about them.
  // Both are plain values, so the tick stays entirely synchronous.
  const result = sync.run(STATUS_FILE, {
    codexTranscriptState: state.codexTranscripts,
    claudeTranscriptState: state.claudeTranscripts,
    paneEvents: observer ? observer.drain() : undefined,
    paneObservedAt: observer ? observer.observedAt() : extra.paneObservedAt
  })
  state.lastMode = forceFull ? 'reconcile:forced' : 'reconcile'

  if (observer && result && result.status) {
    // Starting requests is synchronous; the responses land during the sleep
    // between ticks and are picked up by the next drain.
    observer.dispatch(result.status, result.panes)
    observer.prune(result.status)
    observer.persist(Date.now())
    state.paneModel = Object.assign(observer.stats(), {
      // What the readings actually did this tick, from sync.run. Without these
      // `watcher status` showed the observer busy and the registry unchanged,
      // with no way to tell superseded readings from ones never sent.
      lastTickApplied: result.stats && result.stats.paneModel ? result.stats.paneModel.applied : 0,
      lastTickSuperseded: result.stats && result.stats.paneModel ? result.stats.paneModel.superseded : 0
    })
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
  const initialSettings = paneModelSettings()
  let pane = {
    settings: initialSettings,
    signature: settingsSignature(initialSettings),
    observer: startPaneObserver(initialSettings)
  }
  let settingsCheckedAt = Date.now()
  const shutdown = () => {
    bridge.close()
    transcriptWatchManager.close()
    if (pane.observer) pane.observer.close()
    removeOwnLock()
  }
  process.on('exit', shutdown)
  // Every way out is logged. The daemon runs under `tmux run-shell -b`, so its
  // stderr goes nowhere: a watcher that died from an uncaught error in some
  // callback, or was sent a signal, used to leave a clean exit and no trace —
  // and in jev mode, with no hooks, nothing else moves session state.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      appendLog(`stopped by ${signal} pid=${process.pid}`)
      shutdown()
      process.exit(0)
    })
  }
  const fatal = kind => error => {
    appendLog(`fatal: ${kind} ${error && error.stack ? error.stack : String(error)}`)
    shutdown()
    process.exit(1)
  }
  process.on('uncaughtException', fatal('uncaught exception'))
  process.on('unhandledRejection', fatal('unhandled rejection'))

  appendLog(`started pid=${process.pid}`)
  const state = loadState()
  // loadState() restores whatever the previous watcher persisted. With the
  // model off that is a report of a model that is not running — including a
  // spend figure that reads as if it were still billing. Decided here, by the
  // process that owns the observer, not in runTick: `watcher.js once` runs
  // ticks too, and would otherwise erase the daemon's live report.
  if (!pane.observer) delete state.paneModel

  // Answers survive a restart, so an unchanged screen is not re-bought.
  if (pane.observer) {
    try { pane.observer.seed() } catch (_) {}
  }

  while (true) {
    if (requireTmuxOption && !watchdogEnabled()) break

    const at = Date.now()
    if (at - settingsCheckedAt >= SETTINGS_POLL_MS) {
      settingsCheckedAt = at
      const before = pane.observer
      pane = pollPaneSettings(pane)
      if (pane.observer !== before) state.paneModel = pane.observer ? pane.observer.stats() : undefined
    }

    try {
      runTick(state, false, transcriptWatchManager, pane.observer)
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
  shutdown()
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
  } else {
    console.log(`stopped bridge=${bridge} lastTick=${lastTick} mode=${state.lastMode || 'unknown'}${diagnostics}${error}`)
  }
  const pane = formatPaneModelStats(state.paneModel)
  if (pane) console.log(pane)
  const jev = formatJevStats(state.paneModel)
  if (jev) console.log(jev)
}

// The cache hit rate is the number worth watching: a steady state where most
// sessions sit idle should be well above 90%, and anything lower means
// normalization is missing something that changes every frame — which burns
// money in direct proportion.
function formatPaneModelStats(stats) {
  if (!stats || !stats.mode || stats.mode === 'off') return ''
  const hitRate = Number.isFinite(stats.hitRate) ? `${Math.round(stats.hitRate * 100)}%` : 'n/a'
  const health = stats.available ? 'ready' : `unavailable(${stats.reason})`
  return `pane-model ${stats.mode} ${health} calls=${stats.calls} cacheHits=${stats.cacheHits} hitRate=${hitRate} ` +
    `emitted=${stats.emitted} applied=${stats.lastTickApplied || 0} superseded=${stats.lastTickSuperseded || 0} ` +
    `stale=${stats.stale || 0} errors=${stats.errors} throttled=${stats.throttled} queued=${stats.queued}`
}

// Split from the line above rather than appended to it: that one is about
// whether the observer is keeping up, this one is about what it costs. They get
// read at different times and neither should push the other off the terminal.
function formatJevStats(stats) {
  const jev = stats && stats.jev
  if (!jev || jev.calls === 0) return ''
  const latency = jev.latency || {}
  const errors = Object.entries(jev.errorsByKind || {})
    .map(([kind, count]) => `${kind}=${count}`).join(',')
  return `jev calls=${jev.calls} ok=${jev.ok} failed=${jev.failed}${errors ? ` [${errors}]` : ''} ` +
    `p50=${latency.p50Ms}ms p95=${latency.p95Ms}ms max=${latency.maxMs}ms ` +
    `tokens=${jev.inputTokens} cost=$${jev.costUsd.toFixed(4)}` +
    `${jev.costUsdPerHour === null ? '' : ` ($${jev.costUsdPerHour.toFixed(3)}/h)`} ` +
    `paidShare=${Math.round(jev.paidShare * 100)}%`
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
    runTick(state, process.argv.includes('--full'), null, null, { paneObservedAt: persistedObservations() })
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
  pollPaneSettings,
  refreshPaneObserver,
  runLoop,
  runTick,
  startOptionalBridge,
  formatPaneModelStats,
  paneModelSettings,
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
