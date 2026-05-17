#!/usr/bin/env node
// tmux-scout diagnostics and fixture replay helpers.

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  defaultPaths,
  ensureDirs,
  readJson,
  writeJsonAtomic,
  updateSessionDirect
} = require('./lib/hook-adapter')
const { currentPhase } = require('./lib/session-state')
const { AGENT_EVENTS } = require('./lib/agent-events')
const { SESSION_PHASES, validateSessionSnapshot } = require('./lib/session-contract')
const { formatSessionDetails, stripAnsi } = require('./picker/session-details')
const { runFlowFixture } = require('./lib/flow-fixtures')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      args._.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq >= 0) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i++
    } else {
      args[key] = true
    }
  }
  return args
}

function usage() {
  return [
    'Usage:',
    '  node scripts/debug.js list [--home DIR|--status-file FILE]',
    '  node scripts/debug.js show <session-id> [--home DIR|--status-file FILE] [--plain]',
    '  node scripts/debug.js evidence <session-id> [--home DIR|--status-file FILE] [--json]',
    '  node scripts/debug.js inject [--session-id ID] [--agent AGENT] [--phase PHASE] [--title TEXT] [--cwd DIR]',
    '  node scripts/debug.js replay <fixture.json> [--home DIR] [--keep] [--show [SESSION_ID]]',
    '',
    'Phases: idle, running, waitingForApproval, waitingForAnswer, completed, interrupted, crashed, stale'
  ].join('\n')
}

function pathsFromArgs(args) {
  if (args['status-file']) {
    const statusFile = path.resolve(String(args['status-file']))
    const statusDir = path.dirname(statusFile)
    return {
      statusDir,
      statusFile,
      sessionsDir: path.join(statusDir, 'sessions'),
      runDir: path.join(statusDir, 'run'),
      bridgeSocket: path.join(statusDir, 'run', 'bridge.sock')
    }
  }
  return defaultPaths(args.home ? path.resolve(String(args.home)) : os.homedir())
}

function readStatusFromArgs(args) {
  const paths = pathsFromArgs(args)
  return {
    paths,
    status: readJson(paths.statusFile, { version: 1, lastUpdated: Date.now(), sessions: {} })
  }
}

function sessionFromArgs(args) {
  return args._[1] || args.session || args['session-id']
}

function formatAge(now, timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function commandList(args) {
  const { status } = readStatusFromArgs(args)
  const sessions = Object.values(status.sessions || {})
    .sort((left, right) => (right.lastUpdated || 0) - (left.lastUpdated || 0))
  const now = Date.now()
  if (sessions.length === 0) {
    console.log('No tmux-scout sessions found.')
    return
  }
  console.log('sessionId\tagent\tphase\tstatus\tage\ttitle')
  for (const session of sessions) {
    console.log([
      session.sessionId || '-',
      session.agentType || '-',
      currentPhase(session),
      session.status || '-',
      formatAge(now, session.lastUpdated || session.startedAt),
      String(session.sessionTitle || session.lastUserPrompt || '').replace(/[\r\n\t]+/g, ' ').slice(0, 80)
    ].join('\t'))
  }
}

function commandShow(args) {
  const sessionId = sessionFromArgs(args)
  if (!sessionId) throw new Error('show requires a session id')
  const { status } = readStatusFromArgs(args)
  const session = status.sessions && status.sessions[sessionId]
  const output = formatSessionDetails(session)
  process.stdout.write(args.plain ? stripAnsi(output) : output)
}

function commandEvidence(args) {
  const sessionId = sessionFromArgs(args)
  if (!sessionId) throw new Error('evidence requires a session id')
  const { status } = readStatusFromArgs(args)
  const session = status.sessions && status.sessions[sessionId]
  if (!session) throw new Error(`session not found: ${sessionId}`)
  const entries = Array.isArray(session.stateEvidence) ? session.stateEvidence.filter(Boolean) : []
  if (args.json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }
  console.log(`${sessionId}  phase=${currentPhase(session)}  status=${session.status || '-'}`)
  if (entries.length === 0) {
    console.log('no state evidence recorded')
    return
  }
  for (const entry of entries) {
    const timestamp = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toISOString() : '-'
    const applied = entry.applied === false ? 'blocked' : 'applied'
    const detail = String(entry.details || entry.reason || entry.blockedReason || '').replace(/[\r\n\t]+/g, ' ')
    console.log([
      timestamp,
      applied,
      entry.source || '-',
      entry.rawEventName || entry.type || '-',
      entry.phase || '-',
      detail.slice(0, 120)
    ].join('\t'))
  }
}

function eventForPhase(phase) {
  switch (phase) {
    case SESSION_PHASES.IDLE:
      return AGENT_EVENTS.SESSION_START
    case SESSION_PHASES.RUNNING:
      return AGENT_EVENTS.PROMPT_SUBMIT
    case SESSION_PHASES.WAITING_FOR_APPROVAL:
      return AGENT_EVENTS.PERMISSION_REQUEST
    case SESSION_PHASES.WAITING_FOR_ANSWER:
      return AGENT_EVENTS.QUESTION_ASKED
    case SESSION_PHASES.COMPLETED:
      return AGENT_EVENTS.STOP
    case SESSION_PHASES.INTERRUPTED:
      return AGENT_EVENTS.INTERRUPTED
    case SESSION_PHASES.CRASHED:
      return AGENT_EVENTS.PROCESS_EXIT_DETECTED
    case SESSION_PHASES.STALE:
      return AGENT_EVENTS.STALE
    default:
      throw new Error(`unsupported phase: ${phase}`)
  }
}

function commandInject(args) {
  const paths = pathsFromArgs(args)
  ensureDirs(paths)
  const phase = args.phase || SESSION_PHASES.RUNNING
  const sessionId = args['session-id'] || args.session || `debug-${Date.now()}`
  const agentType = args.agent || 'debug'
  const now = Date.now()
  const details = args.details || args.title || `debug ${phase}`
  const pendingToolUse = phase === SESSION_PHASES.WAITING_FOR_APPROVAL
    ? { tool: args.tool || 'DebugTool', details, timestamp: now }
    : phase === SESSION_PHASES.WAITING_FOR_ANSWER
      ? { tool: args.tool || 'AskUserQuestion', details, timestamp: now }
      : null
  const lifecycleEvent = {
    type: eventForPhase(phase),
    source: 'debug',
    stateSource: 'debug',
    rawEventName: 'debug:inject',
    timestamp: now,
    details,
    attentionReason: phase === SESSION_PHASES.WAITING_FOR_APPROVAL
      ? 'waiting for approval'
      : phase === SESSION_PHASES.WAITING_FOR_ANSWER ? 'waiting for answer' : null,
    pendingToolUse,
    activeTool: phase === SESSION_PHASES.RUNNING ? (args.tool || 'DebugTool') : null,
    force: true
  }
  const session = updateSessionDirect({
    agentType,
    defaultStateSource: 'debug',
    lifecycleForce: true
  }, paths, sessionId, {
    agentType,
    workingDirectory: args.cwd || process.cwd(),
    sessionTitle: args.title || `Debug ${phase}`,
    tmuxPane: args.pane || null,
    pid: args.pid ? Number.parseInt(args.pid, 10) : process.pid,
    lifecycleEvent
  })
  const validation = validateSessionSnapshot(session)
  if (!validation.valid) {
    throw new Error(`injected invalid session: ${validation.errors.join('; ')}`)
  }
  console.log(`Injected ${sessionId} (${agentType}, ${currentPhase(session)}) into ${paths.statusFile}`)
  if (validation.warnings.length > 0) {
    console.log(`Warnings: ${validation.warnings.join('; ')}`)
  }
}

function commandReplay(args) {
  const fixturePath = args._[1]
  if (!fixturePath) throw new Error('replay requires a fixture path')
  const homeDir = args.home ? path.resolve(String(args.home)) : undefined
  const result = runFlowFixture(path.resolve(fixturePath), { homeDir })
  try {
    console.log(`Fixture: ${result.fixture.name}`)
    console.log(`Home: ${result.homeDir}`)
    console.log(`Status: ${result.paths.statusFile}`)
    console.log(`Session: ${result.fixture.sessionId}`)
    console.log(`Result: ${result.errors.length === 0 ? 'ok' : 'failed'}`)
    for (const warning of result.warnings) console.log(`Warning: ${warning}`)
    for (const error of result.errors) console.log(`Error: ${error}`)

    if (args.show !== undefined) {
      const showSessionId = typeof args.show === 'string' ? args.show : result.fixture.sessionId
      const session = result.status.sessions && result.status.sessions[showSessionId]
      process.stdout.write(formatSessionDetails(session, { now: Date.now() }))
    }

    if (result.errors.length > 0) process.exitCode = 1
  } finally {
    if (!args.keep && !homeDir) result.cleanup()
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const command = args._[0]
  if (!command || command === 'help' || command === '--help') {
    console.log(usage())
    return
  }
  if (command === 'list') return commandList(args)
  if (command === 'show') return commandShow(args)
  if (command === 'evidence') return commandEvidence(args)
  if (command === 'inject') return commandInject(args)
  if (command === 'replay') return commandReplay(args)
  throw new Error(`unknown debug command: ${command}`)
}

module.exports = {
  parseArgs,
  pathsFromArgs,
  eventForPhase,
  main
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    console.error('')
    console.error(usage())
    process.exit(1)
  }
}
