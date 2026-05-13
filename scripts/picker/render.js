#!/usr/bin/env node
// Pure view layer: read status.json and output formatted lines for fzf picker.
// All data mutation (crash detection, Codex sync) happens in sync.js.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

let statusFile = process.argv[2] || ''
let currentPane = process.argv[3] || ''

const pidStateCache = new Map()
const TERMINAL_DISPLAY_MS = 5 * 60 * 1000
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
  for (const session of Object.values(status.sessions || {})) {
    if (!isActiveSession(session, panes, now)) continue
    if (!session.tmuxPane) {
      unbound.push(session)
      continue
    }
    const existing = byPane.get(session.tmuxPane)
    if (!existing || (session.lastUpdated || 0) > (existing.lastUpdated || 0)) {
      byPane.set(session.tmuxPane, session)
    }
  }
  return Array.from(byPane.values()).concat(unbound)
}

function truncatePad(value, width) {
  const text = String(value || '?').replace(/[\r\n\t]+/g, ' ')
  return (text.length > width ? text.slice(0, width - 1) + '~' : text).padEnd(width)
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

function waitCode(reason) {
  const text = String(reason || '').toLowerCase()
  if (text.includes('answer') || text.includes('input') || text.includes('question')) return 'ANS'
  if (text.includes('plan')) return 'PLAN'
  if (text.includes('approval') || text.includes('permission') || text.includes('allow')) return 'APP'
  return 'WAIT'
}

function statusTag(session, now) {
  if (isNeedsAttention(session, now)) return `\x1b[31m[W:${waitCode(session.needsAttention)}]\x1b[0m`
  if (session.status === 'working') return '\x1b[33m[ BUSY ]\x1b[0m'
  if (session.status === 'interrupted') return '\x1b[35m[ INT  ]\x1b[0m'
  if (session.status === 'crashed') return '\x1b[31m[CRASH]\x1b[0m'
  if (session.status === 'stale') return '\x1b[90m[STALE]\x1b[0m'
  if (session.status === 'completed') return '\x1b[32m[ DONE ]\x1b[0m'
  return '\x1b[34m[ IDLE ]\x1b[0m'
}

function formatField(value, width, color) {
  const text = truncateText(value, width)
  const padding = ' '.repeat(Math.max(0, width - text.length))
  return `\x1b[${color}m${text}\x1b[0m${padding}`
}

function formatLine(session, now, currentPane) {
  const unbound = !session.tmuxPane
  const pane = unbound ? null : session._tmuxPaneSnapshot

  const isCurrent = !unbound && currentPane && session.tmuxPane === currentPane
  const cur = isCurrent ? '\x1b[33m*\x1b[0m' : ' '
  const tag = statusTag(session, now)
  const agent = session.agentType === 'codex' ? '\x1b[38;5;114mcodex \x1b[0m' : '\x1b[38;5;209mclaude\x1b[0m'
  const windowName = pane && pane.windowName ? pane.windowName : session.tmuxWindowName || '-'
  const projectName = path.basename(session.workingDirectory || '?')
  const window = formatField(windowName, WINDOW_WIDTH, '36')
  const project = formatField(projectName, PROJECT_WIDTH, '37')
  const title = session.sessionTitle ? `\x1b[2m"${String(session.sessionTitle).replace(/[\r\n]+/g, ' ').slice(0, 50)}"\x1b[0m` : ''
  const terminalReason = session.crashReason || session.staleReason || session.stateReason
  const detail = isTerminalSession(session) && terminalReason
    ? `  \x1b[2m${String(terminalReason).replace(/[\r\n]+/g, ' ').slice(0, 55)}\x1b[0m`
    : unbound
    ? `  \x1b[2m(pane not yet linked — waiting for first response)\x1b[0m`
    : session.pendingToolUse && session.pendingToolUse.details
      ? `  \x1b[36m${String(session.pendingToolUse.details).replace(/[\r\n]+/g, ' ').slice(0, 40)}\x1b[0m`
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

  const hStatus = 'STATUS '.padEnd(8)
  const hWindow = 'WINDOW'.padEnd(WINDOW_WIDTH)
  const hProject = 'PROJECT'.padEnd(PROJECT_WIDTH)
  console.log(`_\t  ${hStatus} AGENT  ${hWindow} ${hProject} TITLE`)

  if (active.length === 0) {
    console.log('NONE\tNo active sessions found.')
    return
  }

  for (const session of active) {
    console.log(formatLine(session, now, currentPane))
  }
}

module.exports = { run, getActiveSessions }

if (require.main === module) {
  if (!statusFile) process.exit(1)
  run()
}
