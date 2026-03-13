#!/usr/bin/env node
// Pure view layer: read status.json and output formatted lines for fzf picker.
// All data mutation (crash detection, Codex sync) happens in sync-sessions.js.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

let statusFile = process.argv[2] || ''
let currentPane = process.argv[3] || ''

const pidStateCache = new Map()

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
    const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_dead}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()

    if (!output) return panes

    for (const line of output.split('\n')) {
      const [paneId, panePid, currentCommand, paneDead] = line.split('\t')
      if (paneId) {
        panes.set(paneId.trim(), {
          paneId: paneId.trim(),
          panePid: Number.parseInt(panePid, 10) || null,
          currentCommand: currentCommand || '',
          paneDead: paneDead === '1'
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
  if (session.pendingToolUse && session.pendingToolUse.timestamp && (now - session.pendingToolUse.timestamp > 5000)) {
    return true
  }
  return false
}

function groupOrder(session, now) {
  if (isNeedsAttention(session, now)) return 0
  if (session.status === 'working') return 1
  if (session.status === 'completed') return 2
  return 3
}

function isActiveSession(session, panes) {
  if (!session || session.endedAt || session.status === 'crashed') {
    return false
  }
  // Discovered from JSONL but hook hasn't fired yet — no pane bound
  if (!session.tmuxPane) {
    return true
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
  for (const session of Object.values(status.sessions || {})) {
    if (!isActiveSession(session, panes)) continue
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

function formatLine(session, now, currentPane) {
  const unbound = !session.tmuxPane

  const tag = isNeedsAttention(session, now) ? '\x1b[31m[ WAIT ]\x1b[0m'
    : session.status === 'working' ? '\x1b[33m[ BUSY ]\x1b[0m'
    : session.status === 'completed' ? '\x1b[32m[ DONE ]\x1b[0m'
    : '\x1b[34m[ IDLE ]\x1b[0m'

  const isCurrent = !unbound && currentPane && session.tmuxPane === currentPane
  const cur = isCurrent ? '\x1b[33m*\x1b[0m' : ' '
  const agent = session.agentType === 'codex' ? '\x1b[38;5;114mcodex \x1b[0m' : '\x1b[38;5;209mclaude\x1b[0m'
  const projectName = path.basename(session.workingDirectory || '?')
  const project = (projectName.length > 25 ? projectName.slice(0, 24) + '~' : projectName).padEnd(25)
  const title = session.sessionTitle ? `\x1b[2m"${String(session.sessionTitle).replace(/[\r\n]+/g, ' ').slice(0, 50)}"\x1b[0m` : ''
  const detail = unbound
    ? `  \x1b[2m(pane not yet linked — waiting for first response)\x1b[0m`
    : session.pendingToolUse && session.pendingToolUse.details
      ? `  \x1b[36m${String(session.pendingToolUse.details).replace(/[\r\n]+/g, ' ').slice(0, 40)}\x1b[0m`
      : ''

  const paneId = session.tmuxPane || 'UNBOUND'
  return `${paneId}\t${cur} ${tag} ${agent} ${project} ${title}${detail}`
}

function run(file, pane, cached) {
  if (file) statusFile = file
  if (pane !== undefined) currentPane = pane
  if (!statusFile) return

  const status = (cached && cached.status) || readJson(statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  const panes = (cached && cached.panes) || getPaneSnapshot()
  const now = Date.now()

  const active = getActiveSessions(status, panes)
  active.sort((left, right) => {
    const g = groupOrder(left, now) - groupOrder(right, now)
    if (g !== 0) return g
    return (right.lastUpdated || 0) - (left.lastUpdated || 0)
  })

  const hStatus = 'STATUS '.padEnd(8)
  const hProject = 'PROJECT'.padEnd(25)
  console.log(`_\t  ${hStatus} AGENT  ${hProject} TITLE`)

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
