#!/usr/bin/env node
// tmux-scout environment health check.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { HOOK_MANAGERS, checkManagerHealth } = require('./setup/managers')
const { STATE_SOURCES, STATE_SOURCE_OPTION, effectivePaneMode, screenReadAgents, stateSource } = require('./lib/state-source')

const PROJECT_DIR = path.resolve(__dirname, '..')
const STATUS_DIR = path.join(os.homedir(), '.tmux-scout')
const WATCHER_PID_FILE = path.join(STATUS_DIR, 'watcher.pid')
const BRIDGE_SOCKET = path.join(STATUS_DIR, 'run', 'bridge.sock')
const REQUIRED = {
  node: [16, 0, 0],
  tmux: [3, 2, 0],
  fzf: [0, 51, 0]
}

let failures = 0
let warnings = 0

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, Object.assign({
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  }, options))
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null
  }
}

function parseVersion(text) {
  const match = String(text || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return null
  return [
    Number.parseInt(match[1], 10) || 0,
    Number.parseInt(match[2] || '0', 10) || 0,
    Number.parseInt(match[3] || '0', 10) || 0
  ]
}

function compareVersion(left, right) {
  for (let i = 0; i < 3; i++) {
    if ((left[i] || 0) > (right[i] || 0)) return 1
    if ((left[i] || 0) < (right[i] || 0)) return -1
  }
  return 0
}

function versionString(version) {
  return version ? version.join('.') : 'unknown'
}

function section(title) {
  console.log()
  console.log(c.bold(title))
  console.log(c.dim('-'.repeat(title.length)))
}

function ok(label, detail) {
  console.log(`  ${c.green('[OK]')} ${label}${detail ? c.dim(` - ${detail}`) : ''}`)
}

function warn(label, detail) {
  warnings++
  console.log(`  ${c.yellow('[WARN]')} ${label}${detail ? c.dim(` - ${detail}`) : ''}`)
}

function fail(label, detail) {
  failures++
  console.log(`  ${c.red('[FAIL]')} ${label}${detail ? c.dim(` - ${detail}`) : ''}`)
}

function checkVersion(label, command, args, minimum) {
  const result = run(command, args)
  if (result.error && result.error.code === 'ENOENT') {
    fail(label, `${command} not found in PATH`)
    return null
  }
  if (result.status !== 0) {
    fail(label, (result.stderr || result.stdout || `${command} exited ${result.status}`).trim())
    return null
  }

  const output = (result.stdout || result.stderr || '').trim()
  const version = parseVersion(output)
  if (!version) {
    fail(label, `could not parse version from "${output}"`)
    return null
  }

  if (compareVersion(version, minimum) < 0) {
    fail(label, `found ${versionString(version)}, need >= ${versionString(minimum)}`)
  } else {
    ok(label, `${versionString(version)} (need >= ${versionString(minimum)})`)
  }
  return { version, output }
}

function tmuxOutput(args) {
  const result = run('tmux', args)
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function tmuxEnv(name) {
  const value = tmuxOutput(['show-environment', '-g', name])
  if (!value || !value.startsWith(`${name}=`)) return null
  return value.slice(name.length + 1)
}

function tmuxOption(name) {
  const value = tmuxOutput(['show-option', '-gqv', name])
  return value === null ? null : value
}

function optionEnabled(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['0', 'off', 'false', 'no', 'disabled'].includes(normalized)) return false
  if (['1', 'on', 'true', 'yes', 'enabled'].includes(normalized)) return true
  return true
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

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function bridgeSocketState() {
  try {
    const stat = fs.statSync(BRIDGE_SOCKET)
    return stat.isSocket() ? 'socket' : 'exists'
  } catch (_) {
    return 'missing'
  }
}

function checkDependencies() {
  section('Dependencies')

  const nodeVersion = parseVersion(process.version)
  if (nodeVersion && compareVersion(nodeVersion, REQUIRED.node) >= 0) {
    ok('Node.js', `${process.version.replace(/^v/, '')} (need >= ${versionString(REQUIRED.node)})`)
  } else {
    fail('Node.js', `found ${process.version}, need >= ${versionString(REQUIRED.node)}`)
  }

  checkVersion('tmux', 'tmux', ['-V'], REQUIRED.tmux)
  checkVersion('fzf', 'fzf', ['--version'], REQUIRED.fzf)

  const fzfHelp = run('fzf', ['--help'])
  if (fzfHelp.error && fzfHelp.error.code === 'ENOENT') return
  const helpText = `${fzfHelp.stdout}\n${fzfHelp.stderr}`
  if (helpText.includes('--listen') && helpText.includes('--tmux')) {
    ok('fzf feature flags', '--listen and --tmux are available')
  } else {
    fail('fzf feature flags', 'need --listen and --tmux support')
  }
}

function checkPluginState() {
  section('Plugin')

  const entry = path.join(PROJECT_DIR, 'tmux-scout.tmux')
  const picker = path.join(PROJECT_DIR, 'scripts', 'picker', 'picker.sh')
  if (fs.existsSync(entry)) ok('plugin entry', entry)
  else fail('plugin entry', `${entry} not found`)

  if (fs.existsSync(picker)) ok('picker script', picker)
  else fail('picker script', `${picker} not found`)

  const scoutDir = tmuxEnv('SCOUT_DIR')
  if (!scoutDir) {
    warn('tmux SCOUT_DIR', 'not set; load tmux-scout.tmux or reload tmux config')
  } else if (path.resolve(scoutDir) !== PROJECT_DIR) {
    warn('tmux SCOUT_DIR', `points to ${scoutDir}, expected ${PROJECT_DIR}`)
  } else {
    ok('tmux SCOUT_DIR', scoutDir)
  }

  const scoutPath = tmuxEnv('SCOUT_PATH')
  if (scoutPath) ok('tmux SCOUT_PATH', 'captured')
  else warn('tmux SCOUT_PATH', 'not set; Node from nvm/fnm may not be found by tmux')
}

function checkStorage() {
  section('Storage')

  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true })
    const testFile = path.join(STATUS_DIR, `.doctor-${process.pid}.tmp`)
    fs.writeFileSync(testFile, 'ok')
    fs.unlinkSync(testFile)
    ok('status directory writable', STATUS_DIR)
  } catch (error) {
    fail('status directory writable', error.message)
  }

  const statusFile = path.join(STATUS_DIR, 'status.json')
  if (!fs.existsSync(statusFile)) {
    warn('status.json', 'not found yet; it will be created after the first hook event')
    return
  }

  const status = readJson(statusFile, null)
  if (status && typeof status === 'object' && status.sessions && typeof status.sessions === 'object') {
    ok('status.json', `${Object.keys(status.sessions).length} session records`)
  } else {
    fail('status.json', 'file exists but is not valid tmux-scout status JSON')
  }
}

function checkHooks() {
  section('Hooks')

  // Per agent: in jev mode the agents the pane model reads should have no
  // hooks, and every other agent still needs its own.
  const fromScreen = screenReadAgents(tmuxOption)
  const leftover = []
  let anyInstalled = false

  for (const manager of HOOK_MANAGERS) {
    const report = checkManagerHealth(manager)
    const label = `${report.label} hooks`
    if (fromScreen.has(manager.id)) {
      if (report.installed || report.partial) {
        leftover.push(manager)
        // Both sources write phase. The pane model re-reads the screen every
        // few seconds, so a hook that fires late overwrites a correct reading
        // with a stale one — and the failure looks like the model being wrong.
        warn(label, `installed, but ${STATE_SOURCE_OPTION}=jev reads this agent from the pane`)
      } else {
        ok(label, 'not needed; read from the pane')
      }
      continue
    }
    if (report.installed) {
      ok(label, report.summary)
      anyInstalled = true
    } else if (report.partial) {
      warn(label, [report.summary, ...report.issues].filter(Boolean).join('; '))
      anyInstalled = true
    } else {
      warn(label, report.issues[0] || report.summary || 'not installed')
    }
  }

  if (leftover.length > 0) {
    warn('state source', `jev, but hooks are still installed for agents it reads; run scripts/setup.sh uninstall ${leftover.map(manager => manager.flag).join(' ')}`)
  } else if (fromScreen.size > 0) {
    ok('state source', `jev; ${[...fromScreen].join(', ')} read from the pane, any other agent through its hooks`)
  } else if (!anyInstalled) {
    warn('agent tracking', 'no hooks installed; run scripts/setup.sh install')
  }
}

function checkWatcher() {
  section('Watchdog')

  const option = tmuxOption('@scout-watchdog')
  const enabled = optionEnabled(option)
  const lock = readJson(WATCHER_PID_FILE, null)
  const pid = Number.parseInt(lock && lock.pid, 10)
  const running = isPidAlive(pid)

  if (enabled) ok('tmux option @scout-watchdog', option ? String(option) : 'default on')
  else warn('tmux option @scout-watchdog', 'off; background reconciliation is disabled')

  if (running) {
    const state = readJson(path.join(STATUS_DIR, 'watcher-state.json'), {})
    const lastTick = state.lastTickAt ? new Date(state.lastTickAt).toISOString() : 'unknown'
    const summary = state.lastTickSummary || {}
    const bridge = bridgeSocketState()
    const details = [`running pid=${pid}`, `lastTick=${lastTick}`]
    if (Number.isFinite(summary.durationMs)) details.push(`duration=${summary.durationMs}ms`)
    if (Number.isFinite(summary.changes)) details.push(`changes=${summary.changes}`)
    if (Number.isFinite(summary.codexTranscriptRead)) details.push(`codexRead=${summary.codexTranscriptRead}`)
    ok('watcher process', details.join(', '))
    if (bridge === 'socket') ok('bridge socket', BRIDGE_SOCKET)
    else warn('bridge socket', `watcher is running but bridge socket is ${bridge}`)
  } else if (enabled) {
    warn('watcher process', 'option is enabled but no live watcher pid was found')
  } else {
    warn('watcher process', 'not running')
  }

  const bridge = bridgeSocketState()
  if (!running && bridge !== 'missing') {
    warn('bridge socket', `stale ${bridge} at ${BRIDGE_SOCKET}`)
  }
}

// How serious a missing prerequisite is depends on who needs the classifier.
// In shadow mode nothing does — hooks still drive state — so a problem here is
// a warning that explains why the report stays empty. With
// `@scout-state-source jev` the classifier is the only thing that moves a
// session's phase, the hooks are gone, and the same problem is a failure.
function checkPaneModel() {
  // The same resolution the watcher uses, not just @scout-pane-model: with
  // `@scout-state-source jev` and no pane-model option the classifier runs, and
  // a doctor that returned here would report that phase comes from the screen
  // while the SDK, the Node version and the API key went unchecked — after the
  // hooks were already uninstalled.
  const mode = effectivePaneMode(tmuxOption)
  if (mode === 'off') return
  const problem = stateSource(tmuxOption) === STATE_SOURCES.JEV ? fail : warn

  section('Pane model')
  ok('mode', stateSource(tmuxOption) === STATE_SOURCES.JEV
    ? `${mode} (via ${STATE_SOURCE_OPTION}=jev)`
    : `${mode} (via @scout-pane-model)`)

  // Build the real client rather than re-deriving its preconditions: a doctor
  // that reports green while the watcher reports no-key is worse than no check.
  // Requiring jev-client is safe — it pulls in the SDK only inside the factory,
  // and the factory reports rather than throws.
  const { KEY_FILE, MIN_NODE_MAJOR, createJevClient, keyFileState, resolveApiKey } = require('./lib/jev-client')
  const client = createJevClient({ apiKey: resolveApiKey() })
  const REASONS = {
    'no-key': `no API key; \`tmux set-environment -g TYPESAFE_API_KEY ...\` or write ${KEY_FILE} (chmod 600)`,
    'no-sdk': `@typesafe-ai/sdk not installed; run \`npm install\` in ${PROJECT_DIR}`,
    'node-too-old': `Node v${process.versions.node}; the TypeSafe SDK needs v${MIN_NODE_MAJOR} or newer`
  }
  if (client.available) ok('client', `ready (${client.model})`)
  else problem('client', REASONS[client.reason] || client.reason)

  // Which tier supplied the key matters for diagnosis: the watcher is launched
  // by `tmux run-shell` and inherits the environment the tmux server started
  // with, not the user's shell — the same reason this plugin special-cases PATH.
  const fileState = keyFileState()
  if (fileState === 'bad-mode') {
    // Checked regardless of whether this shell happens to have the key: the
    // watcher does not inherit this shell's environment and will skip the file.
    problem('API key file', `${KEY_FILE} is readable by other accounts, so the watcher ignores it; chmod 600 it`)
  }
  if (client.available) {
    if (tmuxEnv('TYPESAFE_API_KEY')) ok('API key', 'from tmux global environment')
    else if (fileState === 'ok') ok('API key', KEY_FILE)
    else problem('API key', 'only in this shell\'s environment; the watcher will not see it')
  }

  const state = readJson(path.join(STATUS_DIR, 'watcher-state.json'), {})
  const stats = state.paneModel
  if (!stats) {
    warn('recent activity', 'no readings yet; the watcher may not have ticked since this was enabled')
    return
  }
  ok('recent activity', `${stats.calls} calls / ${stats.errors} errors since the watcher started`)

  const jev = stats.jev
  if (jev && jev.calls > 0) {
    ok('latency', `p50 ${jev.latency.p50Ms}ms / p95 ${jev.latency.p95Ms}ms / max ${jev.latency.maxMs}ms`)
    // Extrapolated from this watcher's uptime, which is the only rate available
    // before a month has passed and the one people actually want to see.
    ok('spend', jev.costUsdPerHour === null
      ? `$${jev.costUsd.toFixed(4)} so far; too little uptime to project a rate`
      : `$${jev.costUsd.toFixed(4)} so far, $${(jev.costUsdPerHour * 24 * 30).toFixed(2)}/month at this rate`)
    // 8s is the client timeout. Sitting near it means responses are landing two
    // or three ticks late, which shows up as state that lags the screen.
    if (jev.latency.p95Ms > 4000) {
      warn('latency', `p95 ${jev.latency.p95Ms}ms is close to the 8000ms timeout; readings will lag the screen`)
    }
  }
  // Readings served from cache out of readings served at all — throttled ticks
  // are neither. Agents streaming output legitimately pay for most readings, so
  // only a rate that stays very low over a long sample is worth a warning: that
  // is what normalization letting an animation through looks like.
  const hitRate = Number.isFinite(stats.hitRate) ? stats.hitRate : null
  if (hitRate === null || stats.calls + stats.cacheHits < 100) return
  if (hitRate >= 0.5) ok('cache hit rate', `${Math.round(hitRate * 100)}%`)
  else warn('cache hit rate', `${Math.round(hitRate * 100)}% over ${stats.calls + stats.cacheHits} readings; screens may not be normalizing`)
}

function main() {
  console.log()
  console.log(c.bold('tmux-scout doctor'))
  console.log(c.dim(`project: ${PROJECT_DIR}`))

  checkDependencies()
  checkPluginState()
  checkStorage()
  checkHooks()
  checkWatcher()
  checkPaneModel()

  console.log()
  if (failures > 0) {
    console.log(c.red(`Doctor found ${failures} failure(s) and ${warnings} warning(s).`))
    process.exit(1)
  }
  if (warnings > 0) {
    console.log(c.yellow(`Doctor passed with ${warnings} warning(s).`))
    return
  }
  console.log(c.green('Doctor passed.'))
}

main()
