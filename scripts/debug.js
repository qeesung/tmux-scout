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
const { VERDICTS } = require('./lib/pane-classifier')
const { SHADOW_HEARTBEAT_MS, readShadow } = require('./lib/pane-store')
const { MIN_RATE_UPTIME_MS, USD_PER_INPUT_MTOK, percentile, readMetrics } = require('./lib/pane-metrics')
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
    '  node scripts/debug.js classify <pane-id> [--agent AGENT] [--lines N] [--state] [--raw]',
    '  node scripts/debug.js pane-agreement [--agent AGENT] [--since 24h]',
    '  node scripts/debug.js jev-metrics [--since 24h] [--agent AGENT]',
    '',
    'Phases: idle, running, waitingForApproval, waitingForAnswer, completed, interrupted, crashed, stale'
  ].join('\n')
}

function parseDuration(text, fallback) {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])?$/.exec(String(text || '').trim())
  if (!match) return fallback
  const scale = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] || 'h']
  return Number.parseFloat(match[1]) * scale
}

// Ask the model about one live pane and print everything it saw and answered.
// This is the loop for tuning criteria: the wording in pane-questions.js is what
// actually determines accuracy, and it has no type checker.
async function commandClassify(args) {
  const paneId = args._[1]
  if (!paneId) throw new Error('classify requires a pane id, e.g. %39')

  const { capturePaneTail, DEFAULT_TAIL_LINES } = require('./lib/pane-capture')
  const { buildPaneState, paneQuestions, PANE_QUESTION_SET_VERSION } = require('./lib/pane-questions')
  const { interpretPaneAnswers } = require('./lib/pane-classifier')
  const { extractPromptAndTitle, extractToolLine } = require('./lib/pane-text-extract')
  const { createJevClient, resolveApiKey } = require('./lib/jev-client')

  const lines = Number.parseInt(args.lines, 10) || DEFAULT_TAIL_LINES
  const capture = capturePaneTail(paneId, lines)
  if (!capture) throw new Error(`could not capture pane ${paneId}`)

  const paths = pathsFromArgs(args)
  const status = readJson(paths.statusFile, { sessions: {} })
  const session = Object.values(status.sessions || {}).find(item => item && item.tmuxPane === paneId)
  const agentType = String(args.agent || (session && session.agentType) || 'claude').toLowerCase()

  console.log(`pane=${paneId} agent=${agentType} questionSet=v${PANE_QUESTION_SET_VERSION}`)
  console.log(`fingerprint=${capture.fingerprint} raw=${capture.raw.length}B normalized=${capture.text.length}B ` +
    `(-${Math.round((1 - capture.text.length / Math.max(1, capture.raw.length)) * 100)}%)`)

  if (args.raw) console.log(`\n--- raw ---\n${capture.raw}`)
  const state = buildPaneState(capture, agentType)
  if (args.state) console.log(`\n--- state sent to the model ---\n${JSON.stringify(state, null, 2)}`)
  else console.log(`\n--- normalized screen ---\n${capture.text}`)

  const extracted = extractPromptAndTitle(capture.raw, agentType) || {}
  const tool = extractToolLine(capture.raw, agentType) || {}
  console.log(`\nextracted  title=${JSON.stringify(extracted.sessionTitle)} ` +
    `prompt=${JSON.stringify(extracted.lastUserPrompt)} tool=${JSON.stringify(tool.tool)}`)

  const log = message => console.error(message)
  const client = createJevClient({ apiKey: resolveApiKey(null, log), log })
  if (!client.available) {
    console.log(`\nmodel unavailable (${client.reason}) — extraction shown above still applies`)
    return
  }

  const result = await client.classify(state, paneQuestions())
  if (!result.ok) {
    console.log(`\nclassify failed: ${result.errorKind} ${result.error || ''}`)
    return
  }

  console.log(`\n--- answers (${result.latencyMs}ms, ${result.usage && result.usage.input_tokens} input tokens) ---`)
  for (const [name, answer] of Object.entries(result.answers)) {
    if (answer.type === 'noul') console.log(`  ${name.padEnd(26)} ${answer.noul.toFixed(2)}`)
    else console.log(`  ${name.padEnd(26)} ${String(answer.choice).padEnd(22)} conf=${answer.confidence.toFixed(2)}`)
  }

  // The watcher's own thresholds: showing the default gate while it runs with a
  // configured one reports a verdict it would not reach.
  const { paneModelThresholds, readTmuxOption } = require('./lib/state-source')
  const interp = interpretPaneAnswers(result.answers, {
    agentType,
    currentPhase: session ? currentPhase(session) : null,
    thresholds: paneModelThresholds(readTmuxOption)
  })
  console.log(`\nverdict=${interp.verdict} gate=${interp.gate} phase=${interp.phase || 'null'} ` +
    `tool=${interp.activeTool || 'none'} resolvesWait=${interp.resolvesWait}`)
  if (interp.blockedReason) console.log(`blocked: ${interp.blockedReason}`)
  if (session) console.log(`session ${session.sessionId} currently ${currentPhase(session)}`)
}

// Compare what the model concluded against the phase the hooks had at that
// moment. Shadow mode exists to produce this table; a week of it is what turns
// "I am not sure the model reads screens well enough" into a number.
// Reads the per-call log, which only exists when @scout-jev-log-calls is on.
// The live aggregates in `watcher status` cover the current process; this covers
// history, which is the only place a slow drift in latency shows up.
function commandJevMetrics(args) {
  const sinceMs = parseDuration(args.since, 24 * 3600 * 1000)
  const agentFilter = args.agent ? String(args.agent).toLowerCase() : null
  const rows = readMetrics({ sinceMs })
    .filter(row => !agentFilter || String(row.agent).toLowerCase() === agentFilter)

  if (rows.length === 0) {
    // Said plainly, because "no calls logged" reads as "not running": this
    // command reads the per-call log only, which is off unless asked for,
    // while the live totals the watcher keeps are always there.
    const { readTmuxOption } = require('./lib/state-source')
    const logging = ['1', 'on', 'true', 'yes'].includes(String(readTmuxOption('@scout-jev-log-calls')).trim().toLowerCase())
    const live = (readJson(path.join(pathsFromArgs(args).statusDir, 'watcher-state.json'), {}).paneModel || {}).jev
    if (live && live.calls > 0) {
      console.log(`the pane model is running: ${live.calls} calls since the watcher started ` +
        `(live totals: \`scripts/setup.sh watcher status\`).`)
    }
    if (logging) {
      console.log(`per-call logging is on, but no calls were logged in the last ${args.since || '24h'}.`)
    } else {
      console.log('per-call logging is off, so there is no history to show here.')
      console.log('turn it on with `tmux set -g @scout-jev-log-calls on`; the watcher picks it up within 15s.')
    }
    return
  }

  const ok = rows.filter(row => row.ok)
  // A call that threw has ms: null, and Number(null) is a finite 0.
  const latencies = rows.map(row => row.ms).filter(Number.isFinite).sort((a, b) => a - b)
  const at = value => percentile(latencies, value)
  const tokens = ok.reduce((sum, row) => sum + (Number(row.inputTokens) || 0), 0)
  const spanMs = rows[rows.length - 1].at - rows[0].at
  const spanHours = spanMs / 3600000

  console.log(`jev calls  window=${args.since || '24h'}  span=${spanHours.toFixed(1)}h`)
  console.log(`  calls      ${rows.length} (${ok.length} ok, ${rows.length - ok.length} failed)`)
  console.log(`  latency    p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  max ${latencies[latencies.length - 1] || 0}ms`)
  console.log(`  tokens     ${tokens} in  (${ok.length ? Math.round(tokens / ok.length) : 0} per call)`)

  const cost = (tokens / 1e6) * USD_PER_INPUT_MTOK
  // Same floor as the live report: two rows a second apart extrapolate to a
  // monthly bill orders of magnitude off.
  console.log(spanMs < MIN_RATE_UPTIME_MS
    ? `  cost       $${cost.toFixed(4)}  (too short a span to project a rate)`
    : `  cost       $${cost.toFixed(4)}  ($${(cost / spanHours).toFixed(3)}/h, $${((cost / spanHours) * 24 * 30).toFixed(2)}/month at this rate)`)

  const failures = {}
  for (const row of rows) if (!row.ok) failures[row.error || 'unknown'] = (failures[row.error || 'unknown'] || 0) + 1
  const kinds = Object.entries(failures).sort((a, b) => b[1] - a[1])
  if (kinds.length > 0) console.log(`  failures   ${kinds.map(([kind, count]) => `${kind}=${count}`).join('  ')}`)

  const byAgent = {}
  for (const row of rows) byAgent[row.agent || 'unknown'] = (byAgent[row.agent || 'unknown'] || 0) + 1
  console.log(`  by agent   ${Object.entries(byAgent).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join('  ')}`)
}

// A session that has never been prompted is `idle` to the hooks and shows an
// empty composer, which the model reads as a finished turn. Both mean "waiting
// for the person to type", and scoring them as disagreement would count every
// fresh session against the model.
function phasesAgree(hookPhase, modelPhase) {
  if (hookPhase === modelPhase) return true
  return hookPhase === 'idle' && modelPhase === 'completed'
}

function commandPaneAgreement(args) {
  const sinceMs = parseDuration(args.since, 24 * 3600 * 1000)
  const agentFilter = args.agent ? String(args.agent).toLowerCase() : null
  const now = Date.now()

  // Read from the shadow log rather than from session records. Shadow mode
  // never touches a session — that is the whole point of it — so its readings
  // live in their own append-only file.
  //
  // Each row stands for the time until the next row for the same session,
  // capped at the heartbeat: the observer writes at least that often, so a
  // longer gap means it was not watching and the gap is not evidence. Weights
  // are taken over every row, rejected ones included, because a rejected
  // reading still ends the span of the one before it.
  const bySession = new Map()
  for (const row of readShadow({ sinceMs })) {
    if (!row) continue
    const id = row.sessionId || 'unknown'
    if (!bySession.has(id)) bySession.set(id, [])
    bySession.get(id).push(row)
  }

  const rows = []
  for (const sessionRows of bySession.values()) {
    sessionRows.sort((a, b) => a.at - b.at)
    sessionRows.forEach((row, i) => {
      const next = sessionRows[i + 1]
      const weightMs = Math.max(0, Math.min((next ? next.at : now) - row.at, SHADOW_HEARTBEAT_MS))
      if (row.gate !== 'accept') return
      if (agentFilter && String(row.agentType).toLowerCase() !== agentFilter) return
      rows.push({
        agent: row.agentType,
        // The phase the session held when the reading arrived is the hook's
        // answer to the same question at the same moment.
        hook: row.hookPhase || 'unknown',
        model: row.verdict,
        // Older rows predate modelPhase; the verdict's default mapping is the
        // best they can offer.
        modelPhase: row.modelPhase !== undefined ? row.modelPhase : (VERDICTS[row.verdict] || {}).phase,
        weightMs
      })
    })
  }

  if (rows.length === 0) {
    console.log(`no pane-model readings in the last ${args.since || '24h'}.`)
    console.log('Set `tmux set -g @scout-pane-model shadow` and let the watcher run.')
    return
  }

  const minutes = list => list.reduce((sum, row) => sum + row.weightMs, 0) / 60000
  const hooks = [...new Set(rows.map(row => row.hook))].sort()
  const models = [...new Set(rows.map(row => row.model))].sort()
  const width = Math.max(...hooks.map(name => name.length)) + 2

  console.log(`pane-model agreement  rows=${rows.length}  observed=${minutes(rows).toFixed(0)}min  window=${args.since || '24h'}`)
  console.log('\nminutes spent in each pair; rows = phase from hooks, columns = verdict from the model')
  console.log(''.padEnd(width) + models.map(name => name.slice(0, 11).padEnd(13)).join(''))
  for (const hook of hooks) {
    const cells = models.map(model =>
      minutes(rows.filter(row => row.hook === hook && row.model === model)).toFixed(1).padEnd(13))
    console.log(hook.padEnd(width) + cells.join(''))
  }

  // Only verdicts that map onto a phase can agree or disagree with one;
  // shell_prompt and unknown are deliberate silences, not predictions.
  const predictive = rows.filter(row => row.modelPhase)
  const agreeing = predictive.filter(row => phasesAgree(row.hook, row.modelPhase))
  const total = minutes(predictive)
  const share = total > 0 ? `${Math.round((minutes(agreeing) / total) * 100)}%` : 'n/a'
  console.log(`\nagreement ${share} of observed time (${minutes(agreeing).toFixed(0)}/${total.toFixed(0)} min)`)
  console.log(`silent (shell_prompt / unknown) ${minutes(rows.filter(row => !row.modelPhase)).toFixed(0)} min`)
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
  if (command === 'classify') return commandClassify(args)
  if (command === 'pane-agreement') return commandPaneAgreement(args)
  if (command === 'jev-metrics') return commandJevMetrics(args)
  throw new Error(`unknown debug command: ${command}`)
}

module.exports = {
  parseArgs,
  parseDuration,
  pathsFromArgs,
  eventForPhase,
  main
}

if (require.main === module) {
  const fail = error => {
    console.error(error.message)
    console.error('')
    console.error(usage())
    process.exit(1)
  }
  try {
    // `classify` is the one command that goes over the network, so main may
    // return a promise; every other command still returns undefined.
    const result = main()
    if (result && typeof result.catch === 'function') result.catch(fail)
  } catch (error) {
    fail(error)
  }
}
