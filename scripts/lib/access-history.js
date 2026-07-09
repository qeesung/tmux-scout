#!/usr/bin/env node
// Access-order (MRU) history for the picker.
//
// Records the tmux pane the user jumped to via the picker, most-recent-first.
// The picker orders sessions by their most-recent-visit timestamp (falling back
// to activity time for panes never visited), so the ones you touched most
// recently — and freshly active sessions you've never visited — float to the top.

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_MAX_ENTRIES = 200

function historyFile() {
  return path.join(os.homedir(), '.tmux-scout', 'access-history.json')
}

function readHistory(file = historyFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (data && Array.isArray(data.entries)) return data
  } catch (_) {}
  return { version: 1, entries: [] }
}

function writeAtomic(file, data) {
  const tempPath = file + '.tmp.' + process.pid
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
    fs.renameSync(tempPath, file)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

// Prepend paneId as the most-recent access, drop any prior copy, and cap length.
function recordAccess(paneId, options = {}) {
  if (!paneId) return
  const file = options.file || historyFile()
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : DEFAULT_MAX_ENTRIES

  const data = readHistory(file)
  const entries = (data.entries || []).filter(entry => entry && entry.pane !== paneId)
  entries.unshift({ pane: paneId, ts: now })

  writeAtomic(file, { version: 1, entries: entries.slice(0, max) })
}

// Build a paneId -> last-visit-timestamp map. Dedup keeps the first occurrence,
// which is the most recent visit since entries are stored newest-first.
function readAccessTimes(options = {}) {
  const file = options.file || historyFile()
  const data = readHistory(file)
  const times = new Map()
  for (const entry of data.entries || []) {
    if (entry && entry.pane && !times.has(entry.pane)) {
      times.set(entry.pane, Number.isFinite(entry.ts) ? entry.ts : 0)
    }
  }
  return times
}

module.exports = { recordAccess, readAccessTimes, readHistory, historyFile, DEFAULT_MAX_ENTRIES }

if (require.main === module) {
  const [command, arg] = process.argv.slice(2)
  // Only accept tmux pane ids (%N); guards against a literal, unexpanded
  // "#{pane_id}" or other junk reaching the history from the focus hook.
  if (command === 'record' && arg && /^%\d+$/.test(arg)) {
    try { recordAccess(arg) } catch (_) {}
  }
}
