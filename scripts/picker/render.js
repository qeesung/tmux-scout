#!/usr/bin/env node
// Pure view layer: read status.json and output formatted lines for fzf picker.
// All data mutation (crash detection, Codex sync) happens in sync.js.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { isHiddenCodexSession } = require('../lib/codex-session-classifier')
const { agentDisplay } = require('../lib/agents')
const { AGENT_EVENTS } = require('../lib/agent-events')
const { isVisibleInPicker } = require('../lib/session-contract')
const { lastTouchedAt } = require('../lib/session-registry')
const { readAccessTimes } = require('../lib/access-history')
const { healthSentence, readPaneHealth } = require('../lib/pane-health')
const { readTmuxOption } = require('../lib/state-source')

let statusFile = process.argv[2] || ''
let currentPane = process.argv[3] || ''

const pidStateCache = new Map()
const COLUMNS_OPTION = '@scout-picker-columns'
const DEFAULT_COLUMNS = 'status,agent,session,window,project,detail'
const MAX_COLUMN_WIDTH = 200
// The least a column other than the last is shrunk to; the last can go to
// nothing, since nothing after it needs lining up.
const MIN_COLUMN_WIDTH = 4
// Which columns give up width first when a row is wider than the list. The
// window name, which is what tells two rows apart, goes last, the session
// before it; status and agent are short enough never to.
const SHRINK_ORDER = Object.freeze(['detail', 'source', 'title', 'project', 'session', 'window'])

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function getPaneSnapshot() {
  const panes = new Map()
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t#{window_index}\t#{window_name}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    if (!output) return panes

    for (const line of output.split('\n')) {
      const [paneId, panePid, currentCommand, paneDead, sessionName, windowIndex, windowName] = line.split('\t')
      if (paneId) {
        panes.set(paneId.trim(), {
          paneId: paneId.trim(),
          panePid: Number.parseInt(panePid, 10) || null,
          currentCommand: currentCommand || '',
          paneDead: paneDead === '1',
          sessionName: sessionName || '',
          windowIndex: Number.parseInt(windowIndex, 10) || 0,
          windowName: windowName || ''
        })
      }
    }
  } catch (_) {}
  return panes
}

function hasTrackedPid(session) {
  return Number.isInteger(session.pid) && session.pid > 0
}

function getPidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  if (pidStateCache.has(pid)) return pidStateCache.get(pid)

  let state = 'unknown'
  try {
    process.kill(pid, 0)
    state = 'alive'
  } catch (error) {
    if (error && error.code === 'ESRCH') state = 'dead'
    else if (error && error.code === 'EPERM') state = 'alive'
  }

  pidStateCache.set(pid, state)
  return state
}

function isShellCommand(command) {
  return new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu']).has(command)
}

function phaseForSession(session) {
  if (!session) return 'idle'
  if (session.phase) return session.phase
  if (session.status === 'crashed') return 'crashed'
  if (session.status === 'stale') return 'stale'
  if (session.status === 'interrupted') return 'interrupted'
  if (session.needsAttention === 'waiting for answer') return 'waitingForAnswer'
  if (session.needsAttention) return 'waitingForApproval'
  if (session.status === 'working') return 'running'
  if (session.status === 'completed') return 'completed'
  return 'idle'
}

function isWaitingPhase(phase) {
  return phase === 'waitingForApproval' || phase === 'waitingForAnswer'
}

function canUseShellFallback(session) {
  if (session.agentType === 'codex') return true
  const lastEventType = session && session.lastEvent ? session.lastEvent.type : null
  return session.status === 'working' || lastEventType === AGENT_EVENTS.PROMPT_SUBMIT || lastEventType === AGENT_EVENTS.TOOL_USE || Boolean(session.pendingToolUse)
}

function isNeedsAttention(session, now) {
  return Boolean(session && isWaitingPhase(phaseForSession(session)))
}

// Access-order (MRU) on a unified recency timeline: a session's sort key is the
// timestamp of its most recent picker jump. Sessions never jumped-to fall back to
// their activity time (lastTouchedAt), so a freshly-created or newly-active
// session floats to the top instead of sinking below stale prior visits.
function orderTime(session, times) {
  const visited = times && session && session.tmuxPane ? times.get(session.tmuxPane) : undefined
  return Number.isFinite(visited) ? visited : lastTouchedAt(session)
}

function compareSessions(left, right, ctx = {}) {
  const times = ctx.accessTimes
  const leftTime = orderTime(left, times)
  const rightTime = orderTime(right, times)
  if (leftTime !== rightTime) return rightTime - leftTime // newest interaction first
  // Stable, deterministic tiebreak when interaction times coincide.
  return String(left.sessionId || '').localeCompare(String(right.sessionId || ''))
}

function isTerminalSession(session) {
  const phase = phaseForSession(session)
  return session && (phase === 'crashed' || phase === 'stale' || phase === 'interrupted')
}

function isActiveSession(session, panes, now = Date.now()) {
  if (!session) return false
  // tmux-scout's management boundary is the tmux server. Canonical lifecycle state
  // remains authoritative after a session is bound, but Codex App/IDE/plain
  // terminal sessions without a real tmux pane are outside this picker.
  if (!session.tmuxPane) return false
  if (isHiddenCodexSession(session)) return false

  // Phase/lifecycle visibility lives in the contract module (pure + testable).
  // 'pane' means the verdict depends on runtime pane/PID liveness, resolved here.
  const verdict = isVisibleInPicker(session, { now })
  if (verdict === 'hidden') return false
  if (verdict === 'visible') return true

  const pane = panes.get(session.tmuxPane)
  if (!pane || pane.paneDead) {
    return false
  }
  if (!hasTrackedPid(session)) {
    if (canUseShellFallback(session) && isShellCommand(pane.currentCommand || '')) {
      return false
    }
    return true
  }
  return getPidState(session.pid) !== 'dead'
}

function getActiveSessions(status, panes) {
  const byPane = new Map()
  const now = Date.now()

  function paneActivityRank(session) {
    const phase = phaseForSession(session)
    if (session && session.isRalphLoopIteration) return 0
    if (isNeedsAttention(session, now)) return 0
    if (phase === 'running') return 1
    if (phase === 'completed' || phase === 'idle') return 2
    if (phase === 'interrupted') return 3
    if (phase === 'crashed' || phase === 'stale') return 4
    return 5
  }

  function foregroundTimestamp(session) {
    if (Number.isFinite(session.lastHookAt) && session.lastHookAt > 0) return session.lastHookAt
    if (session.lastEvent && session.lastEvent.type !== AGENT_EVENTS.PANE_STATE
      && Number.isFinite(session.lastUpdated) && session.lastUpdated > 0) {
      return session.lastUpdated
    }
    return session.startedAt || session.lastUpdated || 0
  }

  function shouldReplacePaneSession(existing, candidate) {
    if (!existing) return true
    const rankDelta = paneActivityRank(candidate) - paneActivityRank(existing)
    if (rankDelta !== 0) return rankDelta < 0
    return foregroundTimestamp(candidate) > foregroundTimestamp(existing)
  }

  for (const session of Object.values(status.sessions || {})) {
    if (!isActiveSession(session, panes, now)) continue
    const existing = byPane.get(session.tmuxPane)
    if (shouldReplacePaneSession(existing, session)) {
      byPane.set(session.tmuxPane, session)
    }
  }
  return Array.from(byPane.values())
}

function cleanText(value, fallback) {
  const text = String(value || fallback || '?').replace(/[\r\n\t]+/g, ' ').trim()
  return text || fallback || '?'
}

function cleanOptionalText(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim()
}

// Terminal columns a character takes. Wide East Asian characters and most
// emoji take two: counted as one, a Chinese window name or session name pushed
// every column after it out of line.
function charWidth(codePoint) {
  if (codePoint < 0x1100) return 1
  if ((codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)) return 2
  return 1
}

function displayWidth(text) {
  let width = 0
  for (const char of String(text)) width += charWidth(char.codePointAt(0))
  return width
}

function truncateText(value, width) {
  if (width <= 0) return ''
  const text = cleanText(value, '')
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const next = charWidth(char.codePointAt(0))
    if (used + next > width - 1) break
    out += char
    used += next
  }
  return out + '~'
}

// A cell's text cut to its column, colored, and padded out to it unless it is
// the last column: nothing follows that one to line up with.
function formatCell(cell, width, last) {
  const text = cell && cell.text ? truncateText(cell.text, width) : ''
  const padding = last ? '' : ' '.repeat(Math.max(0, width - displayWidth(text)))
  return text && cell.color ? `\x1b[${cell.color}m${text}\x1b[0m${padding}` : `${text}${padding}`
}

function waitCode(session) {
  const pending = session && typeof session === 'object' ? session.pendingInteraction : null
  if (pending && pending.type === 'question') return 'ANS'
  if (pending && pending.type === 'plan') return 'PLAN'
  if (pending && pending.type === 'approval') return 'APP'
  const text = String(
    (pending && (pending.reason || pending.details)) ||
    (session && session.needsAttention) ||
    session ||
    ''
  ).toLowerCase()
  if (text.includes('answer') || text.includes('input') || text.includes('question')) return 'ANS'
  if (text.includes('plan')) return 'PLAN'
  if (text.includes('approval') || text.includes('permission') || text.includes('allow')) return 'APP'
  return 'WAIT'
}

function statusCell(session, now) {
  const phase = phaseForSession(session)
  if (isNeedsAttention(session, now)) return { text: `W:${waitCode(session)}`, color: '31' }
  if (session && session.isRalphLoopIteration) return { text: 'LOOP', color: '35' }
  if (phase === 'running') return { text: 'BUSY', color: '33' }
  if (phase === 'interrupted') return { text: 'INT', color: '35' }
  if (phase === 'crashed') return { text: 'CRASH', color: '31' }
  if (phase === 'stale') return { text: 'STALE', color: '90' }
  if (phase === 'completed') return { text: 'DONE', color: '32' }
  return { text: 'IDLE', color: '34' }
}

function attentionDetail(session) {
  if (!session.needsAttention) return ''
  const pending = session.pendingInteraction || {}
  const reason = cleanText(pending.reason || session.needsAttention, 'waiting')
  const pendingDetails = cleanOptionalText(pending.details)
  const pendingTool = cleanOptionalText(pending.tool)
  let tool = ''
  if (pendingDetails && pendingDetails.toLowerCase() !== reason.toLowerCase()) {
    tool = pendingDetails
  } else if (pendingTool && pendingTool.toLowerCase() !== reason.toLowerCase()) {
    tool = pendingTool
  } else if (!pendingDetails && !pendingTool && session.pendingToolUse && session.pendingToolUse.details) {
    const toolDetails = cleanOptionalText(session.pendingToolUse.details)
    if (toolDetails.toLowerCase() !== reason.toLowerCase()) tool = toolDetails
  }
  const source = pending.source && pending.source !== 'unknown'
    ? ` · ${pending.source}`
    : ''
  const deferred = session.deferredCompletion ? ' · turn ended' : ''
  return tool ? `${reason}: ${cleanText(tool, '')}${source}${deferred}` : `${reason}${source}${deferred}`
}

function subagentDetail(session) {
  const subagents = Array.isArray(session.activeSubagents)
    ? session.activeSubagents.filter(Boolean)
    : []
  if (subagents.length === 0) return ''

  const latest = subagents.slice().sort((left, right) => {
    return (right.updatedAt || 0) - (left.updatedAt || 0)
  })[0]
  const count = `${subagents.length} subagent${subagents.length === 1 ? '' : 's'}`
  const label = cleanText(latest.nickname || latest.agentType || latest.title, 'subagent')
  const activity = cleanText(latest.lastToolActivity || latest.title || latest.phase, '')
  return activity ? `${count} · ${label}: ${activity}` : `${count} · ${label}`
}

function ralphLoopDetail(session) {
  if (!session || !session.isRalphLoopIteration) return ''
  const loop = session.ralphLoop && typeof session.ralphLoop === 'object' ? session.ralphLoop : {}
  const iteration = Number.isFinite(loop.iteration) ? loop.iteration : undefined
  const maxIterations = Number.isFinite(loop.maxIterations) ? loop.maxIterations : undefined
  if (iteration !== undefined && maxIterations !== undefined && maxIterations > 0) {
    return `Ralph loop ${iteration}/${maxIterations}`
  }
  if (iteration !== undefined) return `Ralph loop iteration ${iteration}`
  return 'Ralph loop iteration'
}

function latestEvidence(session) {
  const entries = Array.isArray(session.stateEvidence)
    ? session.stateEvidence.filter(Boolean)
    : []
  return entries[0] || null
}

function shortAge(now, timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function evidenceDetail(session, now) {
  const evidence = latestEvidence(session)
  if (!evidence) return ''
  if (evidence.type === AGENT_EVENTS.SUBAGENT_START
    || evidence.type === AGENT_EVENTS.SUBAGENT_STOP
    || evidence.type === AGENT_EVENTS.SUBAGENT_TOOL_ACTIVITY) {
    return ''
  }
  const source = cleanText(evidence.source, 'unknown')
  const raw = cleanText(evidence.rawEventName || evidence.type, '')
  const age = shortAge(now, evidence.timestamp)
  const suffix = evidence.applied === false && evidence.blockedReason ? ' blocked' : ''
  const pieces = [source]
  if (age) pieces.push(age)
  if (raw) pieces.push(raw)
  return `${pieces.join(' · ')}${suffix}`
}

// The most pressing thing to know about a session beyond its status. Where its
// state came from is the source column's, not this one's.
function detailCell(session, now) {
  const terminalReason = session.terminalReason || session.crashReason || session.staleReason || session.stateReason
  if (isTerminalSession(session) && terminalReason) return { text: terminalReason, color: '2' }
  const ralph = ralphLoopDetail(session)
  if (ralph) return { text: ralph, color: '35' }
  if (isNeedsAttention(session, now)) return { text: attentionDetail(session), color: '31' }
  if (!session.tmuxPane) return { text: '(pane not yet linked — waiting for first response)', color: '2' }
  const subagents = subagentDetail(session)
  if (subagents) return { text: subagents, color: '35' }
  if (phaseForSession(session) === 'running' && session.activeTool && session.pendingToolUse && session.pendingToolUse.details) {
    return { text: session.pendingToolUse.details, color: '36' }
  }
  return null
}

// The columns @scout-picker-columns can name: the header, the most a column
// takes unless the option gives it a width, and what a session shows there. A
// cell is { text, color }, or null for an empty one.
const COLUMNS = Object.freeze({
  status: { header: 'STATUS', width: 6, cell: (session, ctx) => statusCell(session, ctx.now) },
  agent: {
    header: 'AGENT',
    width: 9,
    cell: session => {
      const info = agentDisplay(session.agentType)
      return { text: info.label, color: info.color }
    }
  },
  session: {
    header: 'SESSION',
    width: 40,
    cell: (session, ctx) => ({ text: (ctx.pane && ctx.pane.sessionName) || session.tmuxSessionName || '-', color: '34' })
  },
  window: {
    header: 'WINDOW',
    width: 60,
    cell: (session, ctx) => ({ text: (ctx.pane && ctx.pane.windowName) || session.tmuxWindowName || '-', color: '36' })
  },
  project: {
    header: 'PROJECT',
    width: 16,
    cell: session => ({ text: path.basename(session.workingDirectory || '?'), color: '37' })
  },
  title: {
    header: 'TITLE',
    width: 50,
    cell: session => session.sessionTitle ? { text: `"${cleanOptionalText(session.sessionTitle)}"`, color: '2' } : null
  },
  detail: { header: 'DETAIL', width: 55, cell: (session, ctx) => detailCell(session, ctx.now) },
  source: {
    header: 'SOURCE',
    width: 40,
    cell: (session, ctx) => {
      const evidence = evidenceDetail(session, ctx.now)
      return evidence ? { text: evidence, color: '2' } : null
    }
  }
})

// Column names, comma- or space-separated, each optionally `name:width`.
// An unknown name is skipped rather than breaking the picker over a typo, and
// a value naming none at all means the default.
function parseColumns(value) {
  const columns = []
  for (const token of String(value || '').toLowerCase().split(/[\s,]+/)) {
    const [name, rawWidth] = token.split(':')
    if (!Object.prototype.hasOwnProperty.call(COLUMNS, name)) continue
    const width = Number.parseInt(rawWidth, 10)
    const explicit = Number.isInteger(width) && width > 0
    columns.push({ name, width: explicit ? Math.min(width, MAX_COLUMN_WIDTH) : COLUMNS[name].width, explicit })
  }
  return columns.length > 0 ? columns : parseColumns(DEFAULT_COLUMNS)
}

// How many terminal columns one row of the list has, when fzf says: reloads
// run as its children and see its size. The render before fzf starts does
// not, and lays rows out as wide as they need. The offsets are what the
// layout in picker.sh takes from these, measured: the pointer gutter, the
// border, and with the preview shown, its border; less one for a scrollbar.
function listWidth(env = process.env) {
  const columns = Number.parseInt(env.FZF_COLUMNS, 10)
  if (!(columns > 0)) return Infinity
  const previewLeft = Number.parseInt(env.FZF_PREVIEW_LEFT, 10)
  const previewColumns = Number.parseInt(env.FZF_PREVIEW_COLUMNS, 10)
  const width = previewColumns > 0 && previewLeft > 0 ? previewLeft - 7 : columns - 2
  return Math.max(0, width - 1)
}

// The widths the rows are drawn at. Each column is as wide as the widest thing
// it shows and its header, up to its width, or exactly the width the option
// gave it. A row still wider than the list would be cut by fzf at the edge,
// taking whichever column ended up last, so the columns that matter least give
// up width first instead (SHRINK_ORDER). One given a width keeps it.
function layoutColumns(columns, sessions, now, available = Infinity) {
  const rows = sessions.map(session => [session, { now, pane: session.tmuxPane ? session._tmuxPaneSnapshot : null }])
  const laid = columns.map(column => {
    if (column.explicit) return Object.assign({}, column)
    const spec = COLUMNS[column.name]
    let widest = displayWidth(spec.header)
    for (const [session, ctx] of rows) {
      const cell = spec.cell(session, ctx)
      if (cell && cell.text) widest = Math.max(widest, displayWidth(cleanText(cell.text, '')))
    }
    return Object.assign({}, column, { width: Math.min(column.width, widest) })
  })

  // The current-pane marker and its space, then a space between columns.
  let excess = 2 + laid.reduce((sum, column) => sum + column.width, 0) + laid.length - 1 - available
  for (const name of SHRINK_ORDER) {
    laid.forEach((column, index) => {
      if (excess <= 0 || column.name !== name || column.explicit) return
      const floor = index === laid.length - 1 ? 0 : Math.min(column.width, MIN_COLUMN_WIDTH)
      const give = Math.min(column.width - floor, excess)
      column.width -= give
      excess -= give
    })
  }
  return laid
}

function formatLine(session, now, currentPane, columns = layoutColumns(parseColumns(DEFAULT_COLUMNS), [session], now)) {
  const unbound = !session.tmuxPane
  const ctx = { now, pane: unbound ? null : session._tmuxPaneSnapshot }

  const isCurrent = !unbound && currentPane && session.tmuxPane === currentPane
  const cur = isCurrent ? '\x1b[33m*\x1b[0m' : ' '
  const cells = columns.map((column, index) =>
    formatCell(COLUMNS[column.name].cell(session, ctx), column.width, index === columns.length - 1))

  const paneId = session.tmuxPane || 'UNBOUND'
  const sessionId = String(session.sessionId || '').replace(/[\r\n\t]+/g, '_')
  return `${paneId}\t${`${cur} ${cells.join(' ')}`.trimEnd()}\t${sessionId}`
}

// The fzf header row. While screen reading is failing it says so instead of
// naming the columns: the states in those columns are what it makes stale,
// and the header is the one line the picker re-reads on every refresh and
// always shows, whatever fzf version draws it.
function headerLine(problem, columns = layoutColumns(parseColumns(DEFAULT_COLUMNS), [], Date.now())) {
  if (problem) return `_\t\x1b[1;31m⚠ ${healthSentence(problem)}\x1b[0m\t_`
  const names = columns.map((column, index) =>
    formatCell({ text: COLUMNS[column.name].header }, column.width, index === columns.length - 1))
  return `_\t${`  ${names.join(' ')}`.trimEnd()}\t_`
}

function run(file, pane, cached) {
  if (file) statusFile = file
  if (pane !== undefined) currentPane = pane
  if (!statusFile) return

  const status = (cached && cached.status) || readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const panes = (cached && cached.panes) || getPaneSnapshot()
  const now = Date.now()

  const active = getActiveSessions(status, panes)
  for (const session of active) {
    session._tmuxPaneSnapshot = session.tmuxPane ? panes.get(session.tmuxPane) : null
  }
  const accessTimes = readAccessTimes()
  active.sort((left, right) => compareSessions(left, right, { accessTimes }))

  const columns = layoutColumns(parseColumns(readTmuxOption(COLUMNS_OPTION)), active, now, listWidth())
  console.log(headerLine(readPaneHealth(), columns))

  if (active.length === 0) {
    console.log('NONE\tNo active sessions found.\t')
    return
  }

  for (const session of active) {
    console.log(formatLine(session, now, currentPane, columns))
  }
}

module.exports = {
  run,
  getActiveSessions,
  compareSessions,
  formatLine,
  headerLine,
  layoutColumns,
  listWidth,
  parseColumns,
  subagentDetail,
  evidenceDetail,
  waitCode
}

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
