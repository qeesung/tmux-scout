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

let statusFile = process.argv[2] || ''
let currentPane = process.argv[3] || ''

const pidStateCache = new Map()
const STATUS_WIDTH = 6
const AGENT_WIDTH = 9
const WINDOW_WIDTH = 20
const PROJECT_WIDTH = 16

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

function truncateText(value, width) {
  if (width <= 0) return ''
  const text = cleanText(value, '')
  return text.length > width ? text.slice(0, width - 1) + '~' : text
}

function formatField(value, width, color) {
  const text = truncateText(value, width)
  const padding = ' '.repeat(Math.max(0, width - text.length))
  return `\x1b[${color}m${text}\x1b[0m${padding}`
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

function statusTag(session, now) {
  const phase = phaseForSession(session)
  if (isNeedsAttention(session, now)) return formatField(`W:${waitCode(session)}`, STATUS_WIDTH, '31')
  if (session && session.isRalphLoopIteration) return formatField('LOOP', STATUS_WIDTH, '35')
  if (phase === 'running') return formatField('BUSY', STATUS_WIDTH, '33')
  if (phase === 'interrupted') return formatField('INT', STATUS_WIDTH, '35')
  if (phase === 'crashed') return formatField('CRASH', STATUS_WIDTH, '31')
  if (phase === 'stale') return formatField('STALE', STATUS_WIDTH, '90')
  if (phase === 'completed') return formatField('DONE', STATUS_WIDTH, '32')
  return formatField('IDLE', STATUS_WIDTH, '34')
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

function formatLine(session, now, currentPane) {
  const unbound = !session.tmuxPane
  const pane = unbound ? null : session._tmuxPaneSnapshot

  const isCurrent = !unbound && currentPane && session.tmuxPane === currentPane
  const cur = isCurrent ? '\x1b[33m*\x1b[0m' : ' '
  const tag = statusTag(session, now)
  const agentInfo = agentDisplay(session.agentType)
  const agent = formatField(agentInfo.label, AGENT_WIDTH, agentInfo.color)
  const windowName = pane && pane.windowName ? pane.windowName : session.tmuxWindowName || '-'
  const projectName = path.basename(session.workingDirectory || '?')
  const window = formatField(windowName, WINDOW_WIDTH, '36')
  const project = formatField(projectName, PROJECT_WIDTH, '37')
  const title = session.sessionTitle ? `\x1b[2m"${String(session.sessionTitle).replace(/[\r\n\t]+/g, ' ').slice(0, 50)}"\x1b[0m` : ''
  const terminalReason = session.terminalReason || session.crashReason || session.staleReason || session.stateReason
  const subagents = subagentDetail(session)
  const ralph = ralphLoopDetail(session)
  const evidence = evidenceDetail(session, now)
  const detail = isTerminalSession(session) && terminalReason
    ? `  \x1b[2m${String(terminalReason).replace(/[\r\n\t]+/g, ' ').slice(0, 55)}\x1b[0m`
    : ralph
    ? `  \x1b[35m${ralph.slice(0, 55)}\x1b[0m`
    : isNeedsAttention(session, now)
    ? `  \x1b[31m${attentionDetail(session).slice(0, 55)}\x1b[0m`
    : unbound
    ? `  \x1b[2m(pane not yet linked — waiting for first response)\x1b[0m`
    : subagents
      ? `  \x1b[35m${subagents.slice(0, 55)}\x1b[0m`
      : phaseForSession(session) === 'running' && session.activeTool && session.pendingToolUse && session.pendingToolUse.details
        ? `  \x1b[36m${String(session.pendingToolUse.details).replace(/[\r\n\t]+/g, ' ').slice(0, 40)}\x1b[0m`
      : evidence
        ? `  \x1b[2m${evidence.slice(0, 55)}\x1b[0m`
      : ''

  const paneId = session.tmuxPane || 'UNBOUND'
  const sessionId = String(session.sessionId || '').replace(/[\r\n\t]+/g, '_')
  return `${paneId}\t${cur} ${tag} ${agent} ${window} ${project} ${title}${detail}\t${sessionId}`
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

  const hStatus = 'STATUS'.padEnd(STATUS_WIDTH)
  const hAgent = 'AGENT'.padEnd(AGENT_WIDTH)
  const hWindow = 'WINDOW'.padEnd(WINDOW_WIDTH)
  const hProject = 'PROJECT'.padEnd(PROJECT_WIDTH)
  console.log(`_\t  ${hStatus} ${hAgent} ${hWindow} ${hProject} TITLE\t_`)

  if (active.length === 0) {
    console.log('NONE\tNo active sessions found.\t')
    return
  }

  for (const session of active) {
    console.log(formatLine(session, now, currentPane))
  }
}

module.exports = { run, getActiveSessions, compareSessions, formatLine, subagentDetail, evidenceDetail, waitCode }

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
