#!/usr/bin/env node
// Pure view layer: read status.json and output formatted lines for fzf picker.
// All data mutation (crash detection, Codex sync) happens in sync.js.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { isHiddenCodexSession } = require('../lib/codex-session-classifier')
const { agentDisplay } = require('../lib/agents')

let statusFile = process.argv[2] || ''
let currentPane = process.argv[3] || ''

const pidStateCache = new Map()
const TERMINAL_DISPLAY_MS = 5 * 60 * 1000
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

function canUseShellFallback(session) {
  if (session.agentType === 'codex') return true
  const lastEventType = session && session.lastEvent ? session.lastEvent.type : null
  return session.status === 'working' || lastEventType === 'prompt_submit' || lastEventType === 'tool_use' || Boolean(session.pendingToolUse)
}

function isNeedsAttention(session, now) {
  if (session.needsAttention) return true
  return false
}

function groupOrder(session, now) {
  if (isNeedsAttention(session, now)) return 0
  if (session.status === 'working') return 1
  if (session.status === 'interrupted') return 2
  if (session.status === 'completed') return 3
  if (session.status === 'crashed' || session.status === 'stale') return 4
  return 5
}

function isTerminalSession(session) {
  return session && (session.status === 'crashed' || session.status === 'stale' || session.status === 'interrupted')
}

function isRecentlyTerminal(session, now) {
  if (!isTerminalSession(session)) return false
  const ts = session.endedAt || session.lastUpdated || 0
  return ts > 0 && now - ts < TERMINAL_DISPLAY_MS
}

function isActiveSession(session, panes, now = Date.now()) {
  if (!session) return false
  if (isHiddenCodexSession(session)) return false
  if (isRecentlyTerminal(session, now)) return true
  if (session.endedAt || session.status === 'crashed' || session.status === 'stale') return false

  // Discovered from JSONL but hook hasn't fired yet — no pane bound
  if (!session.tmuxPane) {
    return session.status !== 'idle'
  }
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
  const unbound = []
  const now = Date.now()

  function paneActivityRank(session) {
    if (isNeedsAttention(session, now) || session.status === 'working') return 0
    if (session.status === 'completed' || session.status === 'idle') return 1
    if (session.status === 'interrupted') return 2
    if (session.status === 'crashed' || session.status === 'stale') return 3
    return 4
  }

  function foregroundTimestamp(session) {
    if (Number.isFinite(session.lastHookAt) && session.lastHookAt > 0) return session.lastHookAt
    if (session.lastEvent && session.lastEvent.type !== 'pane_state'
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
    if (!session.tmuxPane) {
      unbound.push(session)
      continue
    }
    const existing = byPane.get(session.tmuxPane)
    if (shouldReplacePaneSession(existing, session)) {
      byPane.set(session.tmuxPane, session)
    }
  }
  return Array.from(byPane.values()).concat(unbound)
}

function cleanText(value, fallback) {
  const text = String(value || fallback || '?').replace(/[\r\n\t]+/g, ' ').trim()
  return text || fallback || '?'
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

function waitCode(reason) {
  const text = String(reason || '').toLowerCase()
  if (text.includes('answer') || text.includes('input') || text.includes('question')) return 'ANS'
  if (text.includes('plan')) return 'PLAN'
  if (text.includes('approval') || text.includes('permission') || text.includes('allow')) return 'APP'
  return 'WAIT'
}

function statusTag(session, now) {
  if (isNeedsAttention(session, now)) return formatField(`W:${waitCode(session.needsAttention)}`, STATUS_WIDTH, '31')
  if (session.status === 'working') return formatField('BUSY', STATUS_WIDTH, '33')
  if (session.status === 'interrupted') return formatField('INT', STATUS_WIDTH, '35')
  if (session.status === 'crashed') return formatField('CRASH', STATUS_WIDTH, '31')
  if (session.status === 'stale') return formatField('STALE', STATUS_WIDTH, '90')
  if (session.status === 'completed') return formatField('DONE', STATUS_WIDTH, '32')
  return formatField('IDLE', STATUS_WIDTH, '34')
}

function attentionDetail(session) {
  if (!session.needsAttention) return ''
  const reason = cleanText(session.needsAttention, 'waiting')
  const tool = session.pendingToolUse && session.pendingToolUse.details
    ? cleanText(session.pendingToolUse.details, '')
    : ''
  return tool ? `${reason}: ${tool}` : reason
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
  const title = session.sessionTitle ? `\x1b[2m"${String(session.sessionTitle).replace(/[\r\n]+/g, ' ').slice(0, 50)}"\x1b[0m` : ''
  const terminalReason = session.crashReason || session.staleReason || session.stateReason
  const subagents = subagentDetail(session)
  const detail = isTerminalSession(session) && terminalReason
    ? `  \x1b[2m${String(terminalReason).replace(/[\r\n]+/g, ' ').slice(0, 55)}\x1b[0m`
    : isNeedsAttention(session, now)
    ? `  \x1b[31m${attentionDetail(session).slice(0, 55)}\x1b[0m`
    : unbound
    ? `  \x1b[2m(pane not yet linked — waiting for first response)\x1b[0m`
    : session.pendingToolUse && session.pendingToolUse.details
      ? `  \x1b[36m${String(session.pendingToolUse.details).replace(/[\r\n]+/g, ' ').slice(0, 40)}\x1b[0m`
      : subagents
        ? `  \x1b[35m${subagents.slice(0, 55)}\x1b[0m`
      : ''

  const paneId = session.tmuxPane || 'UNBOUND'
  return `${paneId}\t${cur} ${tag} ${agent} ${window} ${project} ${title}${detail}`
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
  active.sort((left, right) => {
    const g = groupOrder(left, now) - groupOrder(right, now)
    if (g !== 0) return g
    return (right.lastUpdated || 0) - (left.lastUpdated || 0)
  })

  const hStatus = 'STATUS'.padEnd(STATUS_WIDTH)
  const hAgent = 'AGENT'.padEnd(AGENT_WIDTH)
  const hWindow = 'WINDOW'.padEnd(WINDOW_WIDTH)
  const hProject = 'PROJECT'.padEnd(PROJECT_WIDTH)
  console.log(`_\t  ${hStatus} ${hAgent} ${hWindow} ${hProject} TITLE`)

  if (active.length === 0) {
    console.log('NONE\tNo active sessions found.')
    return
  }

  for (const session of active) {
    console.log(formatLine(session, now, currentPane))
  }
}

module.exports = { run, getActiveSessions, formatLine, subagentDetail }

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
