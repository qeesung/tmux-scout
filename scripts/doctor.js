#!/usr/bin/env node
// tmux-scout environment health check.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { HOOK_MANAGERS, checkManagerHealth } = require('./setup/managers')

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
  return ['1', 'on', 'true', 'yes', 'enabled'].includes(String(value || '').trim().toLowerCase())
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

  let anyInstalled = false

  for (const manager of HOOK_MANAGERS) {
    const report = checkManagerHealth(manager)
    const label = `${report.label} hooks`
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

  if (!anyInstalled) {
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

  if (enabled) ok('tmux option @scout-watchdog', String(option))
  else warn('tmux option @scout-watchdog', 'off; background reconciliation is disabled')

  if (running) {
    const state = readJson(path.join(STATUS_DIR, 'watcher-state.json'), {})
    const lastTick = state.lastTickAt ? new Date(state.lastTickAt).toISOString() : 'unknown'
    const summary = state.lastTickSummary || {}
    const bridge = bridgeSocketState()
    const details = [`running pid=${pid}`, `lastTick=${lastTick}`]
    if (Number.isFinite(summary.durationMs)) details.push(`duration=${summary.durationMs}ms`)
    if (Number.isFinite(summary.changes)) details.push(`changes=${summary.changes}`)
    if (Number.isFinite(summary.codexFilesRead)) details.push(`codexRead=${summary.codexFilesRead}`)
    if (summary.codexParseErrors > 0) details.push(`codexParseErrors=${summary.codexParseErrors}`)
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

function main() {
  console.log()
  console.log(c.bold('tmux-scout doctor'))
  console.log(c.dim(`project: ${PROJECT_DIR}`))

  checkDependencies()
  checkPluginState()
  checkStorage()
  checkHooks()
  checkWatcher()

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
