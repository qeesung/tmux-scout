// Files the pane model owns, kept out of the session registry on purpose.
//
// Two things need to survive outside a tick: the shadow-mode agreement log and
// the answer cache. Both were originally written into session records, which
// meant touching the session schema and routing observations through the
// reducer. Neither belongs there:
//
//   * A shadow reading must change no behaviour at all. Any path through
//     applySessionEvent refreshes lastUpdated — the exact timestamp the
//     120s/180s idle sweeps measure — so "record without acting" could only be
//     achieved by adding a flag to the reducer. Its own file is neutral by
//     construction.
//   * The answer cache is keyed by screen content, not by session. Storing it
//     per session made status.json (already ~800KB) carry data the picker never
//     reads, and forced a schema field for it.
//
// Every function here swallows its own IO errors. None of this is load-bearing:
// a missing or corrupt file costs a cold cache or a gap in the report, never a
// failed tick.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { writeJsonAtomic } = require('./hook-adapter')

const STORE_DIR = path.join(os.homedir(), '.tmux-scout')
const SHADOW_FILE = path.join(STORE_DIR, 'pane-agreement.jsonl')
const CACHE_FILE = path.join(STORE_DIR, 'pane-cache.json')
const OBSERVED_FILE = path.join(STORE_DIR, 'pane-observed.json')

// Trimmed when it grows past this. The agreement report reads a window measured
// in days, so a few thousand rows is far more than it needs.
const MAX_SHADOW_BYTES = 2 * 1024 * 1024
// A shadow row is written when the comparison changes, and at least this often
// while it does not. Rows written only on change measure transitions: a state
// that flapped ten times in a minute outweighed one that held for an hour, and
// the agreement percentage people decide on came out systematically wrong. With
// a heartbeat each row stands for a bounded span of time, and the report can
// weight it by that span.
const SHADOW_HEARTBEAT_MS = 60 * 1000
const MAX_CACHE_ENTRIES = 256

// Append-only logs shared by the shadow report and the per-call metrics. Past
// the size cap the oldest half is dropped rather than rotated: these rows feed
// reports, and the newest ones are the only ones anyone asks about.
function appendJsonl(file, row, maxBytes = MAX_SHADOW_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
    if (fs.statSync(file).size <= maxBytes) return
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`)
  } catch (_) {}
}

function readJsonl(file, sinceMs = 0) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (_) {
    return []
  }
  const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (row && Number(row.at) >= cutoff) rows.push(row)
    } catch (_) {}
  }
  return rows
}

function appendShadow(row, file = SHADOW_FILE) {
  appendJsonl(file, row)
}

function readShadow({ sinceMs = 0, file = SHADOW_FILE } = {}) {
  return readJsonl(file, sinceMs)
}

// { cacheKey: { answers, usage, model, at } }
function readCache(file = CACHE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function writeCache(entries, file = CACHE_FILE) {
  const keys = Object.keys(entries)
  const kept = keys.length > MAX_CACHE_ENTRIES
    ? keys.sort((a, b) => (entries[b].at || 0) - (entries[a].at || 0)).slice(0, MAX_CACHE_ENTRIES)
    : keys
  const out = {}
  for (const key of kept) out[key] = entries[key]
  return writeQuietly(file, out)
}

// hook-adapter's writer, which also removes its temp file when the rename
// fails. Nothing here is load-bearing, so a failed write is reported, not thrown.
function writeQuietly(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeJsonAtomic(file, data)
    return true
  } catch (_) {
    return false
  }
}

// { sessionId: capturedAtMs }
function readObserved(file = OBSERVED_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function writeObserved(entries, file = OBSERVED_FILE) {
  return writeQuietly(file, entries)
}

module.exports = {
  SHADOW_HEARTBEAT_MS,
  appendJsonl,
  readJsonl,
  CACHE_FILE,
  OBSERVED_FILE,
  SHADOW_FILE,
  appendShadow,
  readCache,
  readObserved,
  readShadow,
  writeCache,
  writeObserved
}
