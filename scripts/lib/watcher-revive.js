// Starts the watcher again when it has died.
//
// Nothing else does. tmux starts the watcher when it loads the plugin, and one
// that exits — a crash, an OOM kill — stays gone until the config is next
// loaded. With hooks that only slowed corrections down. In jev mode, where the
// watcher is the only thing reading the screens, every session froze where it
// was, with nothing to say so: one crash left a wall of agents showing their
// state from eighteen hours before.
//
// The status bar widget runs every few seconds and the picker whenever it
// opens, so both call this. While the watcher is alive it costs a small file
// read and a signal-0 kill; the tmux option and the spawn only happen once it
// is gone.
//
// Not revived:
//   * until it has been gone for a grace period — tmux loading the plugin
//     starts a watcher too, the status bar is drawn in the same moment, and
//     the watcher's lock is not taken atomically, so racing it could leave two
//   * a watcher stopped on purpose — `watcher stop` leaves a marker, and any
//     watcher that starts clears it
//   * with @scout-watchdog off
//   * when tmux cannot be asked, which is how tests and scripts run outside a
//     server look, and where no watcher would run anyway
//   * more than once a minute, so one that dies on start is not respawned on
//     every status bar refresh

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const REVIVE_GRACE_MS = 10000
const REVIVE_INTERVAL_MS = 60000

function pathsFor(dir) {
  return {
    pid: path.join(dir, 'watcher.pid'),
    stopped: path.join(dir, 'watcher.stopped'),
    missing: path.join(dir, 'watcher-missing.since'),
    claim: path.join(dir, 'watcher-revive.claim'),
    log: path.join(dir, 'watcher.log')
  }
}

function defaultDir() {
  return path.join(os.homedir(), '.tmux-scout')
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

function lockedPid(file) {
  try {
    const pid = Number.parseInt(JSON.parse(fs.readFileSync(file, 'utf-8')).pid, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch (_) {
    return null
  }
}

function markStopped(dir = defaultDir()) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(pathsFor(dir).stopped, `${Date.now()}\n`)
  } catch (_) {}
}

function clearStopped(dir = defaultDir()) {
  try { fs.unlinkSync(pathsFor(dir).stopped) } catch (_) {}
}

// At most one reviver per interval, across processes: the status bar of every
// attached client and the picker can all find the watcher gone at once. The
// file is created exclusively, so of several racing for an expired claim only
// one gets it.
function claim(file, now, intervalMs) {
  try {
    const at = Number.parseInt(fs.readFileSync(file, 'utf-8'), 10)
    if (Number.isFinite(at) && now - at < intervalMs && now >= at) return false
    fs.unlinkSync(file)
  } catch (_) {}
  try {
    fs.writeFileSync(file, `${now}\n`, { flag: 'wx' })
    return true
  } catch (_) {
    return false
  }
}

// When the watcher was first found gone, recorded by whoever found it.
function missingSince(file, now) {
  try {
    const at = Number.parseInt(fs.readFileSync(file, 'utf-8'), 10)
    if (Number.isFinite(at) && at <= now) return at
  } catch (_) {}
  try { fs.writeFileSync(file, `${now}\n`) } catch (_) {}
  return now
}

function forget(file) {
  try { fs.unlinkSync(file) } catch (_) {}
}

function watchdogDisabled(value) {
  return /^(off|0|false|no|disabled)$/i.test(String(value || '').trim())
}

function defaultReadOption(name) {
  const { readTmuxOptionStrict } = require('./state-source')
  return readTmuxOptionStrict(name)
}

function defaultStart(watcherScript) {
  const child = spawn(process.execPath, [watcherScript, 'start'], { detached: true, stdio: 'ignore' })
  child.unref()
}

// Returns why nothing was done, or 'revived'. Never throws: its callers draw
// the status bar and the picker, and neither may fail over this.
function reviveWatcher(options = {}) {
  try {
    const dir = options.dir || defaultDir()
    const files = pathsFor(dir)
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const alive = typeof options.isAlive === 'function' ? options.isAlive : isPidAlive
    const readOption = typeof options.readOption === 'function' ? options.readOption : defaultReadOption
    const start = typeof options.start === 'function' ? options.start : defaultStart

    const pid = lockedPid(files.pid)
    if (pid && alive(pid)) {
      if (fs.existsSync(files.missing)) forget(files.missing)
      return 'running'
    }
    if (fs.existsSync(files.stopped)) return 'stopped'
    // Asked before anything is written: outside a tmux server nothing here
    // should leave files behind.
    let watchdog
    try {
      watchdog = readOption('@scout-watchdog')
    } catch (_) {
      return 'no-tmux'
    }
    if (watchdogDisabled(watchdog)) return 'disabled'
    if (now - missingSince(files.missing, now) < REVIVE_GRACE_MS) return 'pending'
    if (!claim(files.claim, now, REVIVE_INTERVAL_MS)) return 'throttled'

    start(options.watcherScript || path.join(__dirname, '..', 'watcher.js'))
    forget(files.missing)
    try {
      fs.appendFileSync(files.log,
        `${new Date(now).toISOString()} revived by ${options.by || 'unknown'}: ${pid ? `pid=${pid} was gone` : 'no watcher was running'}\n`)
    } catch (_) {}
    return 'revived'
  } catch (_) {
    return 'error'
  }
}

module.exports = {
  REVIVE_GRACE_MS,
  REVIVE_INTERVAL_MS,
  clearStopped,
  markStopped,
  reviveWatcher
}
