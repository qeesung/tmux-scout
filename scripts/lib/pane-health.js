// Whether screen reading can currently be trusted, in a form the status bar
// and the picker can show.
//
// In jev mode the pane model is the only thing moving claude/codex/gemini
// sessions. When it stops getting answers — TypeSafe refusing a network with a
// 451, a rejected key, no connection, a watcher that is not running — every
// session silently keeps whatever state it last had, and nothing on screen
// says so. That went unnoticed for a day of 451s. The watcher writes this file
// when the verdict changes; the status bar reads it every few seconds and the
// picker on every refresh, so it is small and written rarely.
//
// Shadow and off are never reported: in those modes hooks drive state, and a
// failing pane model changes nothing anyone sees.

const fs = require('fs')
const os = require('os')
const path = require('path')

const HEALTH_FILE_NAME = 'pane-health.json'

function defaultDir() {
  return path.join(os.homedir(), '.tmux-scout')
}

// Short codes for the status bar, sentences for the picker. Keyed by the
// client's errorKind or unavailable reason, and by the two watcher states the
// readers add themselves.
const PROBLEMS = Object.freeze({
  region: { code: '451', text: 'the API refuses this network (451: not available in your region)' },
  auth: { code: '401', text: 'the API key was rejected (401)' },
  'rate-limited': { code: '429', text: 'the API is rate limiting requests (429)' },
  offline: { code: 'offline', text: 'the API cannot be reached' },
  timeout: { code: 'timeout', text: 'requests to the API are timing out' },
  'no-key': { code: 'no key', text: 'there is no API key' },
  'no-sdk': { code: 'no sdk', text: '@typesafe-ai/sdk is not installed' },
  'node-too-old': { code: 'node', text: 'Node is too old for the TypeSafe SDK' },
  down: { code: 'down', text: 'the watcher is not running' },
  stopped: { code: 'stopped', text: 'the watcher was stopped' }
})

function describe(health) {
  if (!health || health.ok) return null
  const known = PROBLEMS[health.kind]
  const status = Number.isFinite(health.status) ? health.status : null
  const problem = known || (health.kind === 'http' && status
    ? { code: String(status), text: `the API answers ${status}` }
    : { code: 'error', text: `requests to the API fail (${health.kind || 'unknown'})` })
  return Object.assign({ since: Number.isFinite(health.since) ? health.since : null }, problem)
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (_) {
    return null
  }
}

// What the watcher last reported, written only when it changed.
function writePaneHealth(health, dir = defaultDir()) {
  const file = path.join(dir, HEALTH_FILE_NAME)
  const tmp = `${file}.tmp.${process.pid}`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(health))
    fs.renameSync(tmp, file)
    return true
  } catch (_) {
    try { fs.unlinkSync(tmp) } catch (__) {}
    return false
  }
}

// The problem to show, or null when there is none. A report from a watcher
// that is no longer running describes nothing: in jev mode the problem is then
// the watcher itself, since nothing else is reading the screens.
function readPaneHealth(options = {}) {
  const dir = options.dir || defaultDir()
  const alive = typeof options.isAlive === 'function' ? options.isAlive : isPidAlive
  const health = readJson(path.join(dir, HEALTH_FILE_NAME))
  if (!health || health.mode !== 'on') return null
  const lock = readJson(path.join(dir, 'watcher.pid'))
  const pid = lock && Number.parseInt(lock.pid, 10)
  if (!pid || !alive(pid)) {
    // No since: the report was written when its verdict last changed, which
    // says nothing about when the watcher went away.
    const kind = fs.existsSync(path.join(dir, 'watcher.stopped')) ? 'stopped' : 'down'
    return describe({ ok: false, kind })
  }
  return describe(health)
}

function clock(at) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// One line for the picker's header.
function healthSentence(problem) {
  if (!problem) return ''
  const since = problem.since ? ` since ${clock(problem.since)}` : ''
  return `jev: ${problem.text}${since}; session states read from the screen may be stale`
}

module.exports = {
  HEALTH_FILE_NAME,
  describe,
  healthSentence,
  readPaneHealth,
  writePaneHealth
}
