#!/usr/bin/env node

const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { DEFAULT_TAIL_BYTES, readFileTail, readJsonlFile, readJsonlIncremental, splitJsonlLines } = require('../scripts/lib/jsonl-tail-reader')
const { applySessionEvent, currentPhase, PROTECTED_PHASE_MS } = require('../scripts/lib/session-state')
const { classifyCodexSession } = require('../scripts/lib/codex-session-classifier')
const { formatLine, getActiveSessions } = require('../scripts/picker/render')
const { agentDisplay, scoreAgentProcess } = require('../scripts/lib/agents')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../scripts/lib/hook-command')
const { markInterrupted: markClaudeInterrupted } = require('../scripts/lib/claude-transcript-watcher')
const sync = require('../scripts/picker/sync')
const { HOOK_EVENTS: CLAUDE_HOOK_EVENTS } = require('../scripts/setup/claude')
const { HOOK_MANAGERS, selectManagers, checkManagerHealth } = require('../scripts/setup/managers')
const claudeHook = require('../scripts/hooks/claude')
const codexHook = require('../scripts/hooks/codex')

const tests = []

function test(name, fn) {
  tests.push({ name, fn })
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-scout-test-'))
}

function runHook(scriptRelativePath, payload, homeDir) {
  execFileSync(process.execPath, [path.join(__dirname, '..', scriptRelativePath)], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      TMUX_PANE: '%1'
    }),
    stdio: ['pipe', 'ignore', 'pipe']
  })
}

function runScript(scriptRelativePath, args, homeDir) {
  execFileSync(process.execPath, [path.join(__dirname, '..', scriptRelativePath), ...args], {
    env: Object.assign({}, process.env, { HOME: homeDir }),
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

function runScriptOutput(scriptRelativePath, args, homeDir) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', scriptRelativePath), ...args], {
    env: Object.assign({}, process.env, { HOME: homeDir }),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function readScoutStatus(homeDir) {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.tmux-scout', 'status.json'), 'utf-8'))
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '')
}

function findScoutHookGroup(settings, event, matcher) {
  return (settings.hooks[event] || []).find(group => {
    return group &&
      group.matcher === matcher &&
      Array.isArray(group.hooks) &&
      group.hooks.some(hook => {
        return hook &&
          hook.type === 'command' &&
          typeof hook.command === 'string' &&
          hook.command.includes('scripts/hooks/claude.js')
      })
  })
}

function codexSessionDir(homeDir, date = new Date()) {
  return path.join(homeDir, '.codex', 'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'))
}

test('jsonl reader parses complete files and appends incrementally', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n')

    const full = readJsonlFile(file)
    assert.strictEqual(full.parsed, 2)
    assert.deepStrictEqual(full.objects.map(o => Object.keys(o)[0]), ['a', 'b'])

    const state = {}
    const initial = readJsonlIncremental(file, state, { maxInitialBytes: DEFAULT_TAIL_BYTES })
    assert.strictEqual(initial.changed, true)
    assert.strictEqual(initial.parsed, 2)
    assert.strictEqual(state.offset, fs.statSync(file).size)

    fs.appendFileSync(file, '{"c":3')
    const partial = readJsonlIncremental(file, state)
    assert.strictEqual(partial.changed, false)
    assert.strictEqual(partial.parsed, 0)

    fs.appendFileSync(file, '}\n')
    const appended = readJsonlIncremental(file, state)
    assert.strictEqual(appended.changed, true)
    assert.strictEqual(appended.parsed, 1)
    assert.deepStrictEqual(appended.objects[0], { c: 3 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('jsonl reader resets when files shrink', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '{"a":1}\n{"b":2}\n')
    const state = {}
    readJsonlIncremental(file, state)

    fs.writeFileSync(file, '{"c":3}\n')
    const reset = readJsonlIncremental(file, state)
    assert.strictEqual(reset.reset, true)
    assert.strictEqual(reset.parsed, 1)
    assert.deepStrictEqual(reset.objects[0], { c: 3 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('jsonl reader reports invalid JSONL rows', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'session.jsonl')
    fs.writeFileSync(file, '{"ok":true}\nnot-json\n')

    const full = readJsonlFile(file)
    assert.strictEqual(full.parsed, 1)
    assert.strictEqual(full.parseErrors, 1)

    const state = {}
    const incremental = readJsonlIncremental(file, state)
    assert.strictEqual(incremental.parsed, 1)
    assert.strictEqual(incremental.parseErrors, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('jsonl reader exposes reusable tail and line splitting helpers', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'tail.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ index: 1 }),
      '',
      JSON.stringify({ index: 2 }),
      JSON.stringify({ index: 3 })
    ].join('\n') + '\n')

    assert.deepStrictEqual(splitJsonlLines('\n{"a":1}\n\n{"b":2}\n'), ['{"a":1}', '{"b":2}'])
    const tail = readFileTail(file, 32)
    assert.ok(tail)
    assert.ok(tail.text.includes('"index":3'))
    assert.ok(Number.isFinite(tail.mtimeMs))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hook command helper wraps installed hooks with missing-file guard', () => {
  const hookPath = path.join(__dirname, '..', 'scripts', 'hooks', 'claude.js')
  const command = buildNodeHookCommand(hookPath)
  assert.ok(command.startsWith('[ -e '))
  assert.ok(command.includes(' || exit 0; node '))
  assert.strictEqual(extractHookPathFromCommand(command, 'claude.js'), hookPath)
})

test('hook scripts expose lightweight adapters', () => {
  assert.strictEqual(claudeHook.adapter.agentId, 'claude')
  assert.strictEqual(typeof claudeHook.adapter.handle, 'function')
  assert.strictEqual(codexHook.adapter.agentId, 'codex')
  assert.strictEqual(typeof codexHook.adapter.handlePayload, 'function')
  assert.strictEqual(typeof codexHook.adapter.handleArg, 'function')
})

test('setup manager registry selects agent managers by flags', () => {
  assert.deepStrictEqual(HOOK_MANAGERS.map(manager => manager.id), ['claude', 'codex'])
  assert.deepStrictEqual(selectManagers(new Set()).map(manager => manager.id), ['claude', 'codex'])
  assert.deepStrictEqual(selectManagers(new Set(['--claude'])).map(manager => manager.id), ['claude'])
  assert.deepStrictEqual(selectManagers(new Set(['--codex', '--quiet'])).map(manager => manager.id), ['codex'])
})

test('setup manager health normalizes partial hook states', () => {
  const claudeReport = checkManagerHealth({
    id: 'claude',
    label: 'Claude Code',
    module: {
      status: () => ({ installed: 12, total: 13, missing: ['Stop'] })
    }
  })
  assert.strictEqual(claudeReport.installed, false)
  assert.strictEqual(claudeReport.partial, true)
  assert.strictEqual(claudeReport.summary, '12/13 hooks installed')
  assert.deepStrictEqual(claudeReport.issues, ['Missing hooks: Stop'])

  const codexReport = checkManagerHealth({
    id: 'codex',
    label: 'Codex',
    module: {
      status: () => ({
        available: true,
        modern: {
          installed: false,
          installedEvents: 6,
          totalEvents: 6,
          missing: [],
          featuresEnabled: false,
          missingTrust: ['trust-key']
        },
        legacy: { installed: false }
      })
    }
  })
  assert.strictEqual(codexReport.installed, false)
  assert.strictEqual(codexReport.partial, true)
  assert.strictEqual(codexReport.summary, '6/6 event hooks installed')
  assert.ok(codexReport.issues.includes('Missing config: [features].hooks = true'))
  assert.ok(codexReport.issues.includes('Missing trust state entries: 1'))
})

test('agent registry provides display metadata and process scoring', () => {
  assert.deepStrictEqual(agentDisplay('codex'), { label: 'codex', color: '38;5;114' })
  assert.strictEqual(scoreAgentProcess({ basename: 'opencode', commandLine: '/usr/bin/opencode' }, 'opencode'), 100)
  assert.strictEqual(scoreAgentProcess({ basename: 'gh', commandLine: 'gh copilot suggest' }, 'copilot-cli'), 70)
  assert.strictEqual(scoreAgentProcess({ basename: 'node', commandLine: 'node /bin/gemini-cli' }, 'gemini'), 70)
})

test('session reducer protects recent high-confidence hook state', () => {
  const session = { sessionId: 's1', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 1000
  })

  assert.strictEqual(currentPhase(session), 'running')

  const ignored = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 2000,
    phase: 'completed',
    status: 'completed'
  })

  assert.strictEqual(ignored.applied, false)
  assert.strictEqual(currentPhase(session), 'running')

  const applied = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 1000 + PROTECTED_PHASE_MS + 1,
    phase: 'completed',
    status: 'completed'
  })

  assert.strictEqual(applied.applied, true)
  assert.strictEqual(currentPhase(session), 'completed')
})

test('session reducer does not let same-phase pane reads downgrade hook protection', () => {
  const session = { sessionId: 's1b', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 1000
  })

  const samePhase = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 2000,
    phase: 'running',
    status: 'working'
  })

  assert.strictEqual(samePhase.applied, false)
  assert.strictEqual(session.lifecycle.source, 'hook')
  assert.strictEqual(currentPhase(session), 'running')

  const completed = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 3000,
    phase: 'completed',
    status: 'completed'
  })

  assert.strictEqual(completed.applied, false)
  assert.strictEqual(currentPhase(session), 'running')
})

test('session reducer lets pane busy clear transcript-inferred waits', () => {
  const session = { sessionId: 's1c', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'transcript_status',
    source: 'transcript',
    timestamp: 1000,
    phase: 'waitingForApproval',
    status: 'needsAttention',
    attentionReason: 'waiting for approval'
  })

  const cleared = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 2000,
    phase: 'running',
    status: 'working'
  })

  assert.strictEqual(cleared.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.needsAttention, null)
})

test('session reducer applies attention and terminal events', () => {
  const session = { sessionId: 's2', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.status, 'working')
  assert.strictEqual(session.needsAttention, 'waiting for approval')
  assert.deepStrictEqual(session.pendingToolUse.tool, 'Bash')
  assert.strictEqual(session.activeTool, 'Bash')

  applySessionEvent(session, {
    type: 'process_exit_detected',
    source: 'pid',
    timestamp: 2000,
    reason: 'pid exited',
    force: true
  })

  assert.strictEqual(currentPhase(session), 'crashed')
  assert.strictEqual(session.status, 'crashed')
  assert.strictEqual(session.endedAt, 2000)
  assert.strictEqual(session.activeTool, null)
})

test('session reducer tracks active tool separately from pending approval state', () => {
  const session = { sessionId: 's2-tool', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Read', details: 'Read: package.json', timestamp: 1000 }
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.activeTool, 'Read')

  applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 2000,
    pendingToolUse: null
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
})

test('session reducer clears stale tool state for answer-only pane waits', () => {
  const session = { sessionId: 's2-answer', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })

  const answerWait = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 1000 + PROTECTED_PHASE_MS + 1,
    phase: 'waitingForAnswer',
    status: 'working',
    needsAttention: 'waiting for answer'
  })

  assert.strictEqual(answerWait.applied, true)
  assert.strictEqual(currentPhase(session), 'waitingForAnswer')
  assert.strictEqual(session.needsAttention, 'waiting for answer')
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
})

test('session reducer restores tool state for tool-backed answer waits', () => {
  const session = { sessionId: 's2-tool-answer', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })

  applySessionEvent(session, {
    type: 'question_asked',
    source: 'hook',
    timestamp: 2000,
    attentionReason: 'waiting for answer',
    pendingToolUse: { tool: 'AskUserQuestion', details: 'AskUserQuestion: continue?', timestamp: 2000 }
  })

  assert.strictEqual(currentPhase(session), 'waitingForAnswer')
  assert.strictEqual(session.needsAttention, 'waiting for answer')
  assert.strictEqual(session.pendingToolUse.tool, 'AskUserQuestion')
  assert.strictEqual(session.activeTool, 'AskUserQuestion')
})

test('session reducer does not reopen crashed sessions with late interrupted transcript events', () => {
  const session = { sessionId: 's2b', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 1000
  })
  applySessionEvent(session, {
    type: 'process_exit_detected',
    source: 'pid',
    timestamp: 2000,
    reason: 'pid exited',
    force: true
  })

  const interrupted = applySessionEvent(session, {
    type: 'interrupted',
    source: 'transcript',
    timestamp: 3000,
    reason: 'late turn_aborted'
  })

  assert.strictEqual(interrupted.applied, false)
  assert.strictEqual(currentPhase(session), 'crashed')
  assert.strictEqual(session.status, 'crashed')
  assert.strictEqual(session.endedAt, 2000)
})

test('claude setup registers monitored official hook events', () => {
  assert.deepStrictEqual(CLAUDE_HOOK_EVENTS, [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'SessionEnd'
  ])
})

test('claude setup installs failure and permission hooks without deleting user hooks', () => {
  const dir = tempDir()
  try {
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const scoutCommand = `node "${path.join(__dirname, '..', 'scripts', 'hooks', 'claude.js')}"`
    const settingsPath = path.join(claudeDir, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PermissionRequest: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: scoutCommand, timeout: 5 },
              { type: 'command', command: 'echo keep-me' }
            ]
          }
        ],
        PostToolUseFailure: [
          { matcher: '', hooks: [{ type: 'command', command: scoutCommand, timeout: 5 }] }
        ],
        StopFailure: [
          { matcher: '', hooks: [{ type: 'command', command: scoutCommand, timeout: 5 }] }
        ]
      }
    }, null, 2))

    runScript('scripts/setup/claude.js', ['install'], dir)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const permissionGroup = findScoutHookGroup(settings, 'PermissionRequest', '*')
    assert.ok(permissionGroup)
    assert.ok(permissionGroup.hooks.some(hook => hook.command.startsWith('[ -e ')))
    assert.ok(findScoutHookGroup(settings, 'PostToolUseFailure', '*'))
    assert.ok(findScoutHookGroup(settings, 'StopFailure', ''))
    assert.ok(settings.hooks.PermissionRequest.some(group => {
      return Array.isArray(group.hooks) && group.hooks.some(hook => hook.command === 'echo keep-me')
    }))
    for (const event of CLAUDE_HOOK_EVENTS) {
      assert.ok(settings.hooks[event], `${event} hook missing`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unified setup reports Claude permission hooks as installed or updated', () => {
  const dir = tempDir()
  try {
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const scoutCommand = `node "${path.join(__dirname, '..', 'scripts', 'hooks', 'claude.js')}"`
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      hooks: {
        PermissionRequest: [
          { matcher: '', hooks: [{ type: 'command', command: scoutCommand, timeout: 5 }] }
        ]
      }
    }, null, 2))

    const output = stripAnsi(runScriptOutput('scripts/setup.js', ['install', '--claude'], dir))
    assert.ok(/PermissionRequest\s+(path updated|hook installed)/.test(output))
    assert.ok(!/PermissionRequest\s+legacy hook removed/.test(output))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex setup upgrades legacy notify hook to guarded shell command', () => {
  const dir = tempDir()
  try {
    const codexDir = path.join(dir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })
    const hookPath = path.join(__dirname, '..', 'scripts', 'hooks', 'codex.js')
    const configPath = path.join(codexDir, 'config.toml')
    fs.writeFileSync(configPath, `notify = [\n  "node",\n  "${hookPath}"\n]\n`)

    runScript('scripts/setup/codex.js', ['install'], dir)

    const config = fs.readFileSync(configPath, 'utf-8')
    assert.ok(config.includes('"sh"'))
    assert.ok(config.includes('test -e \\"$1\\" || exit 0; exec node \\"$1\\" \\"$2\\"'))
    assert.ok(config.includes(hookPath))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session reducer keeps interrupted turns eligible for sync', () => {
  const session = { sessionId: 's3', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 1000
  })

  applySessionEvent(session, {
    type: 'interrupted',
    source: 'transcript',
    timestamp: 2000,
    reason: 'user interrupted'
  })

  assert.strictEqual(currentPhase(session), 'interrupted')
  assert.strictEqual(session.status, 'interrupted')
  assert.strictEqual(session.endedAt, null)

  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'transcript',
    timestamp: 3000
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.endedAt, null)
})

test('sync marks running Claude session interrupted from transcript marker', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-transcript-interrupt'
    const transcriptPath = path.join(dir, 'claude-transcript.jsonl')
    fs.writeFileSync(transcriptPath, '')
    runHook('scripts/hooks/claude.js', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath,
      prompt: 'keep going'
    }, dir)
    fs.appendFileSync(transcriptPath, JSON.stringify({
      timestamp: new Date(Date.now() + 1000).toISOString(),
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '[Request interrupted by user]' }]
      }
    }) + '\n')

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    const result = sync.run(statusFile, {
      codexMode: 'none',
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false
    })
    const session = result.status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'interrupted')
    assert.strictEqual(session.status, 'interrupted')
    assert.strictEqual(session.endedAt, null)
    assert.strictEqual(session.lastEvent.type, 'interrupted')
    assert.strictEqual(result.stats.claudeTranscript.filesRead, 1)
    assert.strictEqual(result.stats.claudeTranscript.interrupted, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('render prefers active sessions over newer completed sessions in the same pane', () => {
  const now = Date.now()
  const pane = {
    paneId: '%1',
    currentCommand: 'node',
    paneDead: false,
    windowName: 'main'
  }
  const active = getActiveSessions({
    sessions: {
      done: {
        sessionId: 'done',
        agentType: 'codex',
        status: 'completed',
        phase: 'completed',
        tmuxPane: '%1',
        lastUpdated: now
      },
      review: {
        sessionId: 'review',
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        tmuxPane: '%1',
        lastUpdated: now - 1000
      }
    }
  }, new Map([['%1', pane]]))

  assert.deepStrictEqual(active.map(session => session.sessionId), ['review'])
})

test('render prefers newer foreground busy session over stale wait in the same pane', () => {
  const now = Date.now()
  const pane = {
    paneId: '%1',
    currentCommand: 'node',
    paneDead: false,
    windowName: 'main'
  }
  const active = getActiveSessions({
    sessions: {
      staleWait: {
        sessionId: 'staleWait',
        agentType: 'codex',
        status: 'working',
        phase: 'waitingForApproval',
        needsAttention: 'waiting for approval',
        tmuxPane: '%1',
        lastHookAt: now - 600000,
        lastUpdated: now,
        lastEvent: { type: 'pane_state', timestamp: now }
      },
      busy: {
        sessionId: 'busy',
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        needsAttention: null,
        tmuxPane: '%1',
        lastHookAt: now - 1000,
        lastUpdated: now - 1000,
        lastEvent: { type: 'tool_use', timestamp: now - 1000 }
      }
    }
  }, new Map([['%1', pane]]))

  assert.deepStrictEqual(active.map(session => session.sessionId), ['busy'])
})

test('claude transcript watcher helper marks running sessions interrupted', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    const sessionsDir = path.join(scoutDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const sessionId = 'claude-watch-interrupt'
    const transcriptPath = path.join(dir, 'claude-watch.jsonl')
    const now = Date.now()
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: new Date(now + 1000).toISOString(),
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }]
      }
    }) + '\n')

    const session = {
      sessionId,
      agentType: 'claude',
      status: 'working',
      phase: 'running',
      startedAt: now - 1000,
      lastUpdated: now,
      endedAt: null,
      transcriptPath
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: { [sessionId]: session }
    }, null, 2))

    assert.strictEqual(markClaudeInterrupted(statusFile, sessionId), true)
    const updated = JSON.parse(fs.readFileSync(statusFile, 'utf-8')).sessions[sessionId]
    assert.strictEqual(currentPhase(updated), 'interrupted')
    assert.strictEqual(updated.status, 'interrupted')
    assert.strictEqual(updated.endedAt, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook keeps AskUserQuestion PreToolUse in answer-wait state', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-question'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask me first'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '继续吗？' }] }
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for answer')
    assert.strictEqual(session.activeTool, 'AskUserQuestion')
    assert.strictEqual(session.lastEvent.type, 'question_asked')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook records PermissionRequest as approval wait', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-permission'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.details, 'Bash: npm test')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.lastEvent.type, 'permission_request')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook clears approval wait on PostToolUseFailure', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-tool-failure'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      error: 'exit code 1'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastToolError, 'exit code 1')
    assert.strictEqual(session.lastEvent.type, 'post_tool_use_failure')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook records StopFailure as completed with error detail', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-stop-failure'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'summarize'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'StopFailure',
      error: 'stop_failed',
      error_details: 'model stream ended unexpectedly'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.error, 'stop_failed')
    assert.strictEqual(session.errorDetail, 'model stream ended unexpectedly')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, 'stop_failure')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook resets lifecycle on clear but preserves compact starts', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-clear'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'make a plan'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do it' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'compact'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'clear'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'idle')
    assert.strictEqual(session.status, 'idle')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.lastEvent.type, 'session_start')
    assert.strictEqual(session.lastEvent.details, 'clear')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook records metadata-only official events without changing active state', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-metadata'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'keep working'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStart'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStop'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Notification',
      message: 'Permission prompt shown'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreCompact',
      trigger: 'manual'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.lastNotification, 'Permission prompt shown')
    assert.strictEqual(session.lastCompactReason, 'manual')
    assert.strictEqual(session.lastEvent.type, 'pre_compact')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook treats question-like Stop messages as waiting for answer', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-question'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'help me choose'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: '请选择一个方案？\n1. A\n2. B'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for answer')
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, 'question_asked')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook does not treat normal completed answers with question marks as input wait', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-completed-question-text'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'summarize completed work'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: [
        'Completed the update.',
        '- Preserved query strings like /search?q=test.',
        '- Kept the quoted question "what changed?" in the docs.',
        'Anything else?'
      ].join('\n')
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.lastEvent.type, 'stop')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex classifier hides internal background prompts', () => {
  const classification = classifyCodexSession({
    prompt: [
      'You are a helpful assistant. Generate a pull request title and body.',
      'Write the result into the structured response fields title and body.'
    ].join('\n')
  })

  assert.strictEqual(classification.hidden, true)
  assert.strictEqual(classification.isInternal, true)
  assert.strictEqual(classification.reason, 'codex-pr-metadata')
})

test('codex classifier keeps standalone review sessions visible', () => {
  const classification = classifyCodexSession({
    sessionMeta: {
      id: 'codex-review',
      source: { subagent: 'review' }
    }
  })

  assert.strictEqual(classification.hidden, false)
  assert.strictEqual(classification.isInternal, false)
  assert.strictEqual(classification.isSubagent, false)
})

test('codex hook marks internal background sessions hidden', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-internal-pr'
    runHook('scripts/hooks/codex.js', {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      prompt: 'You are a helpful assistant. Generate a pull request title and body.'
    }, dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(session.isInternalCodexSession, true)
    assert.strictEqual(session.hiddenReason, 'codex-pr-metadata')
    assert.deepStrictEqual(getActiveSessions(status, new Map()), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook keeps standalone review sessions visible and working', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-review'
    const transcriptPath = path.join(dir, 'review-rollout.jsonl')
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        source: { subagent: 'review' }
      }
    }) + '\n')

    const base = {
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath
    }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the current diff'
    }), dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.notStrictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.deepStrictEqual(
      getActiveSessions(status, new Map([['%1', {
        paneId: '%1',
        currentCommand: 'node',
        paneDead: false,
        windowName: 'main'
      }]])).map(item => item.sessionId),
      [sessionId]
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex legacy notify classifies full prompt before title truncation', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-legacy-title-worker'
    runHook('scripts/hooks/codex.js', {
      type: 'agent-turn-complete',
      'thread-id': sessionId,
      'turn-id': 'turn-1',
      cwd: '/tmp/demo',
      'input-messages': [{
        role: 'user',
        content: [
          'Generate a short title for a task.',
          'Return only the title.',
          '',
          'User prompt:',
          'Please inspect the repository and explain the first issue.'
        ].join('\n')
      }],
      'last-assistant-message': 'Inspect repo issue'
    }, dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(session.isInternalCodexSession, true)
    assert.strictEqual(session.hiddenReason, 'codex-title-generation')
    assert.deepStrictEqual(getActiveSessions(status, new Map()), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook reads transcript session_meta from first line of large transcript', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-large-transcript-subagent'
    const transcriptPath = path.join(dir, 'large-rollout.jsonl')
    const firstLine = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        forked_from_id: 'parent-session'
      }
    })
    fs.writeFileSync(transcriptPath, firstLine + '\n' + 'x'.repeat(2 * 1024 * 1024))

    runHook('scripts/hooks/codex.js', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath
    }, dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(session.isCodexSubagent, true)
    assert.strictEqual(session.hiddenReason, 'codex-subagent')
    assert.strictEqual(session.parentSessionId, 'parent-session')
    assert.deepStrictEqual(getActiveSessions(status, new Map()), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hidden subagents are summarized on parent picker rows', () => {
  const dir = tempDir()
  try {
    const parentId = 'codex-parent'
    const childId = 'codex-child-subagent'
    const parentBase = { session_id: parentId, thread_id: parentId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, parentBase, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, parentBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the change'
    }), dir)

    const transcriptPath = path.join(dir, 'child-rollout.jsonl')
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: childId,
        forked_from_id: parentId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              depth: 1,
              agent_nickname: 'reviewer'
            }
          }
        }
      }
    }) + '\n')

    const childBase = {
      session_id: childId,
      thread_id: childId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath
    }
    runHook('scripts/hooks/codex.js', Object.assign({}, childBase, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, childBase, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let status = readScoutStatus(dir)
    const parent = status.sessions[parentId]
    const child = status.sessions[childId]
    assert.strictEqual(child.isHiddenFromScout, true)
    assert.strictEqual(child.isCodexSubagent, true)
    assert.strictEqual(parent.activeSubagents.length, 1)
    assert.strictEqual(parent.activeSubagents[0].agentId, childId)
    assert.strictEqual(parent.activeSubagents[0].nickname, 'reviewer')
    assert.strictEqual(parent.activeSubagents[0].lastToolActivity, 'Bash: npm test')

    const pane = {
      paneId: '%1',
      currentCommand: 'node',
      paneDead: false,
      windowName: 'main'
    }
    assert.deepStrictEqual(
      getActiveSessions(status, new Map([['%1', pane]])).map(session => session.sessionId),
      [parentId]
    )
    parent._tmuxPaneSnapshot = pane
    const line = stripAnsi(formatLine(parent, Date.now(), '%1'))
    assert.ok(/1 subagent · reviewer: Bash: npm test/.test(line), line)

    runHook('scripts/hooks/codex.js', Object.assign({}, childBase, {
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)
    status = readScoutStatus(dir)
    assert.deepStrictEqual(status.sessions[parentId].activeSubagents, [])
    status.sessions[parentId]._tmuxPaneSnapshot = pane
    assert.ok(!stripAnsi(formatLine(status.sessions[parentId], Date.now(), '%1')).includes('subagent'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex jsonl discovery keeps standalone review sessions visible', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const now = new Date()
    const sessionDir = codexSessionDir(dir, now)
    fs.mkdirSync(sessionDir, { recursive: true })
    const threadId = '55555555-5555-4555-8555-555555555555'
    const file = path.join(sessionDir, `rollout-${threadId}.jsonl`)
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: threadId,
          source: { subagent: 'review' }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: now.toISOString(),
        payload: { type: 'user_message', message: 'review the current diff' }
      })
    ].join('\n') + '\n')

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    const session = result.status.sessions[threadId]
    assert.ok(session)
    assert.notStrictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex jsonl discovery skips subagent sessions by default', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const now = new Date()
    const sessionDir = codexSessionDir(dir, now)
    fs.mkdirSync(sessionDir, { recursive: true })
    const threadId = '11111111-1111-4111-8111-111111111111'
    const file = path.join(sessionDir, `rollout-${threadId}.jsonl`)
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: threadId,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: '22222222-2222-4222-8222-222222222222',
                depth: 1,
                agent_nickname: 'worker'
              }
            }
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: now.toISOString(),
        payload: { type: 'user_message', message: 'inspect files' }
      })
    ].join('\n') + '\n')

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    const result = sync.run(statusFile)
    assert.deepStrictEqual(Object.keys(result.status.sessions), [])
    assert.strictEqual(fs.existsSync(statusFile), false)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function main() {
  let failed = 0

  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failed++
      console.error(`not ok - ${name}`)
      console.error(error && error.stack ? error.stack : error)
    }
  }

  console.log()
  console.log(`${tests.length - failed}/${tests.length} tests passed.`)
  if (failed > 0) process.exit(1)
}

main()
