#!/usr/bin/env node
// Access-order (MRU) history for the picker.
//
// Records the tmux pane the user jumped to via the picker, most-recent-first.
// The picker sorts sessions by their pane's position in this list, so the
// session you visited most recently floats to the top.

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

// Build a paneId -> rank map (0 = most recently accessed). Dedup keeps first occurrence.
function readAccessRanks(options = {}) {
  const file = options.file || historyFile()
  const data = readHistory(file)
  const ranks = new Map()
  for (const entry of data.entries || []) {
    if (entry && entry.pane && !ranks.has(entry.pane)) {
      ranks.set(entry.pane, ranks.size)
    }
  }
  return ranks
}

module.exports = { recordAccess, readAccessRanks, readHistory, historyFile, DEFAULT_MAX_ENTRIES }

if (require.main === module) {
  const [command, arg] = process.argv.slice(2)
  if (command === 'record' && arg) {
    try { recordAccess(arg) } catch (_) {}
  }
}
