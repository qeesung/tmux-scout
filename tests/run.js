#!/usr/bin/env node

const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

const { DEFAULT_TAIL_BYTES, readFileTail, readJsonlFile, readJsonlIncremental, splitJsonlLines } = require('../scripts/lib/jsonl-tail-reader')
const { applySessionEvent, currentPhase, PROTECTED_PHASE_MS } = require('../scripts/lib/session-state')
const { classifyCodexSession } = require('../scripts/lib/codex-session-classifier')
const { formatLine, getActiveSessions } = require('../scripts/picker/render')
const { agentDisplay, scoreAgentProcess } = require('../scripts/lib/agents')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../scripts/lib/hook-command')
const { createHookContext, defaultPaths } = require('../scripts/lib/hook-adapter')
const { resolveAgentProcess } = require('../scripts/lib/terminal-context')
const { startBridgeServer } = require('../scripts/lib/bridge-server')
const { markInterrupted: markClaudeInterrupted, ClaudeTranscriptWatchManager } = require('../scripts/lib/claude-transcript-watcher')
const { startOptionalBridge, optionEnabled: watcherOptionEnabled } = require('../scripts/watcher')
const { AGENT_EVENTS, normalizeAgentEventType, createAgentEvent } = require('../scripts/lib/agent-events')
const {
  SESSION_CONTRACT_VERSION,
  SESSION_PHASES,
  phaseFromLegacyStatus,
  phaseForAgentEvent,
  statusForPhase,
  validateAgentEvent,
  validateSessionSnapshot
} = require('../scripts/lib/session-contract')
const { findLatestCodexInterrupt } = require('../scripts/lib/codex-transcript-detector')
const { formatSessionDetails } = require('../scripts/picker/session-details')
const statusBar = require('../scripts/status-bar')
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

function runGenericHook(agent, payload, homeDir, extraArgs = []) {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/hooks/generic.js'), '--agent', agent, ...extraArgs], {
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

test('codex transcript detector matches interrupted turns by id or timestamp', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'codex.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(1000).toISOString(),
        payload: { type: 'turn_aborted', turn_id: 'old-turn', reason: 'interrupted' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(3000).toISOString(),
        payload: { type: 'turn_aborted', turn_id: 'current-turn', reason: 'interrupted' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(4000).toISOString(),
        payload: { type: 'turn_aborted', turn_id: 'ignored', reason: 'other' }
      })
    ].join('\n') + '\n')

    const byTurn = findLatestCodexInterrupt(file, { expectTurnId: 'current-turn' })
    assert.strictEqual(byTurn.turnId, 'current-turn')
    assert.strictEqual(byTurn.abortedAtMs, 3000)

    const byTime = findLatestCodexInterrupt(file, { minTimestampMs: 2000 })
    assert.strictEqual(byTime.turnId, 'current-turn')
    assert.strictEqual(findLatestCodexInterrupt(file, { expectTurnId: 'missing' }), null)
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
  assert.deepStrictEqual(HOOK_MANAGERS.map(manager => manager.id), ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli', 'opencode'])
  assert.deepStrictEqual(selectManagers(new Set()).map(manager => manager.id), ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli', 'opencode'])
  assert.deepStrictEqual(selectManagers(new Set(['--claude'])).map(manager => manager.id), ['claude'])
  assert.deepStrictEqual(selectManagers(new Set(['--codex', '--quiet'])).map(manager => manager.id), ['codex'])
  assert.deepStrictEqual(selectManagers(new Set(['--copilot-cli'])).map(manager => manager.id), ['copilot-cli'])
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

test('shell entrypoints pass bash syntax checks', () => {
  for (const file of [
    'tmux-scout.tmux',
    'scripts/picker/picker.sh',
    'scripts/status-widget.sh',
    'scripts/setup.sh'
  ]) {
    execFileSync('bash', ['-n', path.join(__dirname, '..', file)], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
  }
})

test('Gemini and Copilot setup managers install guarded generic hooks', () => {
  const dir = tempDir()
  try {
    runScript('scripts/setup/gemini.js', ['install'], dir)
    const geminiSettings = JSON.parse(fs.readFileSync(path.join(dir, '.gemini', 'settings.json'), 'utf-8'))
    assert.ok(geminiSettings.hooks.BeforeAgent[0].hooks[0].command.includes('scripts/hooks/generic.js'))
    assert.ok(geminiSettings.hooks.BeforeAgent[0].hooks[0].command.includes('--agent'))
    assert.ok(geminiSettings.hooks.BeforeAgent[0].hooks[0].command.includes('gemini'))
    assert.strictEqual(geminiSettings.hooks.BeforeAgent[0].hooks[0].timeout, 5000)

    runScript('scripts/setup/copilot-cli.js', ['install'], dir)
    const copilotSettings = JSON.parse(fs.readFileSync(path.join(dir, '.copilot', 'settings.json'), 'utf-8'))
    assert.strictEqual(copilotSettings.version, 1)
    assert.ok(copilotSettings.hooks.preToolUse[0].bash.includes('--event'))
    assert.ok(copilotSettings.hooks.preToolUse[0].bash.includes('preToolUse'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Gemini setup preserves non-Scout hooks in shared matcher groups', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        BeforeAgent: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: 'echo keep', timeout: 1 },
              { type: 'command', command: 'node /old/tmux-scout/scripts/hooks/generic.js --agent gemini', timeout: 5 }
            ]
          }
        ]
      }
    }, null, 2) + '\n')

    runScript('scripts/setup/gemini.js', ['install'], dir)
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    let beforeAgentHooks = settings.hooks.BeforeAgent.flatMap(group => group.hooks || [])
    assert.ok(beforeAgentHooks.some(hook => hook.command === 'echo keep'))
    assert.strictEqual(beforeAgentHooks.filter(hook => String(hook.command || '').includes('scripts/hooks/generic.js')).length, 1)
    assert.strictEqual(beforeAgentHooks.find(hook => String(hook.command || '').includes('scripts/hooks/generic.js')).timeout, 5000)

    runScript('scripts/setup/gemini.js', ['uninstall'], dir)
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    beforeAgentHooks = settings.hooks.BeforeAgent.flatMap(group => group.hooks || [])
    assert.ok(beforeAgentHooks.some(hook => hook.command === 'echo keep'))
    assert.ok(!beforeAgentHooks.some(hook => String(hook.command || '').includes('scripts/hooks/generic.js')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Gemini setup surfaces invalid existing settings instead of overwriting', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.gemini', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ invalid json')

    let error = null
    try {
      runScript('scripts/setup/gemini.js', ['install'], dir)
    } catch (caught) {
      error = caught
    }

    assert.ok(error, 'install should fail on invalid existing settings')
    assert.ok(String(error.stderr || '').includes('Failed to read'))
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf-8'), '{ invalid json')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Copilot setup surfaces invalid existing settings instead of overwriting', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.copilot', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ invalid json')

    let error = null
    try {
      runScript('scripts/setup/copilot-cli.js', ['install'], dir)
    } catch (caught) {
      error = caught
    }

    assert.ok(error, 'install should fail on invalid existing settings')
    assert.ok(String(error.stderr || '').includes('Failed to read'))
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf-8'), '{ invalid json')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session reducer stamps the state contract and current turn lifecycle', () => {
  const session = { sessionId: 'turn-contract', agentType: 'codex', startedAt: 500 }

  applySessionEvent(session, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'hook',
    timestamp: 1000,
    details: 'run tests',
    turnId: 'turn-1'
  })
  assert.strictEqual(session.stateContractVersion, SESSION_CONTRACT_VERSION)
  assert.strictEqual(currentPhase(session), SESSION_PHASES.RUNNING)
  assert.strictEqual(session.currentTurnId, 'turn-1')
  assert.strictEqual(session.lastTurnId, 'turn-1')
  assert.strictEqual(session.turnStartedAt, 1000)
  assert.strictEqual(session.turnEndedAt, null)

  applySessionEvent(session, {
    type: AGENT_EVENTS.TOOL_USE,
    source: 'hook',
    timestamp: 1200,
    activeTool: 'Read',
    details: 'Read package.json',
    turnId: 'turn-1'
  })
  assert.strictEqual(session.currentTurnId, 'turn-1')
  assert.strictEqual(session.turnStartedAt, 1000)
  assert.strictEqual(session.activeTool, 'Read')

  applySessionEvent(session, {
    type: AGENT_EVENTS.STOP,
    source: 'hook',
    timestamp: 2000,
    turnId: 'turn-1'
  })
  assert.strictEqual(currentPhase(session), SESSION_PHASES.COMPLETED)
  assert.strictEqual(session.currentTurnId, 'turn-1')
  assert.strictEqual(session.lastTurnId, 'turn-1')
  assert.strictEqual(session.turnStartedAt, 1000)
  assert.strictEqual(session.turnEndedAt, 2000)
  assert.strictEqual(session.activeTool, null)
  assert.strictEqual(session.pendingInteraction, null)

  const validation = validateSessionSnapshot(session)
  assert.strictEqual(validation.valid, true)
  assert.deepStrictEqual(validation.errors, [])
  assert.deepStrictEqual(validation.warnings, [])
})

test('session reducer ends turn lifecycle when hooks omit turn ids', () => {
  for (const type of [AGENT_EVENTS.STOP, AGENT_EVENTS.SESSION_END]) {
    const session = { sessionId: `turn-no-id-${type}`, agentType: 'claude', startedAt: 500 }

    applySessionEvent(session, {
      type: AGENT_EVENTS.PROMPT_SUBMIT,
      source: 'hook',
      timestamp: 1000,
      details: 'run tests'
    })
    assert.strictEqual(currentPhase(session), SESSION_PHASES.RUNNING)
    assert.strictEqual(session.currentTurnId, null)
    assert.strictEqual(session.turnStartedAt, 1000)
    assert.strictEqual(session.turnEndedAt, null)

    applySessionEvent(session, {
      type,
      source: 'hook',
      timestamp: 2000
    })
    assert.strictEqual(currentPhase(session), SESSION_PHASES.COMPLETED)
    assert.strictEqual(session.currentTurnId, null)
    assert.strictEqual(session.turnStartedAt, 1000)
    assert.strictEqual(session.turnEndedAt, 2000)
  }
})

test('session reducer keeps a full interaction flow inside the session contract', () => {
  const session = { sessionId: 'contract-flow', agentType: 'codex', startedAt: 1000 }
  const events = [
    {
      type: AGENT_EVENTS.PROMPT_SUBMIT,
      source: 'hook',
      timestamp: 1000,
      details: 'deploy',
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.TOOL_USE,
      source: 'hook',
      timestamp: 1100,
      details: 'Bash: npm test',
      activeTool: 'Bash',
      pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1100 },
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.PERMISSION_REQUEST,
      source: 'hook',
      timestamp: 1200,
      attentionReason: 'waiting for approval',
      details: 'Bash: npm test',
      activeTool: 'Bash',
      pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1200 },
      requestId: 'permission-1',
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.PERMISSION_RESOLVED,
      source: 'hook',
      timestamp: 1300,
      activeTool: 'Bash',
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.QUESTION_ASKED,
      source: 'hook',
      timestamp: 1400,
      attentionReason: 'waiting for answer',
      details: 'AskUserQuestion: continue?',
      activeTool: 'AskUserQuestion',
      pendingToolUse: { tool: 'AskUserQuestion', details: 'AskUserQuestion: continue?', timestamp: 1400 },
      requestId: 'question-1',
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.QUESTION_ANSWERED,
      source: 'hook',
      timestamp: 1500,
      turnId: 'turn-flow'
    },
    {
      type: AGENT_EVENTS.STOP,
      source: 'hook',
      timestamp: 1600,
      turnId: 'turn-flow'
    }
  ]

  for (const event of events) {
    const result = applySessionEvent(session, event)
    assert.strictEqual(result.applied, true)
    const validation = validateSessionSnapshot(session)
    assert.strictEqual(validation.valid, true, validation.errors.join('; '))
    assert.deepStrictEqual(validation.errors, [])
    assert.deepStrictEqual(validation.warnings, [])
  }

  assert.strictEqual(currentPhase(session), SESSION_PHASES.COMPLETED)
  assert.strictEqual(session.currentTurnId, 'turn-flow')
  assert.strictEqual(session.turnStartedAt, 1000)
  assert.strictEqual(session.turnEndedAt, 1600)
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
  assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_REQUEST))
  assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.QUESTION_ASKED))
})

test('Kimi setup manager appends and removes managed TOML hook blocks', () => {
  const dir = tempDir()
  try {
    const configPath = path.join(dir, '.kimi', 'config.toml')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model = "kimi"',
      '',
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      'command = "echo keep"',
      '',
      '[[hooks]]',
      'event = "Stop"',
      'command = "node /old/tmux-scout/scripts/hooks/generic.js --agent kimi"',
      '',
      '[ui]',
      'theme = "dark"',
      ''
    ].join('\n'))

    runScript('scripts/setup/kimi.js', ['install'], dir)
    let content = fs.readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('command = "echo keep"'))
    assert.ok(content.includes('[ui]'))
    assert.ok(content.includes('theme = "dark"'))
    assert.ok(content.includes('scripts/hooks/generic.js'))
    assert.ok(content.includes('event = "PreToolUse"'))

    runScript('scripts/setup/kimi.js', ['uninstall'], dir)
    content = fs.readFileSync(configPath, 'utf-8')
    assert.ok(content.includes('command = "echo keep"'))
    assert.ok(content.includes('[ui]'))
    assert.ok(content.includes('theme = "dark"'))
    assert.ok(!content.includes('scripts/hooks/generic.js'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode setup status rejects stale plugin hook paths', () => {
  const dir = tempDir()
  try {
    runScript('scripts/setup/opencode.js', ['install'], dir)
    const pluginFile = path.join(dir, '.config', 'opencode', 'plugins', 'tmux-scout-opencode-plugin.js')
    const pluginContent = fs.readFileSync(pluginFile, 'utf-8')
    const stalePluginContent = pluginContent.replace(
      /const HOOK_PATH = .*;/,
      'const HOOK_PATH = "/missing/tmux-scout/scripts/hooks/generic.js";'
    )
    assert.notStrictEqual(stalePluginContent, pluginContent)
    fs.writeFileSync(pluginFile, stalePluginContent)

    const output = runScriptOutput('scripts/setup/opencode.js', ['status'], dir)
    assert.ok(output.includes('plugin not installed'))

    let error = null
    try {
      runScript('scripts/setup.js', ['status', '--opencode', '--quiet', '--any'], dir)
    } catch (caught) {
      error = caught
    }
    assert.ok(error, 'broken OpenCode plugin should not satisfy --any status')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode setup status rejects stale plugin config refs', () => {
  const dir = tempDir()
  try {
    runScript('scripts/setup/opencode.js', ['install'], dir)
    const configPath = path.join(dir, '.config', 'opencode', 'opencode.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    config.plugin = [`file://${path.join(dir, 'old', 'tmux-scout-opencode-plugin.js')}`]
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

    const output = runScriptOutput('scripts/setup/opencode.js', ['status'], dir)
    assert.ok(output.includes('plugin not installed'))

    let error = null
    try {
      runScript('scripts/setup.js', ['status', '--opencode', '--quiet', '--any'], dir)
    } catch (caught) {
      error = caught
    }
    assert.ok(error, 'stale OpenCode plugin ref should not satisfy --any status')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode setup surfaces invalid existing config instead of overwriting', () => {
  const dir = tempDir()
  try {
    const configPath = path.join(dir, '.config', 'opencode', 'opencode.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, '{ invalid json')

    let error = null
    try {
      runScript('scripts/setup/opencode.js', ['install'], dir)
    } catch (caught) {
      error = caught
    }

    assert.ok(error, 'install should fail on invalid existing config')
    assert.ok(String(error.stderr || '').includes('Failed to read'))
    assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), '{ invalid json')
    assert.ok(!fs.existsSync(path.join(dir, '.config', 'opencode', 'plugins', 'tmux-scout-opencode-plugin.js')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('new setup managers do not report standalone uninstall as installed', () => {
  const dir = tempDir()
  try {
    for (const script of [
      'scripts/setup/gemini.js',
      'scripts/setup/kimi.js',
      'scripts/setup/copilot-cli.js',
      'scripts/setup/opencode.js'
    ]) {
      const output = runScriptOutput(script, ['uninstall'], dir)
      assert.ok(!/hook installed|plugin installed/.test(output), `${script} reported installed after uninstall`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unified quiet any status accepts new-agent-only installs', () => {
  const dir = tempDir()
  try {
    runScript('scripts/setup/gemini.js', ['install'], dir)
    runScript('scripts/setup.js', ['status', '--quiet', '--any'], dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('agent registry provides display metadata and process scoring', () => {
  assert.deepStrictEqual(agentDisplay('codex'), { label: 'codex', color: '38;5;114' })
  assert.strictEqual(scoreAgentProcess({ basename: 'opencode', commandLine: '/usr/bin/opencode' }, 'opencode'), 100)
  assert.strictEqual(scoreAgentProcess({ basename: 'gh', commandLine: 'gh copilot suggest' }, 'copilot-cli'), 70)
  assert.strictEqual(scoreAgentProcess({ basename: 'node', commandLine: 'node /bin/gemini-cli' }, 'gemini'), 70)
})

test('hook runtime resolves the real agent pid from the hook parent chain', () => {
  const processes = [
    { pid: 100, ppid: 1, command: '/opt/homebrew/bin/codex', args: 'codex', commandLine: 'codex', basename: 'codex' },
    { pid: 200, ppid: 100, command: '/bin/sh', args: 'sh -c node hook.js', commandLine: 'sh -c node hook.js', basename: 'sh' },
    { pid: 300, ppid: 200, command: process.execPath, args: 'node scripts/hooks/codex.js', commandLine: 'node scripts/hooks/codex.js', basename: 'node' }
  ]
  const byPid = new Map()
  const childrenByPpid = new Map()
  for (const proc of processes) {
    byPid.set(proc.pid, proc)
    if (!childrenByPpid.has(proc.ppid)) childrenByPpid.set(proc.ppid, [])
    childrenByPpid.get(proc.ppid).push(proc)
  }

  const resolved = resolveAgentProcess({
    agentType: 'codex',
    payloadPid: 300,
    hookPid: 300,
    parentPid: 200,
    processTable: { byPid, childrenByPpid },
    panePidResolver: () => null
  })

  assert.strictEqual(resolved.pid, 100)
  assert.strictEqual(resolved.pidSource, 'parent-chain')
  assert.strictEqual(resolved.pidCommand, 'codex')
})

test('watchdog option is enabled by default and can be explicitly disabled', () => {
  assert.strictEqual(watcherOptionEnabled(''), true)
  assert.strictEqual(watcherOptionEnabled(undefined), true)
  assert.strictEqual(watcherOptionEnabled('on'), true)
  assert.strictEqual(watcherOptionEnabled('enabled'), true)
  assert.strictEqual(watcherOptionEnabled('off'), false)
  assert.strictEqual(watcherOptionEnabled('0'), false)
  assert.strictEqual(watcherOptionEnabled('disabled'), false)
})

test('bridge server serializes hook updates through the same reducer', async () => {
  const dir = tempDir()
  let bridge
  try {
    const paths = defaultPaths(dir)
    bridge = await startBridgeServer({ paths })
    const context = createHookContext({
      agentType: 'gemini',
      defaultStateSource: 'gemini-hooks',
      paths
    })
    context.updateSession('bridge-session', {
      status: 'working',
      lastEvent: { type: 'prompt_submit', timestamp: 1000, details: 'hello' }
    })
    await context.flush()

    const status = JSON.parse(fs.readFileSync(paths.statusFile, 'utf-8'))
    const session = status.sessions['bridge-session']
    assert.strictEqual(session.agentType, 'gemini')
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.stateSource, 'gemini-hooks')
  } finally {
    if (bridge) bridge.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('agent event aliases normalize to persisted event names', () => {
  assert.strictEqual(normalizeAgentEventType('sessionStarted'), AGENT_EVENTS.SESSION_START)
  assert.strictEqual(normalizeAgentEventType('toolUseStarted'), AGENT_EVENTS.TOOL_USE)
  assert.strictEqual(normalizeAgentEventType('subagentStarted'), AGENT_EVENTS.SUBAGENT_START)
  assert.strictEqual(normalizeAgentEventType('permissionResolved'), AGENT_EVENTS.PERMISSION_RESOLVED)
  assert.strictEqual(normalizeAgentEventType('questionAnswered'), AGENT_EVENTS.QUESTION_ANSWERED)
  assert.strictEqual(normalizeAgentEventType(AGENT_EVENTS.PERMISSION_REQUEST), AGENT_EVENTS.PERMISSION_REQUEST)
})

test('agent events normalize source metadata for reducer evidence', () => {
  const event = createAgentEvent('toolUseStarted', {
    source: 'codex-hooks',
    hook_event_name: 'PreToolUse',
    timestamp: '2026-01-01T00:00:00.000Z',
    turn_id: 'turn-1',
    transcript_path: '/tmp/codex.jsonl',
    tmuxPane: '%1',
    pid: 123
  })

  assert.strictEqual(event.type, AGENT_EVENTS.TOOL_USE)
  assert.strictEqual(event.rawEventName, 'PreToolUse')
  assert.strictEqual(event.turnId, 'turn-1')
  assert.strictEqual(event.transcriptPath, '/tmp/codex.jsonl')
  assert.strictEqual(event.timestamp, new Date('2026-01-01T00:00:00.000Z').getTime())
})

test('session contract maps events to canonical phases', () => {
  assert.strictEqual(statusForPhase(SESSION_PHASES.WAITING_FOR_APPROVAL), 'working')
  assert.strictEqual(phaseFromLegacyStatus('crashed', 'waiting for approval'), SESSION_PHASES.CRASHED)
  assert.strictEqual(phaseFromLegacyStatus('stale', 'waiting for answer'), SESSION_PHASES.STALE)
  assert.strictEqual(phaseFromLegacyStatus('interrupted', 'waiting for approval'), SESSION_PHASES.INTERRUPTED)
  assert.strictEqual(phaseForAgentEvent({ type: 'permissionRequested' }), SESSION_PHASES.WAITING_FOR_APPROVAL)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.QUESTION_ASKED }), SESSION_PHASES.WAITING_FOR_ANSWER)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PANE_STATE, status: 'working' }), SESSION_PHASES.RUNNING)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PANE_STATE, status: 'crashed', needsAttention: 'waiting for approval' }), SESSION_PHASES.CRASHED)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.TRANSCRIPT_STATUS, needsAttention: 'waiting for answer' }), SESSION_PHASES.WAITING_FOR_ANSWER)

  const valid = validateAgentEvent(createAgentEvent('toolUseStarted', {
    source: 'hook',
    timestamp: 1000,
    activeTool: 'Read',
    turnId: 'turn-1'
  }))
  assert.strictEqual(valid.valid, true)
  assert.deepStrictEqual(valid.errors, [])

  const invalid = validateAgentEvent({
    type: AGENT_EVENTS.TOOL_USE,
    timestamp: { bad: true },
    phase: 'busy'
  })
  assert.strictEqual(invalid.valid, false)
  assert.ok(invalid.errors.includes('event.timestamp must be a number, ISO string, or omitted'))
  assert.ok(invalid.errors.includes('event.phase busy is not canonical'))
})

test('session contract validates factual state invariants', () => {
  const waiting = validateSessionSnapshot({
    sessionId: 'contract-wait',
    agentType: 'codex',
    phase: SESSION_PHASES.WAITING_FOR_APPROVAL,
    status: 'working',
    needsAttention: 'waiting for approval',
    activeTool: null,
    pendingInteraction: {
      type: 'approval',
      phase: SESSION_PHASES.WAITING_FOR_APPROVAL,
      source: 'hook'
    }
  })
  assert.strictEqual(waiting.valid, true)
  assert.deepStrictEqual(waiting.errors, [])
  assert.deepStrictEqual(waiting.warnings, [])

  const noisy = validateSessionSnapshot({
    sessionId: 'contract-noisy',
    agentType: 'codex',
    phase: SESSION_PHASES.IDLE,
    status: 'working',
    needsAttention: 'waiting for answer',
    activeTool: 'Bash',
    pendingInteraction: {
      type: 'question',
      phase: SESSION_PHASES.WAITING_FOR_ANSWER
    },
    stateEvidence: {}
  })
  assert.strictEqual(noisy.valid, true)
  assert.ok(noisy.warnings.some(warning => warning.includes('status working does not match phase idle')))
  assert.ok(noisy.warnings.some(warning => warning.includes('needsAttention is set while phase is idle')))
  assert.ok(noisy.warnings.some(warning => warning.includes('activeTool is set while phase is idle')))
  assert.ok(noisy.warnings.some(warning => warning.includes('pendingInteraction is set while phase is idle')))
  assert.ok(noisy.warnings.some(warning => warning.includes('stateEvidence should be an array')))

  const invalid = validateSessionSnapshot({ agentType: 'codex', phase: 'busy' })
  assert.strictEqual(invalid.valid, false)
  assert.ok(invalid.errors.includes('session.sessionId is required'))
  assert.ok(invalid.errors.includes('session.phase is required and must be canonical'))
})

test('codex hook enriches sessions with compact session meta fields', () => {
  const fields = codexHook.codexSessionMetaFields({
    _session_meta: {
      id: 'codex-session-1',
      forked_from_id: 'parent-session',
      agent_nickname: 'reviewer',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'fallback-parent',
            agent_nickname: 'fallback-reviewer'
          }
        }
      }
    }
  })

  assert.deepStrictEqual(fields, {
    codexSessionId: 'codex-session-1',
    codexSessionSource: 'subagent:thread_spawn',
    codexForkedFromId: 'parent-session',
    codexAgentNickname: 'reviewer'
  })
})

test('bridge client falls back to direct writes when no ACK is received', async () => {
  const dir = tempDir()
  let server = null
  try {
    const paths = defaultPaths(dir)
    fs.mkdirSync(paths.runDir, { recursive: true })
    server = net.createServer(socket => {
      socket.on('data', () => socket.end())
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.bridgeSocket, () => {
        server.off('error', reject)
        resolve()
      })
    })

    const context = createHookContext({
      agentType: 'gemini',
      defaultStateSource: 'gemini-hooks',
      paths
    })
    context.updateSession('no-ack-session', {
      status: 'working',
      lastEvent: { type: 'prompt_submit', timestamp: 1000, details: 'hello' }
    })
    await context.flush()

    const status = JSON.parse(fs.readFileSync(paths.statusFile, 'utf-8'))
    const session = status.sessions['no-ack-session']
    assert.strictEqual(session.agentType, 'gemini')
    assert.strictEqual(session.stateSource, 'gemini-hooks')
    assert.strictEqual(currentPhase(session), 'running')
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('watcher disables the bridge without failing startup when bind fails', async () => {
  const logs = []
  const bridge = await startOptionalBridge(async () => {
    throw new Error('bind failed')
  }, message => logs.push(message))

  assert.strictEqual(bridge.disabled, true)
  assert.ok(bridge.error)
  assert.doesNotThrow(() => bridge.close())
  assert.ok(logs.some(message => message.includes('bridge disabled: bind failed')))
})

test('picker rows keep display text unchanged while carrying hidden session id', () => {
  const session = {
    sessionId: 'session-hidden-id',
    agentType: 'codex',
    status: 'working',
    tmuxPane: '%1',
    workingDirectory: '/tmp/demo',
    sessionTitle: 'visible title',
    _tmuxPaneSnapshot: { windowName: 'main' }
  }
  const line = stripAnsi(formatLine(session, Date.now(), '%1'))
  const fields = line.split('\t')

  assert.strictEqual(fields[0], '%1')
  assert.ok(fields[1].includes('visible title'), fields[1])
  assert.ok(!fields[1].includes('session-hidden-id'), fields[1])
  assert.strictEqual(fields[2], 'session-hidden-id')
})

test('picker rows prefer pending interaction detail for waits', () => {
  const session = {
    sessionId: 'session-plan-wait',
    agentType: 'claude',
    status: 'working',
    phase: 'waitingForApproval',
    needsAttention: 'waiting for plan approval',
    pendingInteraction: {
      type: 'plan',
      phase: 'waitingForApproval',
      source: 'hook',
      reason: 'waiting for plan approval',
      details: 'ExitPlanMode: proposed plan',
      tool: 'ExitPlanMode'
    },
    tmuxPane: '%1',
    workingDirectory: '/tmp/demo',
    _tmuxPaneSnapshot: { windowName: 'main' }
  }
  const line = stripAnsi(formatLine(session, Date.now(), '%1'))
  assert.ok(line.includes('W:PLAN'), line)
  assert.ok(line.includes('waiting for plan approval: ExitPlanMode: proposed plan'), line)
})

test('picker rows omit duplicated generic wait details', () => {
  const session = {
    sessionId: 'session-answer-wait',
    agentType: 'codex',
    status: 'working',
    phase: 'waitingForAnswer',
    needsAttention: 'waiting for answer',
    pendingInteraction: {
      type: 'question',
      phase: 'waitingForAnswer',
      source: 'pane',
      reason: 'waiting for answer',
      details: 'waiting for answer'
    },
    tmuxPane: '%1',
    workingDirectory: '/tmp/demo',
    _tmuxPaneSnapshot: { windowName: 'main' }
  }
  const line = stripAnsi(formatLine(session, Date.now(), '%1'))
  assert.ok(line.includes('W:ANS'), line)
  assert.ok(line.includes('waiting for answer · pane'), line)
  assert.ok(!line.includes('waiting for answer: waiting for answer'), line)
})

test('status bar summarizes wait subtypes and active totals', () => {
  const counts = statusBar.summarizeSessions([
    {
      needsAttention: 'waiting for approval',
      pendingInteraction: { type: 'approval' }
    },
    {
      needsAttention: 'waiting for answer',
      pendingInteraction: { type: 'question' }
    },
    {
      needsAttention: 'waiting for plan approval',
      pendingInteraction: { type: 'plan' }
    },
    { status: 'working' },
    { status: 'completed' },
    { status: 'idle' },
    { status: 'interrupted' }
  ])

  assert.deepStrictEqual(counts, {
    wait: 3,
    busy: 1,
    done: 1,
    idle: 1,
    approval: 1,
    question: 1,
    plan: 1,
    total: 7
  })
})

test('status bar keeps compact default output clickable', () => {
  const output = statusBar.renderStatusBar({
    wait: 1,
    busy: 2,
    done: 3,
    idle: 0,
    approval: 1,
    question: 0,
    plan: 0,
    total: 6
  }, '', 'on')

  assert.ok(output.startsWith('#[range=user|scout]'), output)
  assert.ok(output.endsWith('#[norange]'), output)
  assert.ok(output.includes('#[underscore]'), output)
  assert.ok(output.includes('#[fg=#e06c75]1#[default]#[underscore]|#[fg=#e5c07b]2#[default]#[underscore]|#[fg=#98c379]3#[default]'), output)
})

test('status bar supports custom placeholders and click opt-out', () => {
  const output = statusBar.renderStatusBar({
    wait: 6,
    busy: 5,
    done: 4,
    idle: 3,
    approval: 2,
    question: 1,
    plan: 3,
    total: 18
  }, '{A}/{Q}/{P}/{T}/{I}', 'off')

  assert.strictEqual(output, '2/1/3/18/3')
})

test('status bar omits empty output', () => {
  const counts = statusBar.summarizeSessions([])
  assert.strictEqual(statusBar.renderStatusBar(counts, '', 'on'), '')
  assert.strictEqual(statusBar.renderStatusBar(counts, '{T}', 'on'), '')
})

test('status bar derives active pane rows from cached status only', () => {
  const status = {
    sessions: {
      busy: {
        sessionId: 'busy',
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        tmuxPane: '%1',
        pid: 999999999,
        lastUpdated: Date.now()
      }
    }
  }

  const cachedStatus = statusBar.cachedStatusSnapshot(status)
  const active = getActiveSessions(cachedStatus, statusBar.cachedPaneSnapshot(cachedStatus))
  assert.deepStrictEqual(active.map(session => session.sessionId), ['busy'])
  assert.strictEqual(status.sessions.busy.pid, 999999999)
})

test('session details render as an information panel', () => {
  const output = formatSessionDetails({
    sessionId: 'session-1',
    agentType: 'codex',
    status: 'working',
    phase: 'waitingForApproval',
    needsAttention: 'waiting for approval',
    pendingInteraction: {
      type: 'approval',
      phase: 'waitingForApproval',
      source: 'hook',
      stateSource: 'codex-hooks',
      rawEventName: 'PermissionRequest',
      startedAt: 2000,
      updatedAt: 2000,
      reason: 'waiting for approval',
      details: 'Bash: npm test',
      tool: 'Bash',
      confidence: 90
    },
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test' },
    workingDirectory: '/tmp/tmux-scout',
    tmuxPane: '%1',
    pid: 123,
    pidSource: 'process-tree',
    pidCommand: 'codex',
    terminalApp: 'Ghostty',
    terminalTty: '/dev/ttys001',
    hostName: 'host',
    userName: 'user',
    stateSource: 'codex-hooks',
    stateConfidence: 90,
    lastUpdated: 2000,
    stateEvidence: [
      { timestamp: 2000, rawEventName: 'PermissionRequest', phase: 'waitingForApproval', details: 'Bash: npm test' },
      { timestamp: 1000, rawEventName: 'UserPromptSubmit', phase: 'running', details: 'run tests' }
    ]
  }, { now: 5000 })

  assert.ok(/\x1b\[[0-9;]*m/.test(output))
  const plain = stripAnsi(output)
  assert.ok(plain.includes('tmux-scout | session'))
  assert.ok(plain.includes('WAITING'))
  assert.ok(plain.includes('Current'))
  assert.ok(plain.includes('Bash: npm test'))
  assert.ok(plain.includes('source=hook'))
  assert.ok(plain.includes('event=PermissionRequest'))
  assert.ok(plain.includes('Context'))
  assert.ok(plain.includes('source=process-tree'))
  assert.ok(plain.includes('State Stream'))
  assert.ok(plain.includes('PermissionRequest'))
})

test('generic hook tracks Gemini prompt, tool and completion events', () => {
  const dir = tempDir()
  try {
    const sessionId = 'gemini-session'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'BeforeAgent',
      prompt: 'explain the repository'
    }), dir)
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'BeforeTool',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' }
    }), dir)
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'AfterAgent',
      prompt_response: 'done'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'gemini')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.sessionTitle, 'explain the repository')
    assert.strictEqual(session.lastAssistantMessage, 'done')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook treats capitalized Kimi tools as permission requests', () => {
  const dir = tempDir()
  try {
    const sessionId = 'kimi-session'
    runGenericHook('kimi', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: '/tmp/demo',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' }
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'kimi')
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.tool, 'Shell')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.source, 'hook')
    assert.strictEqual(session.pendingInteraction.tool, 'Shell')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook treats mutating Copilot tools as permission requests', () => {
  const dir = tempDir()
  try {
    const sessionId = 'copilot-session'
    runGenericHook('copilot-cli', {
      hook_event_name: 'preToolUse',
      session_id: sessionId,
      cwd: '/tmp/demo',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'copilot-cli')
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.tool, 'Bash')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.source, 'hook')
    assert.strictEqual(session.pendingInteraction.tool, 'Bash')
    assert.strictEqual(session.lastEvent.type, 'permission_request')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('session reducer records applied and blocked state evidence', () => {
  const session = { sessionId: 'evidence-session', agentType: 'codex', startedAt: 1000 }
  const first = applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    rawEventName: 'UserPromptSubmit',
    timestamp: 1000,
    transcriptPath: '/tmp/session.jsonl',
    tmuxPane: '%1',
    pid: 123,
    turnId: 'turn-a'
  })

  assert.strictEqual(first.applied, true)
  assert.strictEqual(first.evidenceChanged, true)
  assert.strictEqual(session.stateEvidence.length, 1)
  assert.strictEqual(session.stateEvidence[0].rawEventName, 'UserPromptSubmit')
  assert.strictEqual(session.stateEvidence[0].applied, true)
  assert.strictEqual(session.stateEvidence[0].turnId, 'turn-a')

  const blocked = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 2000,
    phase: 'completed',
    status: 'completed'
  })

  assert.strictEqual(blocked.applied, false)
  assert.strictEqual(blocked.evidenceChanged, true)
  assert.strictEqual(session.stateEvidence[0].applied, false)
  assert.ok(/priority/.test(session.stateEvidence[0].blockedReason))
  assert.strictEqual(currentPhase(session), 'running')

  const duplicate = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 3000,
    phase: 'completed',
    status: 'completed'
  })
  assert.strictEqual(duplicate.evidenceChanged, false)
  assert.strictEqual(session.stateEvidence.length, 2)
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
  assert.strictEqual(session.activeTool, null)
  assert.deepStrictEqual(session.pendingInteraction, {
    type: 'approval',
    phase: 'waitingForApproval',
    source: 'hook',
    rawEventName: 'permission_request',
    startedAt: 1000,
    updatedAt: 1000,
    reason: 'waiting for approval',
    details: 'Bash: npm test',
    tool: 'Bash',
    confidence: 90
  })

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
  assert.strictEqual(session.pendingInteraction, null)
})

test('session reducer tracks active tool separately from pending approval state', () => {
  const session = { sessionId: 's2-tool', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Read', details: 'Read: package.json', timestamp: 1000 },
    activeTool: 'Read'
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

test('session reducer does not infer active tool from pending display fields', () => {
  const session = { sessionId: 's2-no-infer', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Read', details: 'Thinking about Read...', timestamp: 1000 }
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.pendingToolUse.tool, 'Read')
  assert.strictEqual(session.activeTool, null)
})

test('session reducer clears waits with explicit pending lifecycle events', () => {
  const session = { sessionId: 's2-resolved', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })

  applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    timestamp: 1500,
    activeTool: 'Bash',
    details: 'approved'
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.needsAttention, null)
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, 'Bash')

  applySessionEvent(session, {
    type: 'question_asked',
    source: 'hook',
    timestamp: 2000,
    attentionReason: 'waiting for answer',
    pendingToolUse: { tool: 'AskUserQuestion', details: 'continue?', timestamp: 2000 },
    activeTool: 'AskUserQuestion'
  })

  assert.strictEqual(currentPhase(session), 'waitingForAnswer')
  assert.strictEqual(session.activeTool, null)
  assert.strictEqual(session.pendingInteraction.type, 'question')

  applySessionEvent(session, {
    type: 'question_answered',
    source: 'hook',
    timestamp: 2500,
    details: 'answered'
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.needsAttention, null)
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
})

test('session reducer classifies plan approval as pending interaction', () => {
  const session = { sessionId: 's2-plan', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for plan approval',
    pendingToolUse: { tool: 'ExitPlanMode', details: 'ExitPlanMode: proposed plan', timestamp: 1000 },
    requestId: 'req-plan-1'
  })

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.needsAttention, 'waiting for plan approval')
  assert.strictEqual(session.pendingInteraction.type, 'plan')
  assert.strictEqual(session.pendingInteraction.tool, 'ExitPlanMode')
  assert.strictEqual(session.pendingInteraction.requestId, 'req-plan-1')
  assert.strictEqual(session.pendingInteraction.startedAt, 1000)

  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1500,
    attentionReason: 'waiting for plan approval',
    pendingToolUse: { tool: 'ExitPlanMode', details: 'ExitPlanMode: proposed plan', timestamp: 1500 },
    requestId: 'req-plan-1'
  })

  assert.strictEqual(session.pendingInteraction.startedAt, 1000)
  assert.strictEqual(session.pendingInteraction.updatedAt, 1500)
})

test('session reducer keeps pending tool detail on low-fidelity wait refresh', () => {
  const session = { sessionId: 's2-wait-refresh', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 },
    requestId: 'req-approval-1'
  })

  const refreshed = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 1000 + PROTECTED_PHASE_MS + 1,
    phase: 'waitingForApproval',
    status: 'needsAttention',
    attentionReason: 'waiting for approval',
    details: 'needsAttention'
  })

  assert.strictEqual(refreshed.applied, true)
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.pendingToolUse.tool, 'Bash')
  assert.strictEqual(session.pendingInteraction.type, 'approval')
  assert.strictEqual(session.pendingInteraction.source, 'pane')
  assert.strictEqual(session.pendingInteraction.tool, 'Bash')
  assert.strictEqual(session.pendingInteraction.details, 'Bash: npm test')
  assert.strictEqual(session.pendingInteraction.requestId, 'req-approval-1')
  assert.strictEqual(session.pendingInteraction.startedAt, 1000)
  assert.strictEqual(session.pendingInteraction.updatedAt, 1000 + PROTECTED_PHASE_MS + 1)
})

test('session reducer keeps ordinary approval when command details mention plan', () => {
  const session = { sessionId: 's2-terraform-plan', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: terraform plan', timestamp: 1000 }
  })

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.needsAttention, 'waiting for approval')
  assert.strictEqual(session.pendingInteraction.type, 'approval')
  assert.strictEqual(session.pendingInteraction.tool, 'Bash')
  assert.strictEqual(session.pendingInteraction.details, 'Bash: terraform plan')
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
  assert.strictEqual(session.pendingInteraction.type, 'question')
  assert.strictEqual(session.pendingInteraction.source, 'pane')
  assert.strictEqual(session.pendingInteraction.reason, 'waiting for answer')
  assert.strictEqual(session.pendingInteraction.tool, undefined)
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
  assert.strictEqual(session.activeTool, null)
  assert.strictEqual(session.pendingInteraction.type, 'question')
  assert.strictEqual(session.pendingInteraction.tool, 'AskUserQuestion')
  assert.strictEqual(session.pendingInteraction.details, 'AskUserQuestion: continue?')
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

test('session reducer preserves terminal legacy status despite stale attention', () => {
  for (const status of ['crashed', 'stale']) {
    const session = {
      sessionId: `legacy-${status}`,
      agentType: 'codex',
      startedAt: 1000,
      status,
      needsAttention: 'waiting for approval',
      stateSource: 'pid',
      lastUpdated: 1000
    }

    const result = applySessionEvent(session, {
      type: 'pane_state',
      source: 'pane',
      timestamp: 1000 + PROTECTED_PHASE_MS + 1,
      phase: 'running',
      status: 'working'
    })

    assert.strictEqual(result.applied, false)
    assert.strictEqual(currentPhase(session), status)
    assert.strictEqual(session.status, status)
    assert.strictEqual(session.needsAttention, 'waiting for approval')
  }
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

test('sync marks sessions stale when their tmux pane vanishes', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        ghost: {
          sessionId: 'ghost',
          agentType: 'claude',
          status: 'completed',
          phase: 'completed',
          tmuxPane: '%9999',
          startedAt: now - 60000,
          lastUpdated: now - 30000
        },
        live: {
          sessionId: 'live',
          agentType: 'claude',
          status: 'completed',
          phase: 'completed',
          tmuxPane: '%1',
          startedAt: now - 60000,
          lastUpdated: now - 30000
        },
        unbound: {
          sessionId: 'unbound',
          agentType: 'codex',
          status: 'completed',
          phase: 'completed',
          tmuxPane: null,
          startedAt: now - 60000,
          lastUpdated: now - 30000
        }
      }
    }))

    const initResult = sync.run(statusFile, {
      codexMode: 'none',
      claudeTranscript: false,
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false
    })

    const panes = new Map([['%1', { paneId: '%1', currentCommand: 'node', paneDead: false }]])
    panes.tmuxAvailable = true
    const stats = sync.createStats()
    sync.sweepVanishedPanes(initResult.status, panes, stats)

    assert.strictEqual(stats.reconcile.paneVanished, 1)
    const reloaded = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(reloaded.sessions.ghost.status, 'stale')
    assert.match(reloaded.sessions.ghost.staleReason || '', /pane %9999 no longer exists/)
    assert.strictEqual(reloaded.sessions.live.status, 'completed')
    assert.strictEqual(reloaded.sessions.unbound.status, 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync vanished-pane sweep skips when tmux is unavailable', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        ghost: {
          sessionId: 'ghost',
          agentType: 'claude',
          status: 'completed',
          phase: 'completed',
          tmuxPane: '%9999',
          startedAt: now - 60000,
          lastUpdated: now - 30000
        }
      }
    }))

    const initResult = sync.run(statusFile, {
      codexMode: 'none',
      claudeTranscript: false,
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false
    })

    const panes = new Map()
    const stats = sync.createStats()
    sync.sweepVanishedPanes(initResult.status, panes, stats)

    assert.strictEqual(stats.reconcile.paneVanished, 0)
    const reloaded = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(reloaded.sessions.ghost.status, 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('render hides completed sessions that never linked to a tmux pane', () => {
  const active = getActiveSessions({
    sessions: {
      done: {
        sessionId: 'done',
        agentType: 'codex',
        status: 'completed',
        phase: 'completed',
        tmuxPane: null,
        lastUpdated: Date.now()
      },
      working: {
        sessionId: 'working',
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        tmuxPane: null,
        lastUpdated: Date.now()
      },
      hookOutsideTmux: {
        sessionId: 'hookOutsideTmux',
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        tmuxPane: null,
        stateSource: 'codex-hooks',
        lastUpdated: Date.now()
      }
    }
  }, new Map())
  assert.deepStrictEqual(active.map(session => session.sessionId), ['working'])
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

test('codex full sync does not refresh unchanged same-phase transcript state', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '33333333-3333-4333-8333-333333333333'
    const jsonl = path.join(dir, 'codex-session.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(1000).toISOString(),
        payload: { type: 'user_message', message: 'done already' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(2000).toISOString(),
        payload: { type: 'task_complete' }
      })
    ].join('\n') + '\n')
    const oldUpdated = 12345
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'completed',
      phase: 'completed',
      stateSource: 'transcript',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastUpdated: oldUpdated,
      sessionTitle: 'done already'
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: oldUpdated, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    assert.strictEqual(result.status.sessions[threadId].lastUpdated, oldUpdated)
    assert.strictEqual(result.stats.codex.updated, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync does not refresh unchanged active unbound sessions from JSONL', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '35353535-3535-4535-8535-353535353535'
    const jsonl = path.join(dir, 'codex-running.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(Date.now() - 1000).toISOString(),
      payload: { type: 'user_message', message: 'still running' }
    }) + '\n')
    const oldUpdated = Date.now() - 600000
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      stateSource: 'transcript',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastUpdated: oldUpdated,
      sessionTitle: 'still running'
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: oldUpdated, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    assert.strictEqual(result.status.sessions[threadId].lastUpdated, oldUpdated)
    assert.strictEqual(result.status.sessions[threadId].status, 'working')
    assert.strictEqual(result.stats.codex.updated, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync marks matching current turn interrupted from transcript', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '36363636-3636-4636-8636-363636363636'
    const jsonl = path.join(dir, 'codex-interrupted.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        payload: { type: 'user_message', message: 'keep working', turn_id: 'turn-current' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        payload: { type: 'turn_aborted', turn_id: 'turn-current', reason: 'interrupted' }
      })
    ].join('\n') + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: Date.now() - 3000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'interrupted')
    assert.strictEqual(updated.lastEvent.turnId, 'turn-current')
    assert.strictEqual(updated.stateEvidence[0].rawEventName, 'turn_aborted')
    assert.strictEqual(result.stats.codex.interrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync settle gate skips very recent transcript scans', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-settling-scan'
    const jsonl = path.join(dir, 'codex-settling.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 500).toISOString(),
      payload: { type: 'turn_aborted', turn_id: 'turn-current', reason: 'interrupted' }
    }) + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: now - 1000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    assert.strictEqual(currentPhase(result.status.sessions[threadId]), 'running')
    assert.strictEqual(result.stats.codex.filesRead, 0)
    assert.strictEqual(result.stats.codex.skippedSettling, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync reuses transcript path, turn id, and scanned size cache', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-size-cache'
    const jsonl = path.join(dir, 'codex-size-cache.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 10000).toISOString(),
      payload: { type: 'user_message', message: 'keep working', turn_id: 'turn-current' }
    }) + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: now - 10000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const codexTranscriptState = {}
    const first = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptState
    })
    assert.strictEqual(first.stats.codex.filesRead, 1)
    assert.strictEqual(codexTranscriptState[threadId].transcriptPath, jsonl)
    assert.strictEqual(codexTranscriptState[threadId].latestTurnId, 'turn-current')
    assert.strictEqual(codexTranscriptState[threadId].lastScannedSize, fs.statSync(jsonl).size)

    const second = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptState
    })
    assert.strictEqual(second.stats.codex.filesRead, 0)
    assert.strictEqual(second.stats.codex.skippedUnchanged, 1)

    fs.appendFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 1000).toISOString(),
      payload: { type: 'turn_aborted', turn_id: 'turn-current', reason: 'interrupted' }
    }) + '\n')

    const third = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptState
    })
    assert.strictEqual(third.stats.codex.filesRead, 1)
    assert.strictEqual(currentPhase(third.status.sessions[threadId]), 'interrupted')
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync invalidates transcript cache when mtime changes at same byte size', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-mtime-cache'
    const jsonl = path.join(dir, 'codex-mtime-cache.jsonl')

    const baseUser = JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 10000).toISOString(),
      payload: { type: 'user_message', message: 'keep working', turn_id: 'turn-current' }
    })
    const baseAborted = JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 1000).toISOString(),
      payload: { type: 'turn_aborted', turn_id: 'turn-current', reason: 'interrupted' }
    })
    const padOverhead = ',"_pad":""'.length
    const targetLen = Math.max(baseUser.length, baseAborted.length) + padOverhead + 16
    const withPad = (base) => {
      const obj = JSON.parse(base)
      obj._pad = 'x'.repeat(targetLen - base.length - padOverhead)
      return JSON.stringify(obj) + '\n'
    }
    const paddedUser = withPad(baseUser)
    const paddedAborted = withPad(baseAborted)
    assert.strictEqual(paddedUser.length, paddedAborted.length)

    fs.writeFileSync(jsonl, paddedUser)
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: now - 10000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const codexTranscriptState = {}
    const first = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptState,
      codexTranscriptSettleGateMs: 0
    })
    assert.strictEqual(first.stats.codex.filesRead, 1)
    const cached = codexTranscriptState[threadId]
    assert.ok(Number.isFinite(cached.lastScannedMtimeMs))
    assert.ok(Number.isFinite(cached.lastScannedInode))
    assert.strictEqual(cached.lastScannedSize, fs.statSync(jsonl).size)

    fs.writeFileSync(jsonl, paddedAborted)
    const bumped = new Date(Date.now() + 5000)
    fs.utimesSync(jsonl, bumped, bumped)
    assert.strictEqual(fs.statSync(jsonl).size, cached.lastScannedSize)
    assert.notStrictEqual(fs.statSync(jsonl).mtimeMs, cached.lastScannedMtimeMs)

    const second = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptState,
      codexTranscriptSettleGateMs: 0
    })
    assert.strictEqual(second.stats.codex.filesRead, 1)
    assert.strictEqual(currentPhase(second.status.sessions[threadId]), 'interrupted')
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync marks waiting current turns interrupted from transcript', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const cases = [
      { threadId: 'waiting-approval-codex-interrupt', phase: 'waitingForApproval', turnId: 'turn-approval' },
      { threadId: 'waiting-answer-codex-interrupt', phase: 'waitingForAnswer', turnId: 'turn-answer' }
    ]
    const sessions = {}

    for (const testCase of cases) {
      const jsonl = path.join(dir, `${testCase.threadId}.jsonl`)
      fs.writeFileSync(jsonl, [
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(now - 2000).toISOString(),
          payload: { type: 'user_message', message: 'keep working', turn_id: testCase.turnId }
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(now - 1000).toISOString(),
          payload: { type: 'turn_aborted', turn_id: testCase.turnId, reason: 'interrupted' }
        })
      ].join('\n') + '\n')

      const session = {
        sessionId: testCase.threadId,
        threadId: testCase.threadId,
        agentType: 'codex',
        status: 'working',
        phase: testCase.phase,
        transcriptPath: jsonl,
        tmuxPane: null,
        lastTurnId: testCase.turnId,
        lastUpdated: now - 3000
      }
      sessions[testCase.threadId] = session
      fs.writeFileSync(path.join(scoutDir, 'sessions', `${testCase.threadId}.json`), JSON.stringify(session, null, 2))
    }

    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    for (const testCase of cases) {
      const updated = result.status.sessions[testCase.threadId]
      assert.strictEqual(currentPhase(updated), 'interrupted')
      assert.strictEqual(updated.lastEvent.turnId, testCase.turnId)
      assert.strictEqual(updated.stateEvidence[0].rawEventName, 'turn_aborted')
    }
    assert.strictEqual(result.stats.codex.interrupted, cases.length)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync accepts current turn interrupted transcript without turn id', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '38383838-3838-4838-8838-383838383838'
    const jsonl = path.join(dir, 'codex-interrupted-no-turn.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        payload: { type: 'user_message', message: 'keep working', turn_id: 'turn-current' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        payload: { type: 'turn_aborted', reason: 'interrupted' }
      })
    ].join('\n') + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: Date.now() - 3000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'interrupted')
    assert.strictEqual(updated.stateEvidence[0].rawEventName, 'turn_aborted')
    assert.strictEqual(result.stats.codex.interrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync ignores stale interrupted transcript events for newer turns', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '37373737-3737-4737-8737-373737373737'
    const jsonl = path.join(dir, 'codex-stale-interrupt.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        payload: { type: 'user_message', message: 'current work', turn_id: 'turn-current' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        payload: { type: 'turn_aborted', turn_id: 'turn-old', reason: 'interrupted' }
      })
    ].join('\n') + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-current',
      lastUpdated: Date.now() - 3000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'running')
    assert.strictEqual(updated.status, 'working')
    assert.strictEqual(result.stats.codex.interrupted, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync does not mark unbound sessions stale from inactive JSONL', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '44444444-4444-4444-8444-444444444444'
    const jsonl = path.join(dir, 'codex-stale.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(Date.now() - 600000).toISOString(),
      payload: { type: 'user_message', message: 'still running?' }
    }) + '\n')
    const staleTime = new Date(Date.now() - 600000)
    fs.utimesSync(jsonl, staleTime, staleTime)
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
      pid: process.pid,
      lastUpdated: Date.now() - 600000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    assert.strictEqual(result.status.sessions[threadId].status, 'working')
    assert.strictEqual(result.stats.codex.stale, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('claude transcript watcher retries missing files and preserves partial lines', () => {
  const dir = tempDir()
  let manager
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    const sessionsDir = path.join(scoutDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const sessionId = 'claude-watch-partial'
    const transcriptPath = path.join(dir, 'claude-partial.jsonl')
    const now = Date.now()
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
    fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(session, null, 2))

    manager = new ClaudeTranscriptWatchManager(statusFile)
    manager.openOne('missing-session', path.join(dir, 'missing.jsonl'))
    assert.strictEqual(manager.retryTimers.has('missing-session'), true)
    manager.closeOne('missing-session')

    fs.writeFileSync(transcriptPath, '')
    manager.openOne(sessionId, transcriptPath)
    fs.appendFileSync(transcriptPath, '{"timestamp":"' + new Date(now + 1000).toISOString() + '","message":{"content":[{"type":"text","text":"[Request interrupted')
    assert.strictEqual(manager.scanWatch(sessionId), false)
    fs.appendFileSync(transcriptPath, ' by user]"}]}}\n')
    assert.strictEqual(manager.scanWatch(sessionId), true)
    assert.strictEqual(markClaudeInterrupted(statusFile, sessionId), true)
    const updated = JSON.parse(fs.readFileSync(statusFile, 'utf-8')).sessions[sessionId]
    assert.strictEqual(currentPhase(updated), 'interrupted')
  } finally {
    if (manager) manager.close()
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
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.pendingInteraction.type, 'question')
    assert.strictEqual(session.pendingInteraction.tool, 'AskUserQuestion')
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
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.details, 'Bash: npm test')
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
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastToolError, 'exit code 1')
    assert.strictEqual(session.lastEvent.type, 'post_tool_use_failure')
    assert.ok(session.stateEvidence.some(evidence => evidence.type === 'permission_resolved'))
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
    assert.strictEqual(session.pendingInteraction.type, 'plan')
    assert.strictEqual(session.pendingInteraction.tool, 'ExitPlanMode')

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

test('claude hook summarizes active subagents on parent picker rows', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-parent'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the branch'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { description: 'review tests', prompt: 'run the test review' }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStart',
      sub_agent: { id: 'claude-child-1', type: 'reviewer', transcript_path: '/tmp/demo/child.jsonl' }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      agent_id: 'claude-child-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.activeSubagents.length, 1)
    assert.strictEqual(session.activeSubagents[0].agentId, 'claude-child-1')
    assert.strictEqual(session.activeSubagents[0].agentType, 'reviewer')
    assert.strictEqual(session.activeSubagents[0].taskDescription, 'review tests')
    assert.strictEqual(session.activeSubagents[0].lastToolActivity, 'Bash: npm test')
    assert.deepStrictEqual(session._pendingSubagentDescriptions, [])

    const pane = {
      paneId: '%1',
      currentCommand: 'node',
      paneDead: false,
      windowName: 'main'
    }
    session._tmuxPaneSnapshot = pane
    const line = stripAnsi(formatLine(session, Date.now(), '%1'))
    assert.ok(/1 subagent · reviewer: Bash: npm test/.test(line), line)

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStop',
      sub_agent: { id: 'claude-child-1', type: 'reviewer' }
    }), dir)

    status = readScoutStatus(dir)
    assert.deepStrictEqual(status.sessions[sessionId].activeSubagents, [])
    status.sessions[sessionId]._tmuxPaneSnapshot = pane
    assert.ok(!stripAnsi(formatLine(status.sessions[sessionId], Date.now(), '%1')).includes('subagent'))
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

test('codex hook records question answered before next prompt clears wait', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-question-answered'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'help me choose'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: '请选择一个方案？\n1. A\n2. B'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'A'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, 'prompt_submit')
    assert.ok(session.stateEvidence.some(evidence => evidence.type === 'question_answered'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook persists event evidence with hook metadata', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-evidence'
    const transcriptPath = path.join(dir, 'codex-evidence.jsonl')
    fs.writeFileSync(transcriptPath, '')
    runHook('scripts/hooks/codex.js', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath,
      turn_id: 'turn-hook',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.ok(Array.isArray(session.stateEvidence))
    assert.strictEqual(session.stateEvidence[0].type, AGENT_EVENTS.TOOL_USE)
    assert.strictEqual(session.stateEvidence[0].rawEventName, 'PreToolUse')
    assert.strictEqual(session.stateEvidence[0].turnId, 'turn-hook')
    assert.strictEqual(session.stateEvidence[0].transcriptPath, transcriptPath)
    assert.strictEqual(session.stateEvidence[0].tmuxPane, '%1')
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

test('codex jsonl discovery no longer creates standalone review sessions', () => {
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
    assert.deepStrictEqual(Object.keys(result.status.sessions), [])
    assert.strictEqual(fs.existsSync(statusFile), false)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex jsonl discovery remains disabled for subagent sessions', () => {
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
