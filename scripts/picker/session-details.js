#!/usr/bin/env node
// Read-only session information panel for the picker details action.

const fs = require('fs')
const path = require('path')
const { agentDisplay } = require('../lib/agents')

const statusFile = process.argv[2] || ''
const sessionId = process.argv[3] || ''

const ANSI_RE = /\x1b\[[0-9;]*m/g
const COLORS_ENABLED = process.env.TMUX_SCOUT_NO_COLOR !== '1'
const COLOR = {
  reset: '\x1b[0m',
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90'
}

function colorText(value, code) {
  const text = String(value || '')
  if (!COLORS_ENABLED || !code || !text) return text
  return `\x1b[${code}m${text}${COLOR.reset}`
}

function stripAnsi(value) {
  return String(value || '').replace(ANSI_RE, '')
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function cleanText(value, fallback = '') {
  const text = String(value || fallback || '').replace(/[\r\n\t]+/g, ' ').trim()
  return text || fallback
}

function truncateText(value, max = 100) {
  const text = cleanText(value)
  if (!text || text.length <= max) return text
  return text.slice(0, max - 1) + '~'
}

function shortAge(now, timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function statusLabel(session) {
  if (session.isRalphLoopIteration) return 'LOOP'
  if (session.needsAttention) return 'WAITING'
  if (session.status === 'working') return 'BUSY'
  if (session.status === 'interrupted') return 'INTERRUPTED'
  if (session.status === 'crashed') return 'CRASHED'
  if (session.status === 'stale') return 'STALE'
  if (session.status === 'completed') return 'DONE'
  return 'IDLE'
}

function statusColor(session) {
  if (session.isRalphLoopIteration) return COLOR.magenta
  if (session.needsAttention) return `${COLOR.red};${COLOR.bold}`
  if (session.status === 'working') return COLOR.yellow
  if (session.status === 'interrupted') return COLOR.magenta
  if (session.status === 'crashed') return `${COLOR.red};${COLOR.bold}`
  if (session.status === 'stale') return COLOR.gray
  if (session.status === 'completed') return COLOR.green
  return COLOR.blue
}

function phaseColor(phase) {
  switch (phase) {
    case 'waitingForApproval':
    case 'waitingForAnswer':
      return COLOR.red
    case 'running':
      return COLOR.yellow
    case 'completed':
      return COLOR.green
    case 'interrupted':
      return COLOR.magenta
    case 'crashed':
      return `${COLOR.red};${COLOR.bold}`
    case 'stale':
      return COLOR.gray
    default:
      return COLOR.blue
  }
}

function currentActivity(session) {
  if (session.pendingToolUse && session.pendingToolUse.details) return session.pendingToolUse.details
  if (session.activeTool) return session.activeTool
  if (session.currentActivity) return session.currentActivity
  if (session.lastEvent && session.lastEvent.details) return session.lastEvent.details
  if (session.stateReason) return session.stateReason
  return ''
}

function ralphLoopDetail(session) {
  if (!session || !session.isRalphLoopIteration) return ''
  const loop = session.ralphLoop && typeof session.ralphLoop === 'object' ? session.ralphLoop : {}
  const iteration = Number.isFinite(loop.iteration) ? loop.iteration : undefined
  const maxIterations = Number.isFinite(loop.maxIterations) ? loop.maxIterations : undefined
  const promise = cleanText(loop.completionPromise)
  const progress = iteration !== undefined && maxIterations !== undefined && maxIterations > 0
    ? `${iteration}/${maxIterations}`
    : iteration !== undefined ? `iteration ${iteration}` : 'active'
  return [progress, promise].filter(Boolean).join('  ')
}

function updatedLine(session, now) {
  const timestamp = session.lastUpdated || session.lastHookAt || session.startedAt
  const parts = []
  const age = shortAge(now, timestamp)
  if (age) parts.push(age)
  if (session.stateSource) parts.push(`source=${session.stateSource}`)
  if (Number.isFinite(session.stateConfidence)) parts.push(`confidence=${session.stateConfidence}`)
  return parts.join('  ')
}

function pendingInteractionDetail(pending) {
  if (!pending) return ''
  const head = [pending.type, pending.tool].filter(Boolean).join(' ')
  return truncateText([head, pending.details].filter(Boolean).join('  '), 120)
}

function pendingInteractionEvidence(pending, now) {
  if (!pending) return ''
  const parts = []
  if (pending.source) parts.push(`source=${pending.source}`)
  if (pending.stateSource) parts.push(`state=${pending.stateSource}`)
  if (pending.rawEventName) parts.push(`event=${pending.rawEventName}`)
  const age = shortAge(now, pending.updatedAt)
  if (age) parts.push(`updated=${age}`)
  if (Number.isFinite(pending.confidence)) parts.push(`confidence=${pending.confidence}`)
  if (pending.requestId) parts.push(`request=${pending.requestId}`)
  return parts.join('  ')
}

function pushField(lines, label, value) {
  const text = cleanText(value)
  if (!text) return
  lines.push(`  ${colorText(label.padEnd(10), COLOR.gray)} ${text}`)
}

function formatHeader(session) {
  const agentInfo = agentDisplay(session.agentType)
  const agent = agentInfo.label
  const project = path.basename(session.workingDirectory || '') || '-'
  const title = session.sessionTitle || session.lastUserPrompt || ''
  const status = statusLabel(session).padEnd(10)
  const lines = [
    colorText('tmux-scout', `${COLOR.cyan};${COLOR.bold}`) + colorText(' | session', COLOR.gray),
    colorText('--------------------------------------------------------------------------------', COLOR.gray),
    `${colorText(status, statusColor(session))} ${colorText(agent, `${agentInfo.color};${COLOR.bold}`)}   ${colorText(project, COLOR.white)}`
  ]
  if (title) lines.push(colorText(`"${truncateText(title, 120)}"`, COLOR.gray))
  lines.push('')
  return lines
}

function formatCurrent(session, now) {
  const phase = session.phase || session.status || 'unknown'
  const lines = [colorText('Current', `${COLOR.cyan};${COLOR.bold}`)]
  pushField(lines, 'phase', colorText(phase, phaseColor(phase)))
  pushField(lines, 'activity', colorText(truncateText(currentActivity(session), 120), COLOR.yellow))
  pushField(lines, 'request', colorText(session.needsAttention, COLOR.red))
  pushField(lines, 'ralph', colorText(ralphLoopDetail(session), COLOR.magenta))
  pushField(lines, 'pending', colorText(pendingInteractionDetail(session.pendingInteraction), COLOR.red))
  pushField(lines, 'evidence', pendingInteractionEvidence(session.pendingInteraction, now))
  pushField(lines, 'updated', updatedLine(session, now))
  return lines
}

function formatContext(session) {
  const lines = ['', colorText('Context', `${COLOR.cyan};${COLOR.bold}`)]
  const paneParts = [session.tmuxPane, session.tmuxSessionName, session.tmuxWindowName].filter(Boolean)
  pushField(lines, 'pane', colorText(paneParts.join('  '), COLOR.green))
  const pidParts = [session.pid]
  if (session.pidCommand) pidParts.push(truncateText(session.pidCommand, 90))
  if (session.pidSource) pidParts.push(`source=${session.pidSource}`)
  pushField(lines, 'pid', pidParts.filter(Boolean).join('  '))
  const terminalParts = [session.terminalApp, session.terminalTty, session.terminalSessionId].filter(Boolean)
  pushField(lines, 'terminal', truncateText(terminalParts.join('  '), 120))
  const hostParts = [session.userName && session.hostName ? `${session.userName}@${session.hostName}` : session.hostName]
  if (Array.isArray(session.hostIpAddresses) && session.hostIpAddresses.length > 0) {
    hostParts.push(session.hostIpAddresses.slice(0, 3).join(','))
  }
  if (session.sshClient) hostParts.push(`ssh=${session.sshClient}`)
  pushField(lines, 'host', truncateText(hostParts.filter(Boolean).join('  '), 120))
  pushField(lines, 'cwd', truncateText(session.workingDirectory, 120))
  return lines
}

function formatEvidence(session, now) {
  const lines = ['', colorText('State Stream', `${COLOR.cyan};${COLOR.bold}`)]
  const entries = Array.isArray(session.stateEvidence)
    ? session.stateEvidence.filter(Boolean).slice(0, 8)
    : []
  if (entries.length === 0) {
    lines.push(colorText('  no state events recorded', COLOR.gray))
    return lines
  }
  for (const entry of entries) {
    const age = colorText(shortAge(now, entry.timestamp).padEnd(8), COLOR.gray)
    const name = colorText(truncateText(entry.rawEventName || entry.type || 'event', 22).padEnd(22), COLOR.cyan)
    const rawPhase = truncateText(entry.phase || '', 18).padEnd(18)
    const phase = colorText(rawPhase, phaseColor(entry.phase))
    const detail = truncateText(entry.details || entry.reason || '', 70)
    lines.push(stripAnsi(`  ${age} ${name} ${phase} ${detail}`).trimEnd().length > 0
      ? `  ${age} ${name} ${phase} ${colorText(detail, COLOR.white)}`.trimEnd()
      : '')
  }
  return lines
}

function formatLinks(session) {
  const lines = ['', colorText('Links', `${COLOR.cyan};${COLOR.bold}`)]
  pushField(lines, 'transcript', colorText(truncateText(session.transcriptPath, 120), COLOR.blue))
  pushField(lines, 'session', colorText(session.sessionId, COLOR.blue))
  pushField(lines, 'codex', [
    session.codexSessionSource,
    session.codexForkedFromId ? `fork=${session.codexForkedFromId}` : '',
    session.codexAgentNickname ? `agent=${session.codexAgentNickname}` : ''
  ].filter(Boolean).join('  '))
  return lines
}

function formatNote(session, now) {
  const lines = []
  const lastHookAt = Number.isFinite(session.lastHookAt) ? session.lastHookAt : 0
  if ((session.status === 'working' || session.needsAttention) && lastHookAt && now - lastHookAt > 2 * 60 * 1000) {
    lines.push('', colorText(`Note: state may be stale; last hook was ${shortAge(now, lastHookAt)}.`, COLOR.yellow))
  }
  return lines
}

function formatSessionDetails(session, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  if (!session) return 'No session details available.\n'
  const lines = []
  lines.push(...formatHeader(session))
  lines.push(...formatCurrent(session, now))
  lines.push(...formatContext(session))
  lines.push(...formatEvidence(session, now))
  lines.push(...formatLinks(session))
  lines.push(...formatNote(session, now))
  lines.push(colorText('--------------------------------------------------------------------------------', COLOR.gray))
  lines.push(colorText('q: close | Up/Down/PgUp/PgDn: scroll', COLOR.gray))
  return lines.join('\n') + '\n'
}

function run(file, id) {
  if (!file || !id || id === '_') {
    process.stdout.write('No session selected.\n')
    return
  }
  const status = readJson(file, { sessions: {} })
  const session = status.sessions && status.sessions[id]
  process.stdout.write(formatSessionDetails(session))
}

module.exports = {
  formatSessionDetails,
  currentActivity,
  statusLabel,
  stripAnsi
}

if (require.main === module) {
  run(statusFile, sessionId)
}
