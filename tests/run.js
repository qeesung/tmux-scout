#!/usr/bin/env node

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const TOML = require('../scripts/vendor/iarna-toml/toml')

const { DEFAULT_TAIL_BYTES, readFileTail, readJsonlFile, readJsonlIncremental, splitJsonlLines } = require('../scripts/lib/jsonl-tail-reader')
const { applySessionEvent, currentPhase } = require('../scripts/lib/session-state')
const { classifyCodexSession } = require('../scripts/lib/codex-session-classifier')
const { compareSessions, formatLine, getActiveSessions } = require('../scripts/picker/render')
const { recordAccess, readAccessTimes } = require('../scripts/lib/access-history')
const { AGENTS, agentDisplay, scoreAgentProcess } = require('../scripts/lib/agents')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../scripts/lib/hook-command')
const { createHookContext, defaultPaths } = require('../scripts/lib/hook-adapter')
const { resolveAgentProcess } = require('../scripts/lib/terminal-context')
const { isScoutHookProcess } = require('../scripts/lib/process-tree')
const { startBridgeServer } = require('../scripts/lib/bridge-server')
const { markInterrupted: markClaudeInterrupted, ClaudeTranscriptWatchManager } = require('../scripts/lib/claude-transcript-watcher')
const { startOptionalBridge, optionEnabled: watcherOptionEnabled } = require('../scripts/watcher')
const { AGENT_EVENTS, normalizeAgentEventType, createAgentEvent } = require('../scripts/lib/agent-events')
const {
  FIELD_TYPES,
  SESSION_CONTRACT_VERSION,
  SESSION_PHASES,
  SESSION_SCHEMAS,
  phaseFromLegacyStatus,
  phaseForAgentEvent,
  statusForPhase,
  isVisibleInPicker,
  validateAgainstSchema,
  validateAgentEvent,
  validateSessionSnapshot
} = require('../scripts/lib/session-contract')
const { collectFixtureFiles, runFlowFixture, validateFixtureExpectations } = require('../scripts/lib/flow-fixtures')
const { findLatestCodexInterrupt, findLatestCodexTurnEnd } = require('../scripts/lib/codex-transcript-detector')
const { DEFAULT_STALE_SESSION_MS, DEFAULT_TERMINAL_DISPLAY_MS } = require('../scripts/lib/session-registry')
const { formatSessionDetails } = require('../scripts/picker/session-details')
const statusBar = require('../scripts/status-bar')
const sync = require('../scripts/picker/sync')
const { agentColorRows } = require('../scripts/dev/agent-colors')
const { HOOK_EVENTS: CLAUDE_HOOK_EVENTS } = require('../scripts/setup/claude')
const { HOOK_EVENTS: TRAE_HOOK_EVENTS } = require('../scripts/setup/coco')
const { HOOK_EVENTS: TRAEX_HOOK_EVENTS } = require('../scripts/setup/traex')
const { HOOK_MANAGERS, selectManagers, checkManagerHealth } = require('../scripts/setup/managers')
const claudeHook = require('../scripts/hooks/claude')
const codexHook = require('../scripts/hooks/codex')
const codexSetup = require('../scripts/setup/codex')

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

function runGenericHook(agent, payload, homeDir, extraArgs = [], tmuxPane = '%1') {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/hooks/generic.js'), '--agent', agent, ...extraArgs], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, {
      HOME: homeDir,
      TMUX_PANE: tmuxPane
    }),
    stdio: ['pipe', 'ignore', 'pipe']
  })
}

function runGenericHookAsync(agent, payload, homeDir, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts/hooks/generic.js'), '--agent', agent, ...extraArgs], {
      env: Object.assign({}, process.env, {
        HOME: homeDir,
        TMUX_PANE: '%1',
        TMUX_SCOUT_BRIDGE: '0'
      }),
      stdio: ['pipe', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`generic hook exited ${code}: ${stderr}`))
    })
    child.stdin.end(JSON.stringify(payload))
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

test('codex transcript detector matches structured task completion for the exact turn', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'codex-completed.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(1000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old result' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(2000).toISOString(),
        payload: { type: 'agent_message', turn_id: 'current-turn', message: 'not terminal' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(3000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'current-turn', last_agent_message: 'current result' }
      })
    ].join('\n') + '\n')

    const hit = findLatestCodexTurnEnd(file, { expectTurnId: 'current-turn' })
    assert.strictEqual(hit.turnId, 'current-turn')
    assert.strictEqual(hit.completedAtMs, 3000)
    assert.strictEqual(hit.completionKind, 'completed')
    assert.strictEqual(hit.rawEventName, 'task_complete')
    assert.strictEqual(hit.lastAgentMessage, 'current result')
    assert.strictEqual(findLatestCodexTurnEnd(file, { expectTurnId: 'missing-turn' }), null)
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
  const expectedManagers = ['claude', 'codex', 'gemini', 'kimi', 'copilot-cli', 'opencode', 'cursor', 'hermes', 'coco', 'traex']
  assert.deepStrictEqual(HOOK_MANAGERS.map(manager => manager.id), expectedManagers)
  assert.deepStrictEqual(selectManagers(new Set()).map(manager => manager.id), expectedManagers)
  assert.deepStrictEqual(selectManagers(new Set(['--claude'])).map(manager => manager.id), ['claude'])
  assert.deepStrictEqual(selectManagers(new Set(['--codex', '--quiet'])).map(manager => manager.id), ['codex'])
  assert.deepStrictEqual(selectManagers(new Set(['--copilot-cli'])).map(manager => manager.id), ['copilot-cli'])
  assert.deepStrictEqual(selectManagers(new Set(['--cursor'])).map(manager => manager.id), ['cursor'])
  assert.deepStrictEqual(selectManagers(new Set(['--trae'])).map(manager => manager.id), ['coco'])
  assert.deepStrictEqual(selectManagers(new Set(['--coco'])).map(manager => manager.id), ['coco'])
  assert.deepStrictEqual(selectManagers(new Set(['--traex'])).map(manager => manager.id), ['traex'])
})

test('setup commands run from a clean plugin tree without package installation', () => {
  const dir = tempDir()
  try {
    const pluginDir = path.join(dir, 'plugin')
    const homeDir = path.join(dir, 'home')
    const settingsFile = path.join(homeDir, '.claude', 'settings.json')
    fs.cpSync(path.join(__dirname, '..', 'scripts'), path.join(pluginDir, 'scripts'), { recursive: true })
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, '{}\n')

    assert.strictEqual(fs.existsSync(path.join(pluginDir, 'node_modules')), false)
    execFileSync(process.execPath, [path.join(pluginDir, 'scripts', 'setup.js'), 'install', '--claude'], {
      env: Object.assign({}, process.env, { HOME: homeDir }),
      stdio: ['ignore', 'ignore', 'pipe']
    })
    execFileSync(process.execPath, [path.join(pluginDir, 'scripts', 'setup.js'), 'status', '--claude'], {
      env: Object.assign({}, process.env, { HOME: homeDir }),
      stdio: ['ignore', 'ignore', 'pipe']
    })

    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
    assert.ok(settings.hooks)
    assert.ok(settings.hooks.SessionStart)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('Cursor setup manager preserves third-party hooks', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.cursor', 'hooks.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: 'echo keep' }]
      }
    }, null, 2))

    runScript('scripts/setup/cursor.js', ['install'], dir)
    runScript('scripts/setup/cursor.js', ['status'], dir)

    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    assert.ok(installed.hooks.beforeSubmitPrompt.some(entry => entry.command === 'echo keep'))
    assert.ok(installed.hooks.beforeSubmitPrompt.some(entry => entry.command.includes('scripts/hooks/generic.js') && entry.command.includes('--agent') && entry.command.includes('cursor')))
    assert.ok(installed.hooks.stop.some(entry => entry.command.includes('--agent') && entry.command.includes('cursor')))

    runScript('scripts/setup/cursor.js', ['uninstall'], dir)
    const removed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    assert.ok(removed.hooks.beforeSubmitPrompt.some(entry => entry.command === 'echo keep'))
    assert.ok(!JSON.stringify(removed).includes('--agent') || !JSON.stringify(removed).includes('cursor'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae setup manager preserves unrelated YAML and hooks', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.trae', 'traecli.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, [
      'allowed_tools:',
      '  - ls',
      'hooks:',
      '    - type: command',
      '      command: "echo keep"',
      '      matchers:',
      '        - event: user_prompt_submit',
      'model: default'
    ].join('\n') + '\n')

    runScript('scripts/setup/coco.js', ['install'], dir)
    runScript('scripts/setup/coco.js', ['status'], dir)

    const installed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(installed.includes('allowed_tools:'))
    assert.ok(installed.includes('command: "echo keep"'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('trae'))
    assert.ok(installed.includes('event: permission_request'))
    assert.ok(installed.includes('timeout: 86400'))
    assert.ok(installed.indexOf('event: permission_request') < installed.indexOf('model: default'))

    runScript('scripts/setup/coco.js', ['uninstall'], dir)
    const removed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(removed.includes('command: "echo keep"'))
    assert.ok(!removed.includes('--agent') || !removed.includes('trae'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae setup manager removes managed hook matcher blocks cleanly', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.trae', 'traecli.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, 'model: default\n')

    runScript('scripts/setup/coco.js', ['install'], dir)
    runScript('scripts/setup/coco.js', ['install'], dir)

    const reinstalled = fs.readFileSync(settingsPath, 'utf-8')
    const matcherLines = reinstalled.split('\n').filter(line => /^        - event: /.test(line))
    assert.strictEqual(matcherLines.length, TRAE_HOOK_EVENTS.length)

    runScript('scripts/setup/coco.js', ['uninstall'], dir)
    const removed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(removed.includes('model: default'))
    assert.strictEqual(removed.split('\n').filter(line => /^        - event: /.test(line)).length, 0)
    assert.ok(!removed.includes('--agent') || !removed.includes('trae'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex setup manager preserves unrelated TOML and enables hooks feature', () => {
  const dir = tempDir()
  try {
    const configPath = path.join(dir, '.trae', 'traecli.toml')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      'model = "default"',
      '',
      '[features]',
      'experimental = true',
      '',
      '[[hooks.SessionStart]]',
      '[[hooks.SessionStart.hooks]]',
      'type = "command"',
      'command = "echo keep"',
      ''
    ].join('\n'))

    runScript('scripts/setup/traex.js', ['install'], dir)
    runScript('scripts/setup/traex.js', ['status'], dir)
    runScript('scripts/setup/traex.js', ['install'], dir)

    const installed = fs.readFileSync(configPath, 'utf-8')
    assert.ok(installed.includes('model = "default"'))
    assert.ok(installed.includes('experimental = true'))
    assert.ok(installed.includes('command = "echo keep"'))
    assert.ok(installed.includes('[features]\nhooks = true'))
    assert.ok(installed.includes('scripts/hooks/generic.js'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('traex'))
    assert.ok(installed.includes('[[hooks.PermissionRequest]]'))
    assert.ok(installed.includes('timeout = 86400'))
    assert.strictEqual(installed.split('\n').filter(line => line === '[[hooks.SessionStart]]').length, 2)
    assert.strictEqual(installed.split('\n').filter(line => line === '[[hooks.PreToolUse]]').length, 1)
    assert.strictEqual(TRAEX_HOOK_EVENTS.length, 12)

    runScript('scripts/setup/traex.js', ['uninstall'], dir)
    const removed = fs.readFileSync(configPath, 'utf-8')
    assert.ok(removed.includes('command = "echo keep"'))
    assert.ok(removed.includes('hooks = true'))
    assert.ok(!removed.includes('--agent') || !removed.includes('traex'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes setup manager preserves unrelated YAML and hooks', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.hermes', 'config.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, [
      'model: hermes-3',
      'hooks:',
      '  pre_tool_call:',
      '    - command: "echo keep"',
      'theme: dark'
    ].join('\n') + '\n')

    runScript('scripts/setup/hermes.js', ['install'], dir)
    runScript('scripts/setup/hermes.js', ['status'], dir)

    const installed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(installed.includes('model: hermes-3'))
    assert.ok(installed.includes('command: "echo keep"'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('hermes'))
    assert.ok(installed.includes('on_session_start:'))
    assert.ok(installed.includes('hooks_auto_accept: true'))
    assert.ok(installed.includes('timeout: 300'))
    assert.ok(!installed.includes('subagent_start:'))
    assert.ok(installed.includes('theme: dark'))
    assert.ok(installed.indexOf('on_session_start:') < installed.indexOf('theme: dark'))

    runScript('scripts/setup/hermes.js', ['uninstall'], dir)
    const removed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(removed.includes('command: "echo keep"'))
    assert.ok(!removed.includes('--agent') || !removed.includes('hermes'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes setup manager appends to commented existing event headers', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.hermes', 'config.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, [
      'model: hermes-3',
      'hooks:',
      '  pre_tool_call: # keep user hook',
      '    - command: "echo keep"',
      'theme: dark'
    ].join('\n') + '\n')

    runScript('scripts/setup/hermes.js', ['install'], dir)

    const installed = fs.readFileSync(settingsPath, 'utf-8')
    const lines = installed.split('\n')
    const hooksIndex = lines.indexOf('hooks:')
    assert.strictEqual(/^    - command: /.test(lines[hooksIndex + 1] || ''), false)

    const headerIndex = lines.findIndex(line => line === '  pre_tool_call: # keep user hook')
    assert.ok(headerIndex > hooksIndex)
    const nextHeaderIndex = lines.findIndex((line, index) => index > headerIndex && /^\s{2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line))
    const eventBlock = lines.slice(headerIndex, nextHeaderIndex < 0 ? lines.length : nextHeaderIndex).join('\n')
    assert.ok(eventBlock.includes('command: "echo keep"'))
    assert.ok(eventBlock.includes('--agent'))
    assert.ok(eventBlock.includes('hermes'))
    assert.ok(eventBlock.includes('timeout: 300'))

    runScript('scripts/setup/hermes.js', ['uninstall'], dir)
    const removed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(removed.includes('  pre_tool_call: # keep user hook'))
    assert.ok(removed.includes('command: "echo keep"'))
    assert.ok(!removed.includes('--agent') || !removed.includes('hermes'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Trae setup manager preserves YAML without hooks and trailing newline', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.trae', 'traecli.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, 'model: default')

    runScript('scripts/setup/coco.js', ['install'], dir)

    const installed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(installed.startsWith('model: default\n\nhooks:\n'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('trae'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes setup manager preserves YAML without hooks and trailing newline', () => {
  const dir = tempDir()
  try {
    const settingsPath = path.join(dir, '.hermes', 'config.yaml')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, 'model: hermes-3')

    runScript('scripts/setup/hermes.js', ['install'], dir)

    const installed = fs.readFileSync(settingsPath, 'utf-8')
    assert.ok(installed.includes('hooks_auto_accept: true'))
    assert.ok(installed.includes('model: hermes-3'))
    assert.ok(installed.includes('hooks:\n'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('hermes'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes setup installs canonical config and only cleans legacy cli-config', () => {
  const dir = tempDir()
  try {
    const legacyPath = path.join(dir, '.hermes', 'cli-config.yaml')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, [
      'hooks:',
      '  pre_llm_call:',
      '    - command: "echo keep"',
      `    - command: "node ${path.join(__dirname, '..', 'scripts/hooks/generic.js')} --agent hermes"`
    ].join('\n') + '\n')

    runScript('scripts/setup/hermes.js', ['install'], dir)
    const canonicalPath = path.join(dir, '.hermes', 'config.yaml')
    const canonical = fs.readFileSync(canonicalPath, 'utf-8')
    const legacy = fs.readFileSync(legacyPath, 'utf-8')
    assert.ok(canonical.includes('hooks_auto_accept: true'))
    assert.ok(canonical.includes('timeout: 300'))
    assert.ok(canonical.includes('subagent_stop:'))
    assert.ok(!canonical.includes('subagent_start:'))
    assert.ok(legacy.includes('command: "echo keep"'))
    assert.ok(!legacy.includes('--agent hermes'))
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

test('OpenCode managed plugin carries exact child filtering and archive lifecycle logic', () => {
  const dir = tempDir()
  try {
    runScript('scripts/setup/opencode.js', ['install'], dir)
    const pluginFile = path.join(dir, '.config', 'opencode', 'plugins', 'tmux-scout-opencode-plugin.js')
    const content = fs.readFileSync(pluginFile, 'utf-8')
    assert.ok(content.includes('version: v2'))
    assert.ok(content.includes('const childSessions = new Set()'))
    assert.ok(content.includes('p.part.state?.metadata?.sessionId'))
    assert.ok(content.includes('p.info?.parentID'))
    assert.ok(content.includes('childSessions.has(p.sessionID)'))
    assert.ok(content.includes('p.info.time?.archived'))
    assert.ok(content.includes('makePayload("SessionEnd"'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode setup accepts JSONC comments and trailing commas', () => {
  const dir = tempDir()
  try {
    const configPath = path.join(dir, '.config', 'opencode', 'opencode.json')
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, [
      '{',
      '  // OpenCode accepts JSONC',
      '  "server": "https://example.com/a//b",',
      '  "labels": ["text,]inside",],',
      '}'
    ].join('\n'))

    runScript('scripts/setup/opencode.js', ['install'], dir)
    const installed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    assert.strictEqual(installed.server, 'https://example.com/a//b')
    assert.deepStrictEqual(installed.labels, ['text,]inside'])
    assert.ok(installed.plugin.some(ref => ref.includes('tmux-scout-opencode-plugin.js')))
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
      'scripts/setup/opencode.js',
      'scripts/setup/traex.js'
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
  for (const agent of AGENTS) {
    assert.match(agent.brandColor, /^#[0-9a-f]{6}$/i)
    assert.match(agent.color, /^38;5;(?:1[6-9]|[2-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/)
  }
  assert.deepStrictEqual(agentDisplay('codex'), { label: 'codex', color: '38;5;36' })
  assert.deepStrictEqual(agentDisplay('trae'), { label: 'trae', color: '38;5;84' })
  assert.strictEqual(scoreAgentProcess({ basename: 'opencode', commandLine: '/usr/bin/opencode' }, 'opencode'), 100)
  assert.strictEqual(scoreAgentProcess({ basename: 'traex', commandLine: '/usr/local/bin/traex' }, 'traex'), 100)
  assert.strictEqual(scoreAgentProcess({ basename: 'gh', commandLine: 'gh copilot suggest' }, 'copilot-cli'), 70)
  assert.strictEqual(scoreAgentProcess({ basename: 'node', commandLine: 'node /bin/gemini-cli' }, 'gemini'), 70)
})

test('README agent color tables match registry', () => {
  function readColorRows(relativePath) {
    const lines = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf-8').split('\n')
    const headerIndex = lines.findIndex(line => /^\| Agent \| .*\| .*\| .*(?:color|颜色) \|$/i.test(line))
    assert.ok(headerIndex >= 0, `${relativePath} is missing agent color table`)

    const rows = []
    for (const line of lines.slice(headerIndex + 2)) {
      if (!line.startsWith('|')) break
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replace(/`/g, ''))
      const [, colorHex] = cells[3].match(/(#[0-9a-f]{6})/i) || []
      rows.push({
        agent: cells[0],
        label: cells[1],
        flag: cells[2],
        colorHex
      })
    }
    return rows
  }

  const expected = agentColorRows().map(row => ({
    agent: row.agent,
    label: row.label,
    flag: row.flag,
    colorHex: row.colorHex
  }))
  assert.deepStrictEqual(readColorRows('README.md'), expected)
  assert.deepStrictEqual(readColorRows('README_CN.md'), expected)
  const englishReadme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8')
  const chineseReadme = fs.readFileSync(path.join(__dirname, '..', 'README_CN.md'), 'utf-8')
  assert.ok(!englishReadme.includes('Brand color'))
  assert.ok(!englishReadme.includes('xterm'))
  assert.ok(!chineseReadme.includes('品牌色'))
  assert.ok(!chineseReadme.includes('xterm'))
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

test('hook runtime skips quoted sh wrapper around scout hook script', () => {
  const wrapperCmd = "/bin/sh -c [ -e '/Users/bytedance/repos/tmux-scout/scripts/hooks/claude.js' ] || exit 0; node '/Users/bytedance/repos/tmux-scout/scripts/hooks/claude.js'"
  const hookCmd = "node /Users/bytedance/repos/tmux-scout/scripts/hooks/claude.js"
  const processes = [
    { pid: 100, ppid: 1, command: '/opt/homebrew/bin/claude', args: 'claude --dangerously-skip-permissions', commandLine: 'claude --dangerously-skip-permissions', basename: 'claude' },
    { pid: 200, ppid: 100, command: '/bin/sh', args: wrapperCmd, commandLine: wrapperCmd, basename: 'sh' },
    { pid: 300, ppid: 200, command: process.execPath, args: hookCmd, commandLine: hookCmd, basename: 'node' }
  ]
  const byPid = new Map()
  const childrenByPpid = new Map()
  for (const proc of processes) {
    byPid.set(proc.pid, proc)
    if (!childrenByPpid.has(proc.ppid)) childrenByPpid.set(proc.ppid, [])
    childrenByPpid.get(proc.ppid).push(proc)
  }

  const resolved = resolveAgentProcess({
    agentType: 'claude',
    hookPid: 300,
    parentPid: 200,
    processTable: { byPid, childrenByPpid },
    panePidResolver: () => null
  })

  assert.strictEqual(resolved.pid, 100, 'should resolve to the real claude process, not the sh wrapper')
  assert.strictEqual(resolved.pidSource, 'parent-chain')
  assert.ok(resolved.pidCommand && resolved.pidCommand.startsWith('claude'), 'pidCommand should describe the real claude process')
})

test('hook filter identifies quoted sh wrappers around scout hook scripts', () => {
  const wrapperCmd = "/bin/sh -c [ -e '/Users/x/scripts/hooks/claude.js' ] || exit 0; node '/Users/x/scripts/hooks/claude.js'"
  assert.strictEqual(
    isScoutHookProcess({ basename: 'sh', commandLine: wrapperCmd, command: '/bin/sh' }),
    true,
    'sh wrapper that quotes the hook script path should still be classified as a scout hook'
  )
  assert.strictEqual(
    isScoutHookProcess({ basename: 'claude', commandLine: 'claude --dangerously-skip-permissions', command: '/usr/local/bin/claude' }),
    false
  )
})

test('agent scoring matches real agent binaries including node-wrapped JS entrypoints', () => {
  assert.strictEqual(
    scoreAgentProcess({ basename: 'claude', commandLine: 'claude --dangerously-skip-permissions', command: '/usr/local/bin/claude' }, 'claude'),
    100
  )
  assert.strictEqual(
    scoreAgentProcess({ basename: 'node', commandLine: 'node /usr/local/bin/claude', command: '/usr/bin/node' }, 'claude'),
    70,
    'invoking claude via node wrapper still matches via /claude path needle'
  )
  assert.strictEqual(
    scoreAgentProcess({ basename: 'node', commandLine: 'node /Users/foo/.claude/local/claude.js --resume', command: '/usr/bin/node' }, 'claude'),
    70,
    'node-wrapped claude.js entrypoint must match (regex accepts .js/.mjs/.cjs suffix)'
  )
  assert.ok(
    scoreAgentProcess({ basename: 'node', commandLine: 'node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js', command: '/usr/bin/node' }, 'codex') > 0,
    'npm-style codex install (node /path/to/codex.js) must still match the codex agent'
  )
})

test('agent scoring rejects transient shells spawned by claude with /tmp/claude-XXX-cwd in argv', () => {
  const transientShellCmd = "/bin/zsh -c source /Users/foo/.claude/shell-snapshots/snap.sh && eval 'ls' && pwd -P >| /tmp/claude-abc123-cwd"
  assert.strictEqual(
    scoreAgentProcess({ basename: 'zsh', commandLine: transientShellCmd, command: '/bin/zsh' }, 'claude'),
    0,
    'transient zsh that claude spawns for Bash tool calls must not be scored as a claude agent process'
  )
  // Even non-shell processes whose argv mentions /tmp/claude-XXX-cwd must not match.
  assert.strictEqual(
    scoreAgentProcess({ basename: 'cat', commandLine: 'cat /tmp/claude-abc123-cwd', command: '/bin/cat' }, 'claude'),
    0,
    'argv mentioning /tmp/claude-XXX-cwd must not match the anchored claude needle'
  )
  // Shell-basename exclusion applies to every agent, not just claude.
  assert.strictEqual(
    scoreAgentProcess({ basename: 'bash', commandLine: '/bin/bash -c "codex"', command: '/bin/bash' }, 'codex'),
    0,
    'shells are never agent processes regardless of needle matches'
  )
})

test('hook runtime ancestor walk skips transient shells and returns the real claude', () => {
  // pid 300 is the hook process. Walking up: pid 200 is a transient zsh whose argv contains
  // /tmp/claude-XXX-cwd (would have scored 70 under the old loose regex), pid 100 is the real
  // claude binary. The shell-basename exclusion makes the zsh score 0, so the walk steps past
  // it and binds to the real claude — regardless of first-match vs. highest-scorer semantics.
  const processes = [
    { pid: 100, ppid: 1, command: '/opt/homebrew/bin/claude', args: 'claude --dangerously-skip-permissions', commandLine: 'claude --dangerously-skip-permissions', basename: 'claude' },
    { pid: 200, ppid: 100, command: '/bin/zsh', args: "zsh -c 'pwd -P >| /tmp/claude-abc-cwd'", commandLine: "zsh -c 'pwd -P >| /tmp/claude-abc-cwd'", basename: 'zsh' },
    { pid: 300, ppid: 200, command: process.execPath, args: 'node scripts/hooks/claude.js', commandLine: 'node scripts/hooks/claude.js', basename: 'node' }
  ]
  const byPid = new Map()
  const childrenByPpid = new Map()
  for (const proc of processes) {
    byPid.set(proc.pid, proc)
    if (!childrenByPpid.has(proc.ppid)) childrenByPpid.set(proc.ppid, [])
    childrenByPpid.get(proc.ppid).push(proc)
  }

  const resolved = resolveAgentProcess({
    agentType: 'claude',
    hookPid: 300,
    parentPid: 200,
    processTable: { byPid, childrenByPpid },
    panePidResolver: () => null
  })

  assert.strictEqual(resolved.pid, 100, 'should walk past the transient zsh and bind to the real claude')
  assert.strictEqual(resolved.pidSource, 'parent-chain')
})

test('hook runtime ancestor walk binds to the NEAREST agent in a nested same-type chain', () => {
  // Outer claude wraps a child shell which wraps an inner claude which wraps the hook.
  // Both claudes score, but the inner pid is the real owner of this hook event — binding
  // to the outer would mean a child session's PID never dies when the inner process exits.
  const processes = [
    { pid: 100, ppid: 1, command: '/opt/homebrew/bin/claude', args: 'claude', commandLine: 'claude', basename: 'claude' },
    { pid: 200, ppid: 100, command: '/bin/zsh', args: 'zsh -c claude', commandLine: 'zsh -c claude', basename: 'zsh' },
    { pid: 300, ppid: 200, command: '/usr/bin/node', args: 'node /usr/local/bin/claude.js', commandLine: 'node /usr/local/bin/claude.js', basename: 'node' },
    { pid: 400, ppid: 300, command: process.execPath, args: 'node scripts/hooks/claude.js', commandLine: 'node scripts/hooks/claude.js', basename: 'node' }
  ]
  const byPid = new Map()
  const childrenByPpid = new Map()
  for (const proc of processes) {
    byPid.set(proc.pid, proc)
    if (!childrenByPpid.has(proc.ppid)) childrenByPpid.set(proc.ppid, [])
    childrenByPpid.get(proc.ppid).push(proc)
  }

  const resolved = resolveAgentProcess({
    agentType: 'claude',
    hookPid: 400,
    parentPid: 300,
    processTable: { byPid, childrenByPpid },
    panePidResolver: () => null
  })

  assert.strictEqual(resolved.pid, 300, 'should bind to the inner claude (nearest ancestor), not the outer claude binary')
  assert.strictEqual(resolved.pidSource, 'parent-chain')
})

test('sync sweepDeadProcesses rebinds to a live agent under the pane instead of marking stale', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })

    const liveClaudePid = process.pid // the test process is alive by definition
    const deadPid = 0x7fffffff // arbitrary high pid that's certain to be missing
    const panePid = 555000
    const now = Date.now()

    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        stuck: {
          sessionId: 'stuck',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          tmuxPane: '%42',
          pid: deadPid,
          pidSource: 'parent-chain',
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

    // Build a fake process table: pane shell → claude (the test process, alive).
    // claude.startedAtMs predates session.startedAt — this is the same long-lived
    // agent, the original pid binding was just wrong.
    const byPid = new Map()
    const childrenByPpid = new Map()
    const paneShell = { pid: panePid, ppid: 1, command: '/bin/zsh', args: '-zsh', commandLine: '-zsh', basename: 'zsh', startedAtMs: now - 600000 }
    const claudeProc = { pid: liveClaudePid, ppid: panePid, command: '/opt/homebrew/bin/claude', args: 'claude --dangerously-skip-permissions', commandLine: 'claude --dangerously-skip-permissions', basename: 'claude', startedAtMs: now - 120000 }
    byPid.set(paneShell.pid, paneShell)
    byPid.set(claudeProc.pid, claudeProc)
    childrenByPpid.set(1, [paneShell])
    childrenByPpid.set(panePid, [claudeProc])

    const panes = new Map([['%42', { paneId: '%42', panePid, currentCommand: 'claude', paneDead: false }]])
    panes.tmuxAvailable = true

    const stats = sync.createStats()
    sync.clearPidStateCache()
    sync.sweepDeadProcesses(initResult.status, panes, { byPid, childrenByPpid }, stats)

    const reloaded = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(reloaded.sessions.stuck.status, 'working', 'session must remain working — the agent is still alive under the pane')
    assert.strictEqual(reloaded.sessions.stuck.pid, liveClaudePid, 'session.pid must be rebound to the live claude descendant')
    assert.strictEqual(reloaded.sessions.stuck.pidSource, 'process-tree')
    assert.strictEqual(stats.reconcile.pidBindings, 1)
    assert.strictEqual(stats.reconcile.processExits, 0, 'no STALE/PROCESS_EXIT_DETECTED should be emitted when the pane still has a live agent')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync discovers tmux agent panes without an existing hook snapshot', () => {
  const now = Date.now()
  const panePid = 555050
  const agentPid = 555051
  const status = { version: 1, lastUpdated: now, sessions: {} }
  const panes = new Map([['%77', {
    paneId: '%77',
    panePid,
    currentCommand: 'zsh',
    paneDead: false,
    sessionName: 'work',
    windowIndex: 3,
    windowName: 'agent',
    currentPath: '/Users/me/repos/demo-project'
  }]])
  panes.tmuxAvailable = true

  const processTable = (agentStartedAtMs) => {
    const paneShell = { pid: panePid, ppid: 1, command: '/bin/zsh', args: '-zsh', commandLine: '-zsh', basename: 'zsh', startedAtMs: now - 600000 }
    const claudeProc = { pid: agentPid, ppid: panePid, command: '/opt/homebrew/bin/claude', args: 'claude', commandLine: 'claude', basename: 'claude', startedAtMs: agentStartedAtMs }
    return {
      byPid: new Map([[paneShell.pid, paneShell], [claudeProc.pid, claudeProc]]),
      childrenByPpid: new Map([[1, [paneShell]], [panePid, [claudeProc]]])
    }
  }
  const stats = sync.createStats()

  const changed = sync.discoverPaneSessions(status, panes, processTable(now - 300000), stats, {
    now,
    writeSession: false,
    writeStatus: false
  })

  const id = sync.discoverySessionId('claude', '%77')
  const session = status.sessions[id]
  assert.strictEqual(changed, true)
  assert.ok(session, 'discovered session should be registered')
  assert.strictEqual(session.agentType, 'claude')
  assert.strictEqual(session.tmuxPane, '%77')
  assert.strictEqual(session.workingDirectory, '/Users/me/repos/demo-project')
  assert.strictEqual(session.pid, agentPid)
  assert.strictEqual(session.phase, SESSION_PHASES.IDLE)
  assert.strictEqual(session.status, 'idle')
  assert.strictEqual(session.stateSource, 'pane-discovery')
  assert.strictEqual(isVisibleInPicker(session), 'hidden')
  assert.deepStrictEqual(getActiveSessions(status, panes), [])
  assert.strictEqual(session.stateEvidence[0].rawEventName, 'tmux_pane_discovered')
  assert.strictEqual(stats.reconcile.paneDiscoveries, 1)

  const second = sync.discoverPaneSessions(status, panes, processTable(now - 299003), stats, {
    now: now + 1000,
    writeSession: false,
    writeStatus: false
  })
  assert.strictEqual(second, false, 'unchanged discovery should not rewrite every tick')
  assert.strictEqual(stats.reconcile.discoveryUpdates, 0)
})

test('sync removes discovered placeholder when a real hook session exists in the same pane', () => {
  const now = Date.now()
  const panePid = 555060
  const agentPid = 555061
  const placeholderId = sync.discoverySessionId('trae', '%78')
  const status = {
    version: 1,
    lastUpdated: now,
    sessions: {
      [placeholderId]: {
        sessionId: placeholderId,
        agentType: 'trae',
        phase: 'idle',
        status: 'idle',
        tmuxPane: '%78',
        pid: agentPid,
        stateSource: 'pane-discovery',
        lastEvent: { type: AGENT_EVENTS.DISCOVERED, rawEventName: 'tmux_pane_discovered' }
      },
      real: {
        sessionId: 'real',
        agentType: 'coco',
        phase: 'running',
        status: 'working',
        tmuxPane: '%78',
        pid: agentPid,
        stateSource: 'hook',
        lastUpdated: now
      }
    }
  }
  const panes = new Map([['%78', {
    paneId: '%78',
    panePid,
    currentCommand: 'trae',
    paneDead: false,
    sessionName: 'work',
    windowIndex: 4,
    windowName: 'trae'
  }]])
  panes.tmuxAvailable = true
  const paneShell = { pid: panePid, ppid: 1, command: '/bin/zsh', args: '-zsh', commandLine: '-zsh', basename: 'zsh', startedAtMs: now - 600000 }
  const traeProc = { pid: agentPid, ppid: panePid, command: '/usr/local/bin/trae', args: 'trae', commandLine: 'trae', basename: 'trae', startedAtMs: now - 300000 }
  const byPid = new Map([[paneShell.pid, paneShell], [traeProc.pid, traeProc]])
  const childrenByPpid = new Map([[1, [paneShell]], [panePid, [traeProc]]])
  const stats = sync.createStats()

  const changed = sync.discoverPaneSessions(status, panes, { byPid, childrenByPpid }, stats, {
    now,
    writeSession: false,
    writeStatus: false
  })

  assert.strictEqual(changed, true)
  assert.strictEqual(status.sessions[placeholderId], undefined)
  assert.ok(status.sessions.real, 'real hook session should remain')
  assert.strictEqual(stats.reconcile.discoveryReplacements, 1)
})

test('sync sweepDeadProcesses refuses to rebind to an agent that started AFTER the session (rapid restart)', () => {
  // Scenario: the original agent process exited, then the user started a fresh agent
  // in the same pane. The new process is NOT the same session — sync must mark the
  // old session interrupted/processExit instead of silently rebinding to the new process.
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })

    const newAgentPid = process.pid
    const deadPid = 0x7fffffff
    const panePid = 555100
    const now = Date.now()

    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        old: {
          sessionId: 'old',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          tmuxPane: '%43',
          pid: deadPid,
          pidSource: 'parent-chain',
          startedAt: now - 120000,
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

    // Fresh claude started AFTER the old session began — startedAtMs > session.startedAt.
    const byPid = new Map()
    const childrenByPpid = new Map()
    const paneShell = { pid: panePid, ppid: 1, command: '/bin/zsh', args: '-zsh', commandLine: '-zsh', basename: 'zsh', startedAtMs: now - 600000 }
    const freshClaude = { pid: newAgentPid, ppid: panePid, command: '/opt/homebrew/bin/claude', args: 'claude', commandLine: 'claude', basename: 'claude', startedAtMs: now - 5000 }
    byPid.set(paneShell.pid, paneShell)
    byPid.set(freshClaude.pid, freshClaude)
    childrenByPpid.set(1, [paneShell])
    childrenByPpid.set(panePid, [freshClaude])

    const panes = new Map([['%43', { paneId: '%43', panePid, currentCommand: 'claude', paneDead: false }]])
    panes.tmuxAvailable = true

    const stats = sync.createStats()
    sync.clearPidStateCache()
    sync.sweepDeadProcesses(initResult.status, panes, { byPid, childrenByPpid }, stats)

    const reloaded = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.notStrictEqual(reloaded.sessions.old.pid, newAgentPid, 'must NOT rebind to a fresh agent that started after the session')
    assert.strictEqual(reloaded.sessions.old.status, 'interrupted')
    assert.strictEqual(reloaded.sessions.old.terminalKind, 'processExit')
    assert.strictEqual(stats.reconcile.pidBindings, 0, 'no rebind should happen when the live agent post-dates the session')
    assert.strictEqual(stats.reconcile.processExits, 1, 'PROCESS_EXIT_DETECTED must fire so the new agent can claim a fresh session')

    const secondStats = sync.createStats()
    sync.clearPidStateCache()
    sync.sweepDeadProcesses(initResult.status, panes, { byPid, childrenByPpid }, secondStats)
    const secondReload = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(secondReload.sessions.old.status, 'interrupted')
    assert.strictEqual(secondReload.sessions.old.terminalKind, 'processExit')
    assert.strictEqual(secondStats.reconcile.processExits, 0, 'recorded process exits must not be reswept into stale')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('phaseDecision stale recovery requires a hook event newer than the stale transition', () => {
  const staleAt = Date.now() - 1000
  const baseSession = () => ({
    sessionId: 'recover',
    agentType: 'claude',
    phase: 'stale',
    status: 'stale',
    endedAt: staleAt,
    stateSource: 'pid',
    stateConfidence: 95,
    lifecycle: { phase: 'stale', source: 'pid', priority: 95, updatedAt: staleAt }
  })

  // Hook event newer than stale transition — recovers.
  const fresh = baseSession()
  const freshResult = applySessionEvent(fresh, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'claude-hooks',
    timestamp: staleAt + 5000
  })
  assert.strictEqual(freshResult.applied, true, 'hook event newer than stale transition must recover')
  assert.strictEqual(currentPhase(fresh), 'running')
  assert.strictEqual(fresh.endedAt, null, 'recovery must clear endedAt so the picker shows the session again')

  // Hook event delivered late but generated BEFORE the stale transition — blocked.
  const lateDelivery = baseSession()
  const lateResult = applySessionEvent(lateDelivery, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'claude-hooks',
    timestamp: staleAt - 5000
  })
  assert.strictEqual(lateResult.applied, false, 'delayed hook with old timestamp must not resurrect a stale session')
  assert.strictEqual(currentPhase(lateDelivery), 'stale')
  assert.strictEqual(lateDelivery.endedAt, staleAt, 'endedAt must not be cleared by an old event')

  // Transcript-sourced events are never allowed to recover, regardless of timestamp.
  const transcriptSession = baseSession()
  const transcriptResult = applySessionEvent(transcriptSession, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'transcript',
    timestamp: staleAt + 5000
  })
  assert.strictEqual(transcriptResult.applied, false, 'transcript-sourced events must not resurrect stale sessions')
  assert.strictEqual(currentPhase(transcriptSession), 'stale')
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

test('bridge server applies session delete events to the registry', async () => {
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

    context.updateSession('delete-session', {
      status: 'working',
      lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: 1000, details: 'hello' }
    })
    await context.flush()
    assert.ok(fs.existsSync(path.join(paths.sessionsDir, 'delete-session.json')))

    context.updateSession('delete-session', {
      lastEvent: { type: AGENT_EVENTS.SESSION_DELETE, timestamp: 2000, details: 'dismissed' }
    })
    await context.flush()

    const status = JSON.parse(fs.readFileSync(paths.statusFile, 'utf-8'))
    assert.strictEqual(status.sessions['delete-session'], undefined)
    assert.strictEqual(fs.existsSync(path.join(paths.sessionsDir, 'delete-session.json')), false)
  } finally {
    if (bridge) bridge.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hook persistence keeps redundant permission resolution byte-for-byte inert', async () => {
  const dir = tempDir()
  try {
    const paths = defaultPaths(dir)
    const context = createHookContext({
      agentType: 'codex',
      defaultStateSource: 'codex-hooks',
      paths
    })
    context.updateSession('resolver-persisted', {
      status: 'working',
      lastHookEventName: 'UserPromptSubmit',
      lastUserPrompt: 'run tests',
      lastEvent: { type: AGENT_EVENTS.PROMPT_SUBMIT, timestamp: 1000, details: 'run tests' }
    })
    await context.flush()

    const sessionFile = path.join(paths.sessionsDir, 'resolver-persisted.json')
    const beforeSession = fs.readFileSync(sessionFile, 'utf-8')
    const beforeStatus = fs.readFileSync(paths.statusFile, 'utf-8')

    context.updateSession('resolver-persisted', {
      status: 'completed',
      lastHookEventName: 'PostToolUse',
      lastEvent: { type: AGENT_EVENTS.PERMISSION_RESOLVED, timestamp: 9000, details: 'duplicate' }
    })
    context.updateSession('resolver-ghost', {
      lastHookEventName: 'PostToolUse',
      lastEvent: { type: AGENT_EVENTS.PERMISSION_RESOLVED, timestamp: 9000, details: 'orphan' }
    })
    await context.flush()

    assert.strictEqual(fs.readFileSync(sessionFile, 'utf-8'), beforeSession)
    assert.strictEqual(fs.readFileSync(paths.statusFile, 'utf-8'), beforeStatus)
    assert.strictEqual(fs.existsSync(path.join(paths.sessionsDir, 'resolver-ghost.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('agent event aliases normalize to persisted event names', () => {
  assert.strictEqual(normalizeAgentEventType('sessionStarted'), AGENT_EVENTS.SESSION_START)
  assert.strictEqual(normalizeAgentEventType('toolUseStarted'), AGENT_EVENTS.TOOL_USE)
  assert.strictEqual(normalizeAgentEventType('subagentStarted'), AGENT_EVENTS.SUBAGENT_START)
  assert.strictEqual(normalizeAgentEventType('sessionDeleted'), AGENT_EVENTS.SESSION_DELETE)
  assert.strictEqual(normalizeAgentEventType('permissionResolved'), AGENT_EVENTS.PERMISSION_RESOLVED)
  assert.strictEqual(normalizeAgentEventType('questionAnswered'), AGENT_EVENTS.QUESTION_ANSWERED)
  assert.strictEqual(normalizeAgentEventType('activityUpdated'), AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
  assert.strictEqual(normalizeAgentEventType('processDetached'), AGENT_EVENTS.PROCESS_DETACHED)
  assert.strictEqual(normalizeAgentEventType(AGENT_EVENTS.PERMISSION_REQUEST), AGENT_EVENTS.PERMISSION_REQUEST)
  assert.strictEqual(createAgentEvent({ type: 'sessionCompleted', isSessionEnd: false }).type, AGENT_EVENTS.STOP)
  assert.strictEqual(createAgentEvent({ type: 'sessionCompleted', isSessionEnd: true }).type, AGENT_EVENTS.SESSION_END)
  assert.strictEqual(createAgentEvent({ type: 'sessionCompleted' }).preserveSessionEnd, true)
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

test('canonical sessionCompleted distinguishes true, false, and omitted end flags', () => {
  const session = { sessionId: 'canonical-completion-end-bit', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, createAgentEvent({
    type: 'sessionCompleted',
    isSessionEnd: true,
    source: 'hook',
    timestamp: 1100
  }))
  assert.strictEqual(currentPhase(session), 'completed')
  assert.strictEqual(session.endedAt, 1100)

  applySessionEvent(session, createAgentEvent({
    type: 'sessionCompleted',
    source: 'hook',
    timestamp: 1200
  }))
  assert.strictEqual(session.endedAt, 1100, 'omitted isSessionEnd inherits the ended bit')

  applySessionEvent(session, createAgentEvent({
    type: 'sessionCompleted',
    isSessionEnd: false,
    source: 'hook',
    timestamp: 1300
  }))
  assert.strictEqual(session.endedAt, null, 'explicit false clears the ended bit')
})

test('session contract maps events to canonical phases', () => {
  assert.strictEqual(statusForPhase(SESSION_PHASES.WAITING_FOR_APPROVAL), 'working')
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.SESSION_START }), SESSION_PHASES.RUNNING)
  assert.strictEqual(phaseFromLegacyStatus('crashed', 'waiting for approval'), SESSION_PHASES.CRASHED)
  assert.strictEqual(phaseFromLegacyStatus('stale', 'waiting for answer'), SESSION_PHASES.STALE)
  assert.strictEqual(phaseFromLegacyStatus('interrupted', 'waiting for approval'), SESSION_PHASES.INTERRUPTED)
  assert.strictEqual(phaseForAgentEvent({ type: 'permissionRequested' }), SESSION_PHASES.WAITING_FOR_APPROVAL)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.QUESTION_ASKED }), SESSION_PHASES.WAITING_FOR_ANSWER)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PANE_STATE, status: 'working' }), SESSION_PHASES.RUNNING)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PANE_STATE, status: 'crashed', needsAttention: 'waiting for approval' }), SESSION_PHASES.CRASHED)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.TRANSCRIPT_STATUS, needsAttention: 'waiting for answer' }), SESSION_PHASES.WAITING_FOR_ANSWER)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PROCESS_EXIT_DETECTED }), SESSION_PHASES.INTERRUPTED)
  assert.strictEqual(phaseForAgentEvent({ type: 'processDetached' }), undefined)
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.SESSION_DELETE }), undefined)

  const valid = validateAgentEvent(createAgentEvent('toolUseStarted', {
    source: 'hook',
    timestamp: 1000,
    activeTool: 'Read',
    turnId: 'turn-1'
  }))
  assert.strictEqual(valid.valid, true)
  assert.deepStrictEqual(valid.errors, [])

  const deleteValid = validateAgentEvent(createAgentEvent('sessionDeleted', {
    source: 'debug',
    timestamp: 1000
  }))
  assert.strictEqual(deleteValid.valid, true)
  assert.deepStrictEqual(deleteValid.errors, [])

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
    activeTool: 'Bash',
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

test('session contract computes phase-based picker visibility', () => {
  const now = 1_000_000_000_000
  const recent = now - 1000
  const old = now - 10 * 60 * 1000

  // Live phases with a bound pane defer to runtime pane/PID liveness.
  assert.strictEqual(isVisibleInPicker({ phase: 'running', tmuxPane: '%1' }, { now }), 'pane')
  assert.strictEqual(isVisibleInPicker({ phase: 'waitingForApproval', tmuxPane: '%1' }, { now }), 'pane')

  // No pane yet (JSONL-discovered): active phases show, idle/completed hide.
  assert.strictEqual(isVisibleInPicker({ phase: 'running' }, { now }), 'visible')
  assert.strictEqual(isVisibleInPicker({ phase: 'idle' }, { now }), 'hidden')
  assert.strictEqual(isVisibleInPicker({ phase: 'completed' }, { now }), 'hidden')
  assert.strictEqual(isVisibleInPicker({ phase: 'running', stateSource: 'codex-hooks' }, { now }), 'hidden')

  // Terminal phases linger briefly, then hide.
  assert.strictEqual(isVisibleInPicker({ phase: 'crashed', endedAt: recent, tmuxPane: '%1' }, { now }), 'visible')
  assert.strictEqual(isVisibleInPicker({ phase: 'crashed', endedAt: old, tmuxPane: '%1' }, { now }), 'hidden')
  assert.strictEqual(isVisibleInPicker({ phase: 'stale', endedAt: old }, { now }), 'hidden')
  assert.strictEqual(isVisibleInPicker({ phase: 'interrupted', lastUpdated: recent, tmuxPane: '%1' }, { now }), 'visible')

  // A finished turn with endedAt is hidden even if a pane is still bound.
  assert.strictEqual(isVisibleInPicker({ phase: 'completed', endedAt: recent, tmuxPane: '%1' }, { now }), 'hidden')
  // The protocol keeps a separate isSessionEnded flag. A late activity event may
  // update phase, but it cannot resurrect the row until a new turn starts.
  assert.strictEqual(isVisibleInPicker({ phase: 'running', endedAt: recent, tmuxPane: '%1' }, { now }), 'hidden')
  assert.strictEqual(isVisibleInPicker({ phase: 'waitingForApproval', endedAt: recent }, { now }), 'visible')

  // Legacy status-only snapshots resolve through phaseFromLegacyStatus.
  assert.strictEqual(isVisibleInPicker({ status: 'working' }, { now }), 'visible')
  assert.strictEqual(isVisibleInPicker(null, { now }), 'hidden')
})

test('session contract exports runtime schemas for debug and fixtures', () => {
  assert.strictEqual(SESSION_SCHEMAS.AgentEvent.required.type, FIELD_TYPES.STRING)
  assert.strictEqual(SESSION_SCHEMAS.SessionSnapshot.required.sessionId, FIELD_TYPES.STRING)
  assert.strictEqual(SESSION_SCHEMAS.PendingInteraction.required.phase, FIELD_TYPES.STRING)
  assert.strictEqual(SESSION_SCHEMAS.StateEvidence.required.timestamp, FIELD_TYPES.NUMBER)

  const shape = validateAgainstSchema({
    type: 'prompt_submit',
    timestamp: 1000,
    source: 'hook'
  }, SESSION_SCHEMAS.AgentEvent)
  assert.strictEqual(shape.valid, true)
  assert.deepStrictEqual(shape.errors, [])
  assert.deepStrictEqual(shape.warnings, [])

  const invalidShape = validateAgainstSchema({
    type: 'prompt_submit',
    pendingToolUse: 'Bash'
  }, SESSION_SCHEMAS.AgentEvent)
  assert.strictEqual(invalidShape.valid, true)
  assert.ok(invalidShape.warnings.includes('AgentEvent.pendingToolUse should be object when present'))
})

test('agent flow fixtures replay through real hook entrypoints', () => {
  const files = collectFixtureFiles()
  assert.ok(files.length >= 3)
  for (const file of files) {
    const result = runFlowFixture(file)
    try {
      assert.deepStrictEqual(result.errors, [], `${result.fixture.name}: ${result.errors.join('; ')}`)
      assert.deepStrictEqual(result.warnings, [], `${result.fixture.name}: ${result.warnings.join('; ')}`)
      assert.ok(result.session, `${result.fixture.name}: missing session`)
    } finally {
      result.cleanup()
    }
  }
})

test('flow fixture expectations can read status-prefixed paths', () => {
  const session = {
    sessionId: 'status-path-session',
    agentType: 'claude',
    phase: 'idle',
    status: 'idle',
    stateEvidence: []
  }
  const status = {
    version: 1,
    lastUpdated: 123,
    sessions: {
      [session.sessionId]: session
    }
  }
  const result = validateFixtureExpectations({
    name: 'status path fixture',
    sessionId: session.sessionId,
    expect: {
      'status.version': 1,
      'status.sessions.status-path-session.agentType': 'claude',
      phase: 'idle'
    }
  }, status, session)

  assert.deepStrictEqual(result.errors, [])
  assert.deepStrictEqual(result.warnings, [])
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

test('picker rows surface deferred completion on short wait details', () => {
  const session = {
    sessionId: 'session-deferred-wait',
    agentType: 'codex',
    status: 'working',
    phase: 'waitingForApproval',
    needsAttention: 'waiting for approval',
    pendingInteraction: {
      type: 'approval',
      phase: 'waitingForApproval',
      source: 'hook',
      reason: 'waiting for approval',
      details: 'Bash',
      tool: 'Bash'
    },
    deferredCompletion: {
      phase: 'completed',
      type: 'stop'
    },
    tmuxPane: '%1',
    workingDirectory: '/tmp/demo',
    _tmuxPaneSnapshot: { windowName: 'main' }
  }
  const line = stripAnsi(formatLine(session, Date.now(), '%1'))
  assert.ok(line.includes('W:APP'), line)
  assert.ok(line.includes('turn ended'), line)
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

test('picker ignores stale wait fields when canonical phase says BUSY or DONE', () => {
  const now = Date.now()
  const pane = {
    paneId: '%1',
    panePid: process.pid,
    currentCommand: 'node',
    paneDead: false,
    windowName: 'main'
  }
  const running = {
    sessionId: 'canonical-busy',
    agentType: 'codex',
    phase: 'running',
    status: 'completed',
    needsAttention: 'waiting for approval',
    pendingInteraction: {
      type: 'approval',
      phase: 'waitingForApproval',
      reason: 'waiting for approval'
    },
    pendingToolUse: { tool: 'Bash', details: 'Bash: stale-running-detail', timestamp: now - 5000 },
    tmuxPane: '%1',
    lastUpdated: now - 1000,
    _tmuxPaneSnapshot: pane
  }
  const staleDone = {
    sessionId: 'canonical-done',
    agentType: 'codex',
    phase: 'completed',
    status: 'working',
    needsAttention: 'waiting for answer',
    pendingToolUse: { tool: 'Read', details: 'Read: stale-done-detail', timestamp: now - 5000 },
    tmuxPane: '%1',
    lastUpdated: now,
    _tmuxPaneSnapshot: pane
  }

  const busyLine = stripAnsi(formatLine(running, now, '%9'))
  const doneLine = stripAnsi(formatLine(staleDone, now, '%9'))
  assert.ok(busyLine.includes('BUSY'), busyLine)
  assert.ok(!busyLine.includes('W:APP'), busyLine)
  assert.ok(!busyLine.includes('stale-running-detail'), busyLine)
  assert.ok(doneLine.includes('DONE'), doneLine)
  assert.ok(!doneLine.includes('W:ANS'), doneLine)
  assert.ok(!doneLine.includes('stale-done-detail'), doneLine)

  const busyDetails = stripAnsi(formatSessionDetails(running, { now }))
  const doneDetails = stripAnsi(formatSessionDetails(staleDone, { now }))
  assert.ok(!busyDetails.includes('stale-running-detail'), busyDetails)
  assert.ok(!doneDetails.includes('stale-done-detail'), doneDetails)

  const active = getActiveSessions({ sessions: { running, staleDone } }, new Map([['%1', pane]]))
  assert.deepStrictEqual(active.map(session => session.sessionId), ['canonical-busy'])
})

test('picker ordering: unvisited-but-recent session floats above stale prior visits', () => {
  const now = Date.now()
  const sessions = [
    {
      // Never jumped-to via the picker, but just became active (freshly created / BUSY).
      sessionId: 'fresh-unvisited',
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      tmuxPane: '%3',
      lastUpdated: now
    },
    {
      // Visited long ago; its more-recent activity must NOT bump its order.
      sessionId: 'visited-older',
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      tmuxPane: '%1',
      lastUpdated: now - 10000
    },
    {
      sessionId: 'visited-recent',
      agentType: 'codex',
      status: 'completed',
      phase: 'idle',
      tmuxPane: '%2',
      lastUpdated: now - 20000
    }
  ]

  // %2 was jumped-to 5s ago, %1 30s ago; %3 was never visited.
  const accessTimes = new Map([['%2', now - 5000], ['%1', now - 30000]])
  sessions.sort((left, right) => compareSessions(left, right, { accessTimes }))
  assert.deepStrictEqual(sessions.map(session => session.sessionId), [
    'fresh-unvisited', // unvisited, lastTouchedAt=now -> newest interaction -> top
    'visited-recent',  // visited 5s ago (activity time ignored for visited sessions)
    'visited-older'    // visited 30s ago
  ])
})

test('picker ordering falls back to activity recency when no access history', () => {
  const now = Date.now()
  const sessions = [
    { sessionId: 'older', agentType: 'codex', status: 'working', phase: 'running', tmuxPane: '%1', lastUpdated: now - 20000 },
    { sessionId: 'newer', agentType: 'codex', status: 'completed', phase: 'idle', tmuxPane: '%2', lastUpdated: now }
  ]

  sessions.sort((left, right) => compareSessions(left, right, { accessTimes: new Map() }))
  assert.deepStrictEqual(sessions.map(session => session.sessionId), ['newer', 'older'])
})

test('access history records most-recent-first, dedupes, and caps length', () => {
  const dir = tempDir()
  const file = path.join(dir, 'access-history.json')
  try {
    recordAccess('%1', { file, now: 1000 })
    recordAccess('%2', { file, now: 2000 })
    recordAccess('%1', { file, now: 3000 }) // revisit %1 -> moves to front, ts updated

    const times = readAccessTimes({ file })
    assert.strictEqual(times.get('%1'), 3000)
    assert.strictEqual(times.get('%2'), 2000)
    assert.strictEqual(times.size, 2)

    // Cap is honored: only the most recent `max` entries survive.
    recordAccess('%3', { file, now: 4000, max: 2 })
    const capped = readAccessTimes({ file })
    assert.strictEqual(capped.size, 2)
    assert.strictEqual(capped.get('%3'), 4000)
    assert.strictEqual(capped.get('%1'), 3000)
    assert.ok(!capped.has('%2'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('access history returns empty times when file is missing or corrupt', () => {
  const dir = tempDir()
  const missing = path.join(dir, 'nope.json')
  const corrupt = path.join(dir, 'corrupt.json')
  try {
    assert.strictEqual(readAccessTimes({ file: missing }).size, 0)
    fs.writeFileSync(corrupt, 'not json{')
    assert.strictEqual(readAccessTimes({ file: corrupt }).size, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// This is the exact path the pane-focus-in hook invokes: `access-history.js
// record %N`. record-focus.sh only restores PATH and forwards to it.
test('access history record CLI writes the focused pane to history (hook path)', () => {
  const home = tempDir()
  const file = path.join(home, '.tmux-scout', 'access-history.json')
  try {
    runScript('scripts/lib/access-history.js', ['record', '%5'], home)
    let data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    assert.strictEqual(data.entries[0].pane, '%5')

    runScript('scripts/lib/access-history.js', ['record', '%6'], home)
    data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    assert.strictEqual(data.entries[0].pane, '%6')
    assert.strictEqual(data.entries[1].pane, '%5')
    assert.strictEqual(data.entries.length, 2)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('access history record CLI rejects empty or non-pane arguments', () => {
  const home = tempDir()
  const file = path.join(home, '.tmux-scout', 'access-history.json')
  try {
    runScript('scripts/lib/access-history.js', ['record', ''], home)
    runScript('scripts/lib/access-history.js', ['record', 'garbage'], home)
    runScript('scripts/lib/access-history.js', ['record', '#{pane_id}'], home)
    assert.strictEqual(fs.existsSync(file), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('picker ordering reflects focus recency, with unfocused-active still bubbling up', () => {
  const dir = tempDir()
  const file = path.join(dir, 'access-history.json')
  try {
    recordAccess('%1', { file, now: 1000 })
    recordAccess('%2', { file, now: 2000 }) // %2 focused later than %1
    const times = readAccessTimes({ file })
    const now = Date.now()
    const sessions = [
      { sessionId: 'older-focus', agentType: 'codex', phase: 'idle', tmuxPane: '%1', lastUpdated: now },
      { sessionId: 'newer-focus', agentType: 'codex', phase: 'idle', tmuxPane: '%2', lastUpdated: now },
      // Never focused (no history entry) but freshly active → fallback lastTouchedAt.
      { sessionId: 'unfocused-active', agentType: 'codex', phase: 'running', tmuxPane: '%3', lastUpdated: now + 5000 }
    ]
    sessions.sort((left, right) => compareSessions(left, right, { accessTimes: times }))
    assert.deepStrictEqual(sessions.map(session => session.sessionId), [
      'unfocused-active', // lastTouchedAt newest -> top
      'newer-focus',      // focused at 2000
      'older-focus'       // focused at 1000
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('status bar treats canonical WAIT phase as wait even with stale legacy status', () => {
  const counts = statusBar.summarizeSessions([
    {
      status: 'completed',
      phase: 'waitingForApproval',
      pendingInteraction: { type: 'plan' }
    }
  ])

  assert.strictEqual(counts.wait, 1)
  assert.strictEqual(counts.plan, 1)
  assert.strictEqual(counts.done, 0)
  assert.strictEqual(counts.busy, 0)
})

test('status bar never lets stale legacy fields override canonical phase', () => {
  const counts = statusBar.summarizeSessions([
    {
      phase: 'completed',
      status: 'working',
      needsAttention: 'waiting for answer',
      pendingInteraction: { type: 'question' }
    },
    {
      phase: 'running',
      status: 'completed',
      needsAttention: 'waiting for plan approval',
      pendingInteraction: { type: 'plan' }
    },
    {
      phase: 'idle',
      status: 'working',
      needsAttention: 'waiting for approval'
    },
    {
      phase: 'waitingForAnswer',
      status: 'completed',
      pendingInteraction: { type: 'approval' }
    },
    {
      phase: 'waitingForApproval',
      status: 'completed',
      pendingInteraction: { type: 'question' }
    }
  ])

  assert.deepStrictEqual(counts, {
    wait: 2,
    busy: 1,
    done: 1,
    idle: 1,
    approval: 1,
    question: 1,
    plan: 0,
    total: 5
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

test('session details derive the headline from canonical phase', () => {
  const running = stripAnsi(formatSessionDetails({
    sessionId: 'details-running',
    agentType: 'codex',
    phase: 'running',
    status: 'idle',
    needsAttention: 'waiting for approval',
    lastUpdated: 1000
  }, { now: 2000 }))
  assert.ok(running.includes('BUSY'))
  assert.ok(!running.includes('WAITING'))

  const waiting = stripAnsi(formatSessionDetails({
    sessionId: 'details-waiting',
    agentType: 'codex',
    phase: 'waitingForAnswer',
    status: 'completed',
    needsAttention: null,
    lastUpdated: 1000
  }, { now: 2000 }))
  assert.ok(waiting.includes('WAITING'))
  assert.ok(!waiting.includes('DONE'))
})

test('debug CLI injects mock sessions and prints evidence', () => {
  const dir = tempDir()
  try {
    const injectOutput = runScriptOutput('scripts/debug.js', [
      'inject',
      '--home', dir,
      '--session-id', 'debug-wait',
      '--agent', 'codex',
      '--phase', 'waitingForApproval',
      '--title', 'debug approval',
      '--details', 'Bash: npm test'
    ], dir)
    assert.ok(injectOutput.includes('Injected debug-wait'))

    const session = readScoutStatus(dir).sessions['debug-wait']
    assert.strictEqual(session.agentType, 'codex')
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.stateEvidence[0].source, 'debug')

    const output = runScriptOutput('scripts/debug.js', ['evidence', 'debug-wait', '--home', dir], dir)
    assert.ok(output.includes('debug-wait'))
    assert.ok(output.includes('debug:inject'))
    assert.ok(output.includes('waitingForApproval'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('debug CLI replays flow fixtures into a supplied home', () => {
  const dir = tempDir()
  try {
    const fixture = path.join(__dirname, 'fixtures', 'flow', 'claude', 'approval.json')
    const output = stripAnsi(runScriptOutput('scripts/debug.js', ['replay', fixture, '--home', dir, '--show'], dir))
    assert.ok(output.includes('Fixture: claude approval flow'))
    assert.ok(output.includes('Result: ok'))
    assert.ok(output.includes('tmux-scout | session'))

    const session = readScoutStatus(dir).sessions['fixture-claude-approval']
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

test('generic SessionStart shells never surface as semantic IDLE rows', () => {
  const cases = [
    ['gemini', 'SessionStart'],
    ['kimi', 'SessionStart'],
    ['copilot-cli', 'sessionStart'],
    ['opencode', 'SessionStart'],
    ['cursor', 'sessionStart'],
    ['coco', 'session_start'],
    ['traex', 'SessionStart'],
    ['hermes', 'on_session_start']
  ]
  for (const [agent, eventName] of cases) {
    const dir = tempDir()
    try {
      const sessionId = `${agent}-unconfirmed-shell`
      runGenericHook(agent, {
        hook_event_name: eventName,
        session_id: sessionId,
        conversation_id: sessionId,
        cwd: '/tmp/demo'
      }, dir)
      const statusPath = path.join(dir, '.tmux-scout', 'status.json')
      if (!fs.existsSync(statusPath)) continue
      const status = readScoutStatus(dir)
      assert.deepStrictEqual(getActiveSessions(status, new Map()), [], agent)
      if (status.sessions[sessionId]) {
        assert.notStrictEqual(currentPhase(status.sessions[sessionId]), 'idle', agent)
        assert.strictEqual(isVisibleInPicker(status.sessions[sessionId]), 'hidden', agent)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('first phase-neutral hook event inherits the running default, never IDLE', () => {
  const cases = [
    ['cursor', { hook_event_name: 'postToolUse', conversation_id: 'cursor-first-post', tool_name: 'ReadFile' }, 'cursor-first-post'],
    ['opencode', { hook_event_name: 'PostToolUse', session_id: 'opencode-first-post', tool_name: 'Read' }, 'opencode-first-post']
  ]
  for (const [agent, payload, sessionId] of cases) {
    const dir = tempDir()
    try {
      runGenericHook(agent, Object.assign({ cwd: '/tmp/demo' }, payload), dir)
      const session = readScoutStatus(dir).sessions[sessionId]
      assert.strictEqual(currentPhase(session), 'running', agent)
      assert.strictEqual(session.status, 'working', agent)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('Gemini ordinary completion cannot plant latent DONE behind ToolPermission WAIT', () => {
  const dir = tempDir()
  try {
    const sessionId = 'gemini-wait-completion'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'BeforeAgent',
      prompt: 'guard this tool'
    }), dir)
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      details: { type: 'tool', title: 'Shell' }
    }), dir)
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'BeforeTool',
      tool_name: 'ReadFile'
    }), dir)
    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'AfterAgent',
      prompt_response: 'waiting'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.deferredCompletion, null)

    runGenericHook('gemini', Object.assign({}, base, {
      hook_event_name: 'AfterTool',
      tool_name: 'ReadFile'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Gemini PreCompress activity makes DONE BUSY and keeps WAIT sticky', () => {
  const dir = tempDir()
  try {
    const doneId = 'gemini-precompress-done'
    const doneBase = { session_id: doneId, cwd: '/tmp/demo' }
    runGenericHook('gemini', Object.assign({}, doneBase, { hook_event_name: 'BeforeAgent', prompt: 'finish' }), dir)
    runGenericHook('gemini', Object.assign({}, doneBase, { hook_event_name: 'AfterAgent' }), dir)
    runGenericHook('gemini', Object.assign({}, doneBase, { hook_event_name: 'PreCompress' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[doneId]), 'running')

    const waitId = 'gemini-precompress-wait'
    const waitBase = { session_id: waitId, cwd: '/tmp/demo' }
    runGenericHook('gemini', Object.assign({}, waitBase, { hook_event_name: 'BeforeAgent', prompt: 'ask' }), dir)
    runGenericHook('gemini', Object.assign({}, waitBase, {
      hook_event_name: 'Notification',
      notification_type: 'ToolPermission',
      details: { type: 'tool', title: 'Shell' }
    }), dir)
    runGenericHook('gemini', Object.assign({}, waitBase, { hook_event_name: 'PreCompress' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[waitId]), 'waitingForApproval')
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

test('Kimi keeps WAIT across parallel native approvals and unrelated low-risk tools', async () => {
  const dir = tempDir()
  try {
    const sessionId = 'kimi-parallel-approvals'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run two guarded tools'
    }), dir)

    await Promise.all([
      runGenericHookAsync('kimi', Object.assign({}, base, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Shell',
        tool_call_id: 'kimi-call-a',
        tool_input: { command: 'npm test' }
      }), dir),
      runGenericHookAsync('kimi', Object.assign({}, base, {
        hook_event_name: 'PreToolUse',
        tool_name: 'WriteFile',
        tool_call_id: 'kimi-call-b',
        tool_input: { path: '/tmp/demo/a.txt', content: 'a' }
      }), dir)
    ])

    const markerDir = path.join(dir, '.tmux-scout', 'run', 'kimi-hooks', 'active-native-approvals', sessionId)
    assert.strictEqual(fs.readdirSync(markerDir).filter(name => name.endsWith('.approval')).length, 2)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'ReadFile',
      tool_call_id: 'kimi-read',
      tool_input: { path: '/tmp/demo/a.txt' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Shell',
      tool_call_id: 'kimi-call-a'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(fs.readdirSync(markerDir).filter(name => name.endsWith('.approval')).length, 1)

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'WriteFile',
      tool_call_id: 'kimi-call-b'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(fs.existsSync(markerDir), true)
    assert.deepStrictEqual(fs.readdirSync(markerDir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Kimi discards stale approval markers when a new turn starts', () => {
  const dir = tempDir()
  try {
    const sessionId = 'kimi-new-turn-clears-approval'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    const markerDir = path.join(dir, '.tmux-scout', 'run', 'kimi-hooks', 'active-native-approvals', sessionId)

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'first turn'
    }), dir)
    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Shell',
      tool_call_id: 'stale-call',
      tool_input: { command: 'npm test' }
    }), dir)
    assert.deepStrictEqual(fs.readdirSync(markerDir), ['stale-call.approval'])

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'second turn'
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(fs.existsSync(markerDir), false)

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Shell',
      tool_call_id: 'current-call',
      tool_input: { command: 'npm test' }
    }), dir)
    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Shell',
      tool_call_id: 'current-call'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.deepStrictEqual(fs.readdirSync(markerDir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Kimi AskUserQuestion clears only on its matching PostToolUse', () => {
  const dir = tempDir()
  try {
    const sessionId = 'kimi-question-approval'
    const base = { session_id: sessionId, cwd: '/tmp/demo', tool_call_id: 'kimi-question-call' }
    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Continue?' }] }
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')

    runGenericHook('kimi', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
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
      tool_name: 'WriteBash',
      tool_input: { command: 'npm test' }
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'copilot-cli')
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.tool, 'WriteBash')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.source, 'hook')
    assert.strictEqual(session.pendingInteraction.tool, 'WriteBash')
    assert.strictEqual(session.lastEvent.type, 'permission_request')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Copilot normalized read-only tool names never create fake WAIT', () => {
  const readOnlyTools = [
    'bash', 'powershell', 'read_bash', 'read_powershell', 'list_bash',
    'list_powershell', 'read_agent', 'list_agents', 'report_intent', 'rg'
  ]
  for (const toolName of readOnlyTools) {
    const dir = tempDir()
    try {
      const sessionId = `copilot-readonly-${toolName}`
      runGenericHook('copilot-cli', {
        hook_event_name: 'preToolUse',
        session_id: sessionId,
        cwd: '/tmp/demo',
        tool_name: toolName,
        toolArgs: '{}'
      }, dir)
      const session = readScoutStatus(dir).sessions[sessionId]
      assert.strictEqual(currentPhase(session), 'running', toolName)
      assert.strictEqual(session.pendingInteraction, null, toolName)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('Copilot subagentStop is activity and reopens DONE as BUSY', () => {
  const dir = tempDir()
  try {
    const sessionId = 'copilot-subagent-stop'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'userPromptSubmitted',
      prompt: 'delegate work'
    }), dir)
    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'agentStop'
    }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'completed')

    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'subagentStop'
    }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook tracks Cursor prompt, shell and stop events', () => {
  const dir = tempDir()
  try {
    const sessionId = 'cursor-session'
    const base = { conversation_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'ship cursor support'
    }), dir)
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'beforeShellExecution',
      command: 'npm test'
    }), dir)
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'afterShellExecution',
      command: 'npm test',
      exit_code: 0
    }), dir)
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'stop',
      text: 'done'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'cursor')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.sessionTitle, 'ship cursor support')
    assert.strictEqual(session.lastAssistantMessage, 'done')
    assert.strictEqual(session.pendingToolUse, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Cursor afterAgentResponse with text completes the turn exactly', () => {
  const dir = tempDir()
  try {
    const sessionId = 'cursor-agent-response'
    const base = { conversation_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'answer me'
    }), dir)
    runGenericHook('cursor', Object.assign({}, base, {
      hook_event_name: 'afterAgentResponse',
      text: 'done'
    }), dir)
    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.lastAssistantMessage, 'done')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook maps Trae permission requests', () => {
  const dir = tempDir()
  try {
    const sessionId = 'trae-session'
    runGenericHook('trae', {
      hook_event_name: 'user_prompt_submit',
      session_id: sessionId,
      cwd: '/tmp/demo',
      prompt: 'change the build script'
    }, dir)
    runGenericHook('trae', {
      hook_event_name: 'permission_request',
      session_id: sessionId,
      cwd: '/tmp/demo',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'trae')
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.tool, 'Bash')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook maps Trae PascalCase busy events', () => {
  const dir = tempDir()
  try {
    const sessionId = 'trae-pascal-busy'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix trae busy status'
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'trae')
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.sessionTitle, 'fix trae busy status')

    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.pendingToolUse.tool, 'Bash')

    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'Notification',
      notification_type: 'IdlePrompt',
      message: 'Agent finished and is waiting for your input'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.NOTIFICATION)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook does not reopen Trae completion idle notifications as waits', () => {
  const dir = tempDir()
  try {
    const sessionId = 'trae-completion-idle'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'user_prompt_submit',
      prompt: 'change the build script'
    }), dir)
    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'stop'
    }), dir)
    runGenericHook('trae', Object.assign({}, base, {
      hook_event_name: 'notification',
      notification_type: 'idle_prompt',
      message: 'Agent finished and is waiting for your input'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'trae')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic Coco hook keeps unsupported notification types phase-neutral', () => {
  const dir = tempDir()
  try {
    const sessionId = 'trae-elicitation'
    runGenericHook('trae', {
      hook_event_name: 'user_prompt_submit',
      session_id: sessionId,
      cwd: '/tmp/demo',
      prompt: 'continue the task'
    }, dir)
    runGenericHook('trae', {
      hook_event_name: 'notification',
      session_id: sessionId,
      cwd: '/tmp/demo',
      notification_type: 'elicitation_dialog',
      message: '请选择一个方案'
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.NOTIFICATION)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Coco reads nested prompt/tool payloads and compact hooks are no-ops', () => {
  const dir = tempDir()
  try {
    const sessionId = 'coco-nested-payloads'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('coco', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      user_prompt_submit: { prompt: 'nested prompt' }
    }), dir)
    runGenericHook('coco', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      pre_tool_use: { tool_name: 'ReadFile', tool_input: { path: '/tmp/demo/a.txt' } }
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.lastUserPrompt, 'nested prompt')
    assert.strictEqual(session.activeTool, 'ReadFile')

    runGenericHook('coco', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      post_tool_use: { tool_name: 'ReadFile' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.activeTool, null)
    const beforeCompact = JSON.stringify(session)
    runGenericHook('coco', Object.assign({}, base, { hook_event_name: 'PreCompact' }), dir)
    runGenericHook('coco', Object.assign({}, base, { hook_event_name: 'PostCompact' }), dir)
    assert.strictEqual(JSON.stringify(readScoutStatus(dir).sessions[sessionId]), beforeCompact)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Coco invalid AskUserQuestion payload stays BUSY instead of inventing WAIT', () => {
  const dir = tempDir()
  try {
    const sessionId = 'coco-invalid-question'
    runGenericHook('coco', {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      cwd: '/tmp/demo',
      tool_name: 'AskUserQuestion',
      tool_input: {}
    }, dir)
    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook never derives lifecycle state from notification prose', () => {
  const dir = tempDir()
  try {
    const permId = 'gemini-text-perm'
    runGenericHook('gemini', {
      session_id: permId,
      cwd: '/tmp/demo',
      hook_event_name: 'BeforeAgent',
      prompt: 'run the checks'
    }, dir)
    runGenericHook('gemini', {
      session_id: permId,
      cwd: '/tmp/demo',
      hook_event_name: 'Notification',
      message: 'Gemini needs your permission to use Bash'
    }, dir)
    let session = readScoutStatus(dir).sessions[permId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)

    const planId = 'gemini-text-plan'
    runGenericHook('gemini', {
      session_id: planId,
      cwd: '/tmp/demo',
      hook_event_name: 'BeforeAgent',
      prompt: 'draft a plan'
    }, dir)
    runGenericHook('gemini', {
      session_id: planId,
      cwd: '/tmp/demo',
      hook_event_name: 'Notification',
      message: 'Gemini needs your approval for the plan'
    }, dir)
    session = readScoutStatus(dir).sessions[planId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode keeps WAIT through unrelated tools and child-agent events', () => {
  const dir = tempDir()
  try {
    const sessionId = 'opencode-wait-routing'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run guarded task'
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')

    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.activeTool, null)

    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'still waiting for approval'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.deferredCompletion, null)

    const beforeChild = JSON.stringify(session)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'Stop',
      agent_id: 'opencode-child',
      last_assistant_message: 'child done'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(JSON.stringify(session), beforeChild)

    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PostToolUse'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode empty assistant updates are exact no-ops', () => {
  const dir = tempDir()
  try {
    const sessionId = 'opencode-empty-assistant'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'finish'
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)
    const before = JSON.stringify(readScoutStatus(dir).sessions[sessionId])
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'AssistantMessageUpdate',
      assistant_message_preview: ''
    }), dir)
    assert.strictEqual(JSON.stringify(readScoutStatus(dir).sessions[sessionId]), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode keeps only the newest session for a concrete terminal key', () => {
  const dir = tempDir()
  try {
    const terminal = { terminal_session_id: 'opencode-terminal-1', cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'SessionStart',
      session_id: 'opencode-old'
    }), dir)
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'opencode-old',
      prompt: 'old work'
    }), dir)
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'SessionStart',
      session_id: 'opencode-new'
    }), dir)

    let status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions['opencode-old']), 'completed')
    assert.strictEqual(currentPhase(status.sessions['opencode-new']), 'running')

    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'opencode-new',
      prompt: 'new work'
    }), dir)
    status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions['opencode-new']), 'running')
    assert.strictEqual(status.sessions['opencode-old'].status, 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode scopes terminal replacement to the tmux pane', () => {
  const dir = tempDir()
  try {
    const terminal = { terminal_session_id: 'shared-outer-terminal', cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'SessionStart',
      session_id: 'opencode-pane-one'
    }), dir, [], '%1')
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'opencode-pane-one',
      prompt: 'work in pane one'
    }), dir, [], '%1')
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'SessionStart',
      session_id: 'opencode-pane-two'
    }), dir, [], '%2')
    runGenericHook('opencode', Object.assign({}, terminal, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'opencode-pane-two',
      prompt: 'work in pane two'
    }), dir, [], '%2')

    const status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions['opencode-pane-one']), 'running')
    assert.strictEqual(status.sessions['opencode-pane-one'].status, 'working')
    assert.strictEqual(currentPhase(status.sessions['opencode-pane-two']), 'running')
    assert.strictEqual(status.sessions['opencode-pane-two'].status, 'working')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode Stop clears stale session-end state while preserving WAIT', () => {
  const dir = tempDir()
  try {
    const sessionId = 'opencode-late-permission'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run command'
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'SessionEnd'
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.ok(Number.isFinite(session.endedAt))

    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'command finished'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.endedAt, null)
    assert.strictEqual(session.deferredCompletion, null)

    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'PostToolUse'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.endedAt, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('adapter-specific completion activity reopens late DONE as BUSY', () => {
  const cases = [
    {
      agent: 'gemini',
      start: { hook_event_name: 'BeforeAgent', prompt: 'work' },
      done: { hook_event_name: 'AfterAgent' },
      late: { hook_event_name: 'AfterTool', tool_name: 'ReadFile' }
    },
    {
      agent: 'copilot-cli',
      start: { hook_event_name: 'userPromptSubmitted', prompt: 'work' },
      done: { hook_event_name: 'agentStop' },
      late: { hook_event_name: 'postToolUse', tool_name: 'ReadBash' }
    },
    {
      agent: 'coco',
      start: { hook_event_name: 'user_prompt_submit', prompt: 'work' },
      done: { hook_event_name: 'stop' },
      late: { hook_event_name: 'post_tool_use', tool_name: 'ReadFile' }
    },
    {
      agent: 'cursor',
      start: { hook_event_name: 'beforeSubmitPrompt', prompt: 'work' },
      done: { hook_event_name: 'stop' },
      late: { hook_event_name: 'afterFileEdit', file_path: '/tmp/demo/a.txt' }
    },
    {
      agent: 'hermes',
      start: { hook_event_name: 'pre_llm_call', user_message: 'work' },
      done: { hook_event_name: 'post_llm_call', response: 'done' },
      late: { hook_event_name: 'post_approval_response', command: 'echo ok', status: 'approved' }
    }
  ]

  for (const item of cases) {
    const dir = tempDir()
    try {
      const sessionId = `${item.agent}-late-activity`
      const base = { session_id: sessionId, conversation_id: sessionId, cwd: '/tmp/demo' }
      runGenericHook(item.agent, Object.assign({}, base, item.start), dir)
      if (item.agent === 'hermes') {
        runGenericHook(item.agent, Object.assign({}, base, {
          hook_event_name: 'pre_approval_request',
          command: 'echo ok'
        }), dir)
        runGenericHook(item.agent, Object.assign({}, base, {
          hook_event_name: 'post_approval_response',
          command: 'echo ok'
        }), dir)
      }
      runGenericHook(item.agent, Object.assign({}, base, item.done), dir)
      assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'completed', item.agent)
      runGenericHook(item.agent, Object.assign({}, base, item.late), dir)
      assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'running', item.agent)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  const dir = tempDir()
  try {
    const sessionId = 'opencode-late-assistant-activity'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('opencode', Object.assign({}, base, { hook_event_name: 'UserPromptSubmit', prompt: 'work' }), dir)
    runGenericHook('opencode', Object.assign({}, base, {
      hook_event_name: 'AssistantMessageUpdate',
      assistant_message_preview: 'latest assistant text'
    }), dir)
    runGenericHook('opencode', Object.assign({}, base, { hook_event_name: 'Stop' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'completed')
    runGenericHook('opencode', Object.assign({}, base, { hook_event_name: 'PostToolUse', tool_name: 'Read' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[sessionId]), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionEnd stays hidden across late activity until a new turn starts', () => {
  const dir = tempDir()
  try {
    const sessionId = 'copilot-ended-late-activity'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'userPromptSubmitted',
      prompt: 'work'
    }), dir)
    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'sessionEnd'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.ok(session.endedAt)
    assert.strictEqual(isVisibleInPicker(session), 'hidden')

    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'postToolUse',
      tool_name: 'Read'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.ok(session.endedAt, 'late activity must preserve isSessionEnded state')
    assert.strictEqual(isVisibleInPicker(session), 'hidden')

    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'agentStop'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.endedAt, null, 'ordinary sessionCompleted clears isSessionEnded')

    runGenericHook('copilot-cli', Object.assign({}, base, {
      hook_event_name: 'userPromptSubmitted',
      prompt: 'new turn'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.endedAt, null)
    assert.strictEqual(isVisibleInPicker(session), 'pane')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook maps Hermes clarify questions and completion', () => {
  const dir = tempDir()
  try {
    const sessionId = 'hermes-session'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('hermes', Object.assign({}, base, {
      hook_event_name: 'pre_llm_call',
      user_message: 'need choice'
    }), dir)
    runGenericHook('hermes', Object.assign({}, base, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'clarify',
      tool_input: { question: 'keep API?' }
    }), dir)
    runGenericHook('hermes', Object.assign({}, base, {
      hook_event_name: 'post_tool_call',
      tool_name: 'clarify'
    }), dir)
    runGenericHook('hermes', Object.assign({}, base, {
      hook_event_name: 'post_llm_call',
      response: 'done'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'hermes')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.sessionTitle, 'need choice')
    assert.strictEqual(session.lastAssistantMessage, 'done')
    assert.strictEqual(session.pendingToolUse, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes routes empty-session approvals by exact command matching and finalize deletes the row', () => {
  const dir = tempDir()
  try {
    const sessionId = 'hermes-command-parent'
    const runtime = { terminal_session_id: 'term-hermes-1', terminal_tty: '/dev/ttys101', pid: '4101' }
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'pre_llm_call',
      session_id: sessionId,
      user_message: 'run tests'
    }, runtime), dir)
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'pre_tool_call',
      session_id: sessionId,
      tool_name: 'Shell',
      tool_input: { command: 'npm   test' }
    }, runtime), dir)
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'pre_approval_request',
      session_id: '',
      command: 'npm test'
    }, runtime), dir)

    let status = readScoutStatus(dir)
    assert.deepStrictEqual(Object.keys(status.sessions), [sessionId])
    assert.strictEqual(currentPhase(status.sessions[sessionId]), 'waitingForApproval')

    runGenericHook('hermes', Object.assign({
      hook_event_name: 'post_approval_response',
      session_id: '',
      command: 'npm test'
    }, runtime), dir)
    status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[sessionId]), 'running')
    assert.strictEqual(status.sessions[sessionId].pendingInteraction, null)

    runGenericHook('hermes', Object.assign({
      hook_event_name: 'on_session_finalize',
      session_id: sessionId
    }, runtime), dir)
    status = readScoutStatus(dir)
    assert.strictEqual(status.sessions[sessionId], undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes child hooks attach to the parent and never create top-level DONE rows', () => {
  const dir = tempDir()
  try {
    const parentId = 'hermes-parent'
    const childId = 'hermes-child'
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: parentId,
      user_message: 'coordinate worker'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: childId,
      parent_session_id: parentId,
      agent_id: 'worker-1',
      user_message: 'inspect tests'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'post_llm_call',
      session_id: childId,
      parent_session_id: parentId,
      agent_id: 'worker-1',
      response: 'child done'
    }, dir)

    let status = readScoutStatus(dir)
    assert.strictEqual(status.sessions[childId], undefined)
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')
    assert.strictEqual(status.sessions[parentId].activeSubagents.length, 1)

    runGenericHook('hermes', {
      hook_event_name: 'on_session_end',
      session_id: childId,
      parent_session_id: parentId,
      agent_id: 'worker-1'
    }, dir)
    status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')
    assert.deepStrictEqual(status.sessions[parentId].activeSubagents, [])

    const before = JSON.stringify(status)
    runGenericHook('hermes', {
      hook_event_name: 'post_llm_call',
      session_id: 'hermes-unowned-child',
      agent_id: 'unknown-worker',
      response: 'must be ignored'
    }, dir)
    assert.strictEqual(JSON.stringify(readScoutStatus(dir)), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes heuristic delegate_task launch stays nested under its parent', () => {
  const dir = tempDir()
  try {
    const parentId = 'hermes-heuristic-parent'
    const childId = 'hermes-heuristic-child'
    const runtime = { terminal_session_id: 'term-hermes-heuristic', pid: '4201' }
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'pre_llm_call',
      session_id: parentId,
      user_message: 'delegate work'
    }, runtime), dir)
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'pre_tool_call',
      session_id: '',
      tool_name: 'delegate_task',
      tool_input: { task: 'inspect files' }
    }, runtime), dir)
    runGenericHook('hermes', Object.assign({
      hook_event_name: 'on_session_start',
      session_id: childId
    }, runtime), dir)

    const status = readScoutStatus(dir)
    assert.strictEqual(status.sessions[childId], undefined)
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')
    assert.strictEqual(status.sessions[parentId].activeSubagents.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes finalize removes child bindings so late child hooks cannot recreate ghosts', () => {
  const dir = tempDir()
  try {
    const parentId = 'hermes-finalized-parent'
    const childId = 'hermes-finalized-child'
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: parentId,
      user_message: 'start worker'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: childId,
      parent_session_id: parentId,
      agent_id: 'worker-finalize'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'on_session_finalize',
      session_id: parentId
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'post_tool_call',
      session_id: childId,
      agent_id: 'worker-finalize',
      tool_name: 'ReadFile'
    }, dir)

    const status = readScoutStatus(dir)
    assert.strictEqual(status.sessions[parentId], undefined)
    assert.strictEqual(status.sessions[childId], undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Hermes on_session_end reads nested booleans and interrupted fallback is DONE', () => {
  const dir = tempDir()
  try {
    const completedId = 'hermes-nested-completed'
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: completedId,
      user_message: 'keep state'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'on_session_end',
      session_id: completedId,
      extra: { completed: true }
    }, dir)
    let status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[completedId]), 'running')

    const interruptedId = 'hermes-interrupted-fallback'
    runGenericHook('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: interruptedId,
      user_message: 'interrupt me'
    }, dir)
    runGenericHook('hermes', {
      hook_event_name: 'on_session_end',
      session_id: interruptedId,
      interrupted: true
    }, dir)
    status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[interruptedId]), 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook maps Traex approval modes and idle completion', () => {
  const dir = tempDir()
  try {
    const sessionId = 'traex-session'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'SessionStart'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ship traex support'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      permission_mode: 'auto'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'traex')
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.PROMPT_SUBMIT)

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Agent finished and is waiting for your input'
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.pendingInteraction, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex compact hooks preserve the exact existing phase', () => {
  const dir = tempDir()
  try {
    const sessionId = 'traex-compact-noop'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'finish first'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, { hook_event_name: 'Stop' }), dir)
    const before = JSON.stringify(readScoutStatus(dir).sessions[sessionId])
    runGenericHook('traex', Object.assign({}, base, { hook_event_name: 'PreCompact' }), dir)
    runGenericHook('traex', Object.assign({}, base, { hook_event_name: 'PostCompact' }), dir)
    assert.strictEqual(JSON.stringify(readScoutStatus(dir).sessions[sessionId]), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown adapters never infer completion from event-name substrings', () => {
  const dir = tempDir()
  try {
    runGenericHook('unknown-agent', {
      hook_event_name: 'frontend_update',
      session_id: 'unknown-frontend-update',
      cwd: '/tmp/demo'
    }, dir)
    const statusPath = path.join(dir, '.tmux-scout', 'status.json')
    assert.strictEqual(fs.existsSync(statusPath), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex payloads without session_id are ACK-only and create no synthetic BUSY row', () => {
  const dir = tempDir()
  try {
    runGenericHook('traex', {
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/demo',
      prompt: 'must not create a cwd session'
    }, dir)
    assert.strictEqual(fs.existsSync(path.join(dir, '.tmux-scout', 'status.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex child WAIT never replaces its BUSY parent in the picker', () => {
  const dir = tempDir()
  try {
    const parentId = 'traex-parent-busy'
    const childId = 'traex-child-wait'
    const parentBase = { session_id: parentId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, parentBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'coordinate a worker'
    }), dir)
    runGenericHook('traex', Object.assign({}, parentBase, {
      hook_event_name: 'SubagentStart',
      agent_id: childId,
      agent_type: 'worker'
    }), dir)

    const childBase = { session_id: childId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, childBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'inspect the tests'
    }), dir)
    runGenericHook('traex', Object.assign({}, childBase, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'continue?' }
    }), dir)

    let status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')
    assert.strictEqual(currentPhase(status.sessions[childId]), 'running')
    assert.strictEqual(status.sessions[childId].parentSessionId, parentId)

    runGenericHook('traex', Object.assign({}, childBase, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    status = readScoutStatus(dir)
    const parent = status.sessions[parentId]
    const child = status.sessions[childId]
    assert.strictEqual(currentPhase(parent), 'running')
    assert.strictEqual(currentPhase(child), 'waitingForApproval')
    assert.strictEqual(child.parentSessionId, parentId)
    assert.strictEqual(child.activeTool, 'AskUserQuestion')
    assert.strictEqual(isVisibleInPicker(child), 'hidden')

    const pane = { paneId: '%1', currentCommand: 'traex', paneDead: false, windowName: 'main' }
    assert.deepStrictEqual(
      getActiveSessions(status, new Map([['%1', pane]])).map(session => session.sessionId),
      [parentId]
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex Stop clears a stale permission wait before completing', () => {
  const dir = tempDir()
  try {
    const sessionId = 'traex-stop-while-waiting'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run guarded command'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'Stop'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.deferredCompletion, null)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_RESOLVED))

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Traex idle_prompt completion does not inspect background prose', () => {
  const dir = tempDir()
  try {
    const sessionId = 'traex-background-shell'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    const backgroundMessage = 'Artifact poll is running in background (ID: 20899). cx is working on the extraction. This typically takes 5-15 minutes.'
    const extractionPollMessage = 'Extraction is running in the background. I\'ll be notified when the poll completes (either DONE or TIMEOUT, up to 30 minutes). Waiting for the artifacts to be written by cx.'

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'extract artifacts'
    }), dir)
    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'Stop'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: backgroundMessage
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.agentType, 'traex')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)

    const extractionSessionId = 'traex-extraction-poll-background'
    const extractionBase = { session_id: extractionSessionId, cwd: '/tmp/demo' }
    runGenericHook('traex', Object.assign({}, extractionBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'extract with cx'
    }), dir)
    runGenericHook('traex', Object.assign({}, extractionBase, {
      hook_event_name: 'Stop'
    }), dir)
    runGenericHook('traex', Object.assign({}, extractionBase, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: extractionPollMessage
    }), dir)

    session = readScoutStatus(dir).sessions[extractionSessionId]
    assert.strictEqual(session.agentType, 'traex')
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)

    runGenericHook('traex', Object.assign({}, base, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'Agent finished and is waiting for your input'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.pendingToolUse, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync never revives DONE from background prose', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(scoutDir, { recursive: true })
    const statusPath = path.join(scoutDir, 'status.json')
    const now = Date.now()
    const sessionId = 'traex-background-recovery'
    const backgroundMessage = 'Artifact poll is running in background (ID: 20899). cx is working on the extraction. This typically takes 5-15 minutes.'
    fs.writeFileSync(statusPath, JSON.stringify({
      version: 1,
      lastUpdated: now - 5000,
      sessions: {
        [sessionId]: {
          sessionId,
          agentType: 'traex',
          phase: 'completed',
          status: 'completed',
          startedAt: now - 60000,
          lastUpdated: now - 5000,
          lastHookAt: now - 5000,
          stateSource: 'traex-hooks',
          lastAssistantMessage: backgroundMessage,
          lastEvent: { type: AGENT_EVENTS.STOP, timestamp: now - 5000, rawEventName: 'Notification' },
          lifecycle: {
            phase: 'completed',
            source: 'hook',
            priority: 90,
            reason: 'stop',
            updatedAt: now - 5000
          }
        }
      }
    }, null, 2))

    const result = sync.run(statusPath, {
      reconcile: false,
      codexTranscript: false,
      claudeTranscript: false,
      waitResolve: false,
      idleComplete: false,
      registryPrune: false,
      backgroundActivityRecoveryMs: 10 * 60 * 1000
    })

    const session = result.status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.activeTool, undefined)
    assert.strictEqual(session.pendingToolUse, undefined)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)
    assert.strictEqual(result.stats.reconcile.backgroundActivity, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('session reducer keeps pane observations phase-neutral at every age', () => {
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

  const stillIgnored = applySessionEvent(session, {
    type: 'pane_state',
    source: 'pane',
    timestamp: 1000 + 10 * 60 * 1000,
    phase: 'completed',
    status: 'completed'
  })

  assert.strictEqual(stillIgnored.applied, false)
  assert.strictEqual(currentPhase(session), 'running')
})

test('WAIT stays sticky until an explicit resolution event', () => {
  function waitingSession(id) {
    const session = { sessionId: id, agentType: 'claude', startedAt: 1000 }
    applySessionEvent(session, {
      type: AGENT_EVENTS.PERMISSION_REQUEST,
      source: 'hook',
      timestamp: 1000,
      pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
    })
    return session
  }

  const phaseChangingNoise = [
    { type: AGENT_EVENTS.TOOL_USE, source: 'hook', timestamp: 1100, activeTool: 'Bash' },
    { type: AGENT_EVENTS.PANE_STATE, source: 'pane', timestamp: 1100, phase: 'running', status: 'working' },
    { type: AGENT_EVENTS.SUBAGENT_START, source: 'hook', timestamp: 1100 },
    { type: AGENT_EVENTS.PROCESS_EXIT_DETECTED, source: 'pid', timestamp: 1100, force: true },
    { type: AGENT_EVENTS.STALE, source: 'pane', timestamp: 1100, force: true }
  ]

  for (const [index, event] of phaseChangingNoise.entries()) {
    const session = waitingSession(`sticky-wait-${index}`)
    const result = applySessionEvent(session, event)
    assert.strictEqual(result.applied, false, `${event.type} must not resolve WAIT`)
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
  }

  const completedWhileWaiting = waitingSession('sticky-wait-completion')
  const stopped = applySessionEvent(completedWhileWaiting, {
    type: AGENT_EVENTS.STOP,
    source: 'hook',
    timestamp: 1200,
    details: 'turn finished'
  })
  assert.strictEqual(stopped.applied, false)
  assert.strictEqual(currentPhase(completedWhileWaiting), 'waitingForApproval')
  assert.strictEqual(completedWhileWaiting.deferredCompletion, undefined)

  const questionResolver = applySessionEvent(completedWhileWaiting, {
    type: AGENT_EVENTS.QUESTION_ANSWERED,
    source: 'hook',
    timestamp: 1300
  })
  assert.strictEqual(questionResolver.applied, true)
  assert.strictEqual(currentPhase(completedWhileWaiting), 'running')
})

test('late pending resolution returns an ended hook session to DONE', () => {
  for (const [requestType, answerType] of [
    [AGENT_EVENTS.PERMISSION_REQUEST, AGENT_EVENTS.PERMISSION_RESOLVED],
    [AGENT_EVENTS.QUESTION_ASKED, AGENT_EVENTS.QUESTION_ANSWERED]
  ]) {
    const session = { sessionId: `ended-${requestType}`, agentType: 'codex', startedAt: 1000 }
    applySessionEvent(session, { type: AGENT_EVENTS.SESSION_START, source: 'hook', timestamp: 1000 })
    applySessionEvent(session, { type: AGENT_EVENTS.SESSION_END, source: 'hook', timestamp: 1100 })
    applySessionEvent(session, { type: requestType, source: 'hook', timestamp: 1200 })
    assert.ok(['waitingForApproval', 'waitingForAnswer'].includes(currentPhase(session)))

    const resolved = applySessionEvent(session, { type: answerType, source: 'hook', timestamp: 1300 })
    assert.strictEqual(resolved.applied, true)
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.endedAt, 1100)
    assert.strictEqual(session.pendingInteraction, null)
  }
})

test('sessionStarted explicitly exits WAIT and clears pending state', () => {
  const session = { sessionId: 'wait-new-session', agentType: 'gemini', startedAt: 1000 }
  applySessionEvent(session, {
    type: AGENT_EVENTS.PERMISSION_REQUEST,
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Shell', details: 'Shell', timestamp: 1000 },
    activeTool: 'Shell'
  })
  assert.strictEqual(currentPhase(session), 'waitingForApproval')

  const started = applySessionEvent(session, {
    type: AGENT_EVENTS.SESSION_START,
    source: 'hook',
    timestamp: 2000
  })
  assert.strictEqual(started.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
})

test('turnStarted prompt explicitly exits stale WAIT as BUSY', () => {
  const session = { sessionId: 'wait-new-turn', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: AGENT_EVENTS.QUESTION_ASKED,
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'request_user_input', details: 'continue?', timestamp: 1000 }
  })
  assert.strictEqual(currentPhase(session), 'waitingForAnswer')

  const started = applySessionEvent(session, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'hook',
    timestamp: 2000,
    details: 'new prompt'
  })
  assert.strictEqual(started.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
})

test('tool noise stays sticky but activityUpdated reopens DONE', () => {
  const session = { sessionId: 'done-activity', agentType: 'opencode', startedAt: 1000 }
  applySessionEvent(session, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'hook',
    timestamp: 1000,
    turnId: 'turn-one'
  })
  applySessionEvent(session, {
    type: AGENT_EVENTS.STOP,
    source: 'hook',
    timestamp: 2000,
    turnId: 'turn-one'
  })

  const toolNoise = applySessionEvent(session, {
    type: AGENT_EVENTS.TOOL_USE,
    source: 'hook',
    timestamp: 3000,
    turnId: 'turn-two',
    activeTool: 'Bash'
  })
  assert.strictEqual(toolNoise.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')

  const activity = applySessionEvent(session, {
    type: 'activityUpdated',
    source: 'hook',
    timestamp: 3100,
    updates: { currentActivity: 'streaming response' }
  })
  assert.strictEqual(activity.applied, true)
  assert.strictEqual(currentPhase(session), 'running')

  applySessionEvent(session, {
    type: AGENT_EVENTS.STOP,
    source: 'hook',
    timestamp: 3500,
    turnId: 'turn-one'
  })

  const newTurn = applySessionEvent(session, {
    type: AGENT_EVENTS.PROMPT_SUBMIT,
    source: 'transcript',
    timestamp: 4000,
    turnId: 'turn-two'
  })
  assert.strictEqual(newTurn.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
})

test('session reducer keeps interrupted sticky until an explicit new turn', () => {
  const session = { sessionId: 'int-recover', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  applySessionEvent(session, { type: 'interrupted', source: 'transcript', timestamp: 2000 })
  assert.strictEqual(currentPhase(session), 'interrupted')

  const activity = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3000,
    activeTool: 'Bash'
  })
  assert.strictEqual(activity.applied, false)
  assert.strictEqual(currentPhase(session), 'interrupted')

  const newTurn = applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 4000,
    turnId: 'turn-new'
  })
  assert.strictEqual(newTurn.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.endedAt, null)
})

test('session reducer keeps interrupted sticky against a stale in-flight activity event', () => {
  const session = { sessionId: 'int-stale', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  applySessionEvent(session, { type: 'interrupted', source: 'transcript', timestamp: 2000 })

  // A tool-start event generated BEFORE the interrupt (delayed delivery) is older
  // than the interrupt transition and must not resurrect a genuinely interrupted turn.
  const stale = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1500
  })
  assert.strictEqual(stale.applied, false)
  assert.strictEqual(currentPhase(session), 'interrupted')
})

test('session reducer does not resume an interrupted turn from a late post-tool hook', () => {
  const session = { sessionId: 'int-posttool', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  applySessionEvent(session, { type: 'interrupted', source: 'transcript', timestamp: 2000 })

  // "Interrupt while a tool is running": the aborted tool's post_tool_use_failure can
  // arrive with a newer processing timestamp, but the tool never completed and the
  // agent is not working again — it must NOT flip the interrupt back to running.
  const late = applySessionEvent(session, { type: 'post_tool_use_failure', source: 'hook', timestamp: 3000 })
  assert.strictEqual(late.applied, false)
  assert.strictEqual(currentPhase(session), 'interrupted')
})

test('session reducer does not reopen an inferred completion from tool activity', () => {
  const session = { sessionId: 'idle-done-recover', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  // The idle-complete sweep INFERS the turn ended (source 'stale'), not a real Stop.
  applySessionEvent(session, { type: 'turn_complete', source: 'stale', timestamp: 2000, force: true })
  assert.strictEqual(currentPhase(session), 'completed')

  const activity = applySessionEvent(session, { type: 'tool_use', source: 'hook', timestamp: 3000, activeTool: 'Bash' })
  assert.strictEqual(activity.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')

  const newTurn = applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 4000 })
  assert.strictEqual(newTurn.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
})

test('session reducer keeps completed sticky against later activity (only a new turn reopens)', () => {
  const session = { sessionId: 'done-sticky', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000, turnId: 'turn-old' })
  applySessionEvent(session, { type: 'stop', source: 'hook', timestamp: 2000, turnId: 'turn-old' })
  assert.strictEqual(currentPhase(session), 'completed')

  // A stray late tool event must NOT un-finish a normally-completed turn.
  const stray = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3000,
    turnId: 'turn-old',
    activeTool: 'Bash'
  })
  assert.strictEqual(stray.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')

  // A different turn id on an ordinary tool hook is still not a turnStarted
  // event and cannot revive DONE.
  const newTurnTool = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3500,
    turnId: 'turn-new',
    activeTool: 'Bash'
  })
  assert.strictEqual(newTurnTool.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')

  // A fresh prompt still reopens it.
  const reopened = applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 4000, turnId: 'turn-third' })
  assert.strictEqual(reopened.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
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
  assert.ok(/phase-neutral/.test(session.stateEvidence[0].blockedReason))
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

test('session reducer does not let pane busy clear transcript waits', () => {
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

  assert.strictEqual(cleared.applied, false)
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.needsAttention, 'waiting for approval')
})

test('session reducer keeps liveness events from overriding WAIT', () => {
  const session = { sessionId: 's2', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 900,
    activeTool: 'Bash'
  })
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
  assert.deepStrictEqual(session.pendingInteraction, {
    type: 'approval',
    phase: 'waitingForApproval',
    source: 'hook',
    stateSource: 'hook',
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

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.status, 'working')
  assert.strictEqual(session.endedAt, undefined)
  assert.strictEqual(session.pendingInteraction.type, 'approval')
  assert.strictEqual(session.activeTool, 'Bash')

  applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    timestamp: 3000
  })
  applySessionEvent(session, {
    type: 'process_exit_detected',
    source: 'pid',
    timestamp: 4000,
    reason: 'pid exited',
    force: true
  })

  assert.strictEqual(currentPhase(session), 'interrupted')
  assert.strictEqual(session.status, 'interrupted')
  assert.strictEqual(session.terminalKind, 'processExit')
  assert.strictEqual(session.terminalReason, 'pid exited')
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

test('session reducer keeps redundant permission resolution as an exact no-op', () => {
  const cases = [
    {
      sessionId: 'resolver-running-noop',
      agentType: 'codex',
      phase: 'running',
      status: 'working',
      activeTool: 'Bash',
      lastUpdated: 1000,
      stateEvidence: [{ type: 'tool_use', timestamp: 1000 }]
    },
    {
      sessionId: 'resolver-answer-noop',
      agentType: 'codex',
      phase: 'waitingForAnswer',
      status: 'working',
      needsAttention: 'waiting for answer',
      pendingInteraction: {
        type: 'question',
        phase: 'waitingForAnswer',
        source: 'hook',
        startedAt: 1000,
        updatedAt: 1000,
        reason: 'waiting for answer'
      },
      lastUpdated: 1000
    }
  ]

  for (const session of cases) {
    const before = JSON.stringify(session)
    const result = applySessionEvent(session, {
      type: AGENT_EVENTS.PERMISSION_RESOLVED,
      source: 'hook',
      timestamp: 9000,
      details: 'duplicate resolver'
    })
    assert.strictEqual(result.applied, false)
    assert.strictEqual(result.changed, false)
    assert.strictEqual(JSON.stringify(session), before)
  }
})

test('session reducer keeps activeTool through permission bypass until tool completion', () => {
  const session = { sessionId: 's2-bypass-tool', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    activeTool: 'Bash'
  })

  applySessionEvent(session, {
    type: 'permission_bypassed',
    source: 'hook',
    timestamp: 1100
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.activeTool, 'Bash')

  applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 1200
  })
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

test('session reducer keeps activity text out of activeTool', () => {
  const idleSession = { sessionId: 's2-activity-idle', agentType: 'gemini', startedAt: 1000 }
  applySessionEvent(idleSession, {
    type: 'activityUpdated',
    source: 'hook',
    timestamp: 1000,
    details: 'Thinking...',
    updates: { currentActivity: 'Thinking...' }
  })

  assert.strictEqual(currentPhase(idleSession), 'running')
  assert.strictEqual(idleSession.currentActivity, 'Thinking...')
  assert.strictEqual(idleSession.activeTool, null)

  const toolSession = { sessionId: 's2-activity-tool', agentType: 'gemini', startedAt: 1000 }
  applySessionEvent(toolSession, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    activeTool: 'Bash',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })
  applySessionEvent(toolSession, {
    type: 'activityUpdated',
    source: 'hook',
    timestamp: 1100,
    details: 'Thinking...',
    updates: { currentActivity: 'Thinking...' }
  })

  assert.strictEqual(currentPhase(toolSession), 'running')
  assert.strictEqual(toolSession.currentActivity, 'Thinking...')
  assert.strictEqual(toolSession.activeTool, 'Bash')
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
  assert.strictEqual(session.activeTool, 'AskUserQuestion')
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
  assert.strictEqual(session.activeTool, 'AskUserQuestion')

  applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 2600
  })
  assert.strictEqual(session.activeTool, null)
})

test('session reducer keeps ordinary completion phase-neutral while a pending interaction is visible', () => {
  const session = { sessionId: 's2-deferred', agentType: 'claude', startedAt: 1000, endedAt: 900 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 },
    activeTool: 'Bash',
    requestId: 'req-deferred'
  })

  const stopped = applySessionEvent(session, {
    type: 'stop',
    source: 'hook',
    timestamp: 1500,
    reason: 'turn completed'
  })

  assert.strictEqual(stopped.applied, false)
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.status, 'working')
  assert.strictEqual(session.needsAttention, 'waiting for approval')
  assert.strictEqual(session.pendingInteraction.type, 'approval')
  assert.strictEqual(session.activeTool, 'Bash')
  assert.strictEqual(session.deferredCompletion, undefined)
  assert.strictEqual(session.lastEvent.type, 'permission_request')
  assert.strictEqual(session.endedAt, null, 'sessionCompleted clears isSessionEnded while preserving WAIT')

  const resolved = applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    timestamp: 2000,
    details: 'approved'
  })

  assert.strictEqual(resolved.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.status, 'working')
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, 'Bash')
  assert.strictEqual(session.deferredCompletion, null)
  assert.strictEqual(session.terminalKind, null)
  assert.strictEqual(session.lastEvent.type, 'permission_resolved')

  const lateTool = applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 2100,
    force: true
  })
  assert.strictEqual(lateTool.applied, false)
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.activeTool, null)
})

test('session reducer clears active subagents on applied end phases', () => {
  const session = {
    sessionId: 's2-subagents-end',
    agentType: 'traex',
    startedAt: 1000,
    activeSubagents: [
      { agentId: 'child-1', phase: 'running', lastToolActivity: 'Bash: npm test' }
    ]
  }

  applySessionEvent(session, {
    type: 'permission_request',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for approval',
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })
  applySessionEvent(session, {
    type: 'session_end',
    source: 'hook',
    timestamp: 1500,
    reason: 'turn completed'
  })

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.endedAt, 1500)
  assert.strictEqual(session.activeSubagents.length, 1)

  applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    timestamp: 2000,
    details: 'approved'
  })

  assert.strictEqual(currentPhase(session), 'completed')
  assert.deepStrictEqual(session.activeSubagents, [])
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.activeTool, null)
})

test('ordinary completion cancels a deferred SessionEnd while WAIT remains visible', () => {
  const session = { sessionId: 'deferred-end-cancelled', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: AGENT_EVENTS.PERMISSION_REQUEST,
    source: 'hook',
    timestamp: 1000
  })
  applySessionEvent(session, {
    type: AGENT_EVENTS.SESSION_END,
    source: 'hook',
    timestamp: 1100
  })
  assert.ok(session.deferredCompletion)
  assert.strictEqual(session.endedAt, 1100)

  applySessionEvent(session, {
    type: AGENT_EVENTS.STOP,
    source: 'hook',
    timestamp: 1200
  })
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.endedAt, null)
  assert.strictEqual(session.deferredCompletion, null)

  applySessionEvent(session, {
    type: AGENT_EVENTS.PERMISSION_RESOLVED,
    source: 'hook',
    timestamp: 1300
  })
  assert.strictEqual(currentPhase(session), 'running')
})

test('session reducer does not turn blocked completion or interruption into latent DONE', () => {
  const session = { sessionId: 's2-deferred-interrupt', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'question_asked',
    source: 'hook',
    timestamp: 1000,
    attentionReason: 'waiting for answer',
    pendingToolUse: { tool: 'AskUserQuestion', details: 'continue?', timestamp: 1000 }
  })

  applySessionEvent(session, {
    type: 'stop',
    source: 'hook',
    timestamp: 1500,
    reason: 'turn completed'
  })
  applySessionEvent(session, {
    type: 'interrupted',
    source: 'transcript',
    timestamp: 1600,
    reason: 'user interrupted'
  })
  assert.strictEqual(currentPhase(session), 'waitingForAnswer')
  assert.strictEqual(session.deferredCompletion, undefined)

  applySessionEvent(session, {
    type: 'question_answered',
    source: 'hook',
    timestamp: 2000
  })
  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.status, 'working')
  assert.strictEqual(session.terminalKind, null)
  assert.strictEqual(session.pendingInteraction, null)
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

test('session reducer resumes a plan wait only after explicit resolution', () => {
  const session = { sessionId: 's2-plan-confirmed', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'permission_request',
    source: 'transcript',
    timestamp: 1000,
    attentionReason: 'waiting for plan approval',
    pendingToolUse: { tool: 'ExitPlanMode', details: 'ExitPlanMode: proposed plan', timestamp: 1000 },
    turnId: 'turn-plan',
    force: true
  })
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.pendingInteraction.type, 'plan')

  applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    rawEventName: 'PostToolUse',
    timestamp: 1900,
    details: 'plan approved'
  })
  assert.strictEqual(currentPhase(session), 'running')

  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    rawEventName: 'UserPromptSubmit',
    timestamp: 2000,
    details: 'Implement the plan.',
    turnId: 'turn-implement'
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.needsAttention, null)
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.lastTurnId, 'turn-implement')
})

test('session reducer ignores low-fidelity pane wait refreshes', () => {
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
    timestamp: 5000,
    phase: 'waitingForApproval',
    status: 'needsAttention',
    attentionReason: 'waiting for approval',
    details: 'needsAttention'
  })

  assert.strictEqual(refreshed.applied, false)
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.pendingToolUse.tool, 'Bash')
  assert.strictEqual(session.pendingInteraction.type, 'approval')
  assert.strictEqual(session.pendingInteraction.source, 'hook')
  assert.strictEqual(session.pendingInteraction.tool, 'Bash')
  assert.strictEqual(session.pendingInteraction.details, 'Bash: npm test')
  assert.strictEqual(session.pendingInteraction.requestId, 'req-approval-1')
  assert.strictEqual(session.pendingInteraction.startedAt, 1000)
  assert.strictEqual(session.pendingInteraction.updatedAt, 1000)
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

test('session reducer clears stale tool state for explicit answer waits', () => {
  const session = { sessionId: 's2-answer', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 1000,
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 1000 }
  })

  const answerWait = applySessionEvent(session, {
    type: 'question_asked',
    source: 'hook',
    timestamp: 2000,
    attentionReason: 'waiting for answer'
  })

  assert.strictEqual(answerWait.applied, true)
  assert.strictEqual(currentPhase(session), 'waitingForAnswer')
  assert.strictEqual(session.needsAttention, 'waiting for answer')
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
  assert.strictEqual(session.pendingInteraction.type, 'question')
  assert.strictEqual(session.pendingInteraction.source, 'hook')
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

test('session reducer does not reopen stale sessions with late interrupted transcript events', () => {
  const session = { sessionId: 's2b', agentType: 'codex', startedAt: 1000 }
  applySessionEvent(session, {
    type: 'prompt_submit',
    source: 'hook',
    timestamp: 1000
  })
  applySessionEvent(session, {
    type: 'stale',
    source: 'pane',
    timestamp: 2000,
    reason: 'pane vanished',
    force: true
  })

  const interrupted = applySessionEvent(session, {
    type: 'interrupted',
    source: 'transcript',
    timestamp: 3000,
    reason: 'late turn_aborted'
  })

  assert.strictEqual(interrupted.applied, false)
  assert.strictEqual(currentPhase(session), 'stale')
  assert.strictEqual(session.status, 'stale')
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
      timestamp: 10 * 60 * 1000,
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
    assert.ok(config.includes('[features]\nhooks = true'))
    if (config.includes('codex_hooks')) assert.ok(config.includes('codex_hooks = true'))

    runScript('scripts/setup/codex.js', ['uninstall'], dir)
    assert.strictEqual(TOML.parse(fs.readFileSync(configPath, 'utf-8')).notify, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex setup replaces a direct notify hook from an old checkout', () => {
  const dir = tempDir()
  try {
    const codexDir = path.join(dir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })
    const hookPath = path.join(__dirname, '..', 'scripts', 'hooks', 'codex.js')
    const oldHookPath = path.join(dir, 'old', 'tmux-scout', 'scripts', 'hooks', 'codex.js')
    const configPath = path.join(codexDir, 'config.toml')
    fs.writeFileSync(configPath, TOML.stringify({ notify: ['node', oldHookPath] }))

    runScript('scripts/setup/codex.js', ['install'], dir)

    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf-8'))
    assert.deepStrictEqual(Array.from(parsed.notify), [
      'sh',
      '-c',
      'test -e "$1" || exit 0; exec node "$1" "$2"',
      'tmux-scout',
      hookPath
    ])

    runScript('scripts/setup/codex.js', ['uninstall'], dir)
    assert.strictEqual(TOML.parse(fs.readFileSync(configPath, 'utf-8')).notify, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex setup preserves a wrapped notify containing a JSON closing bracket', () => {
  const dir = tempDir()
  try {
    const codexDir = path.join(dir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })
    const hookPath = path.join(__dirname, '..', 'scripts', 'hooks', 'codex.js')
    const configPath = path.join(codexDir, 'config.toml')
    const wrappedNotify = [
      '/Applications/Notify Wrapper.app/Contents/MacOS/notify-wrapper',
      'turn-ended',
      '--previous-notify',
      JSON.stringify(['sh', '-c', 'exec node "$1" "$2"', 'tmux-scout', hookPath]).replace(/\//g, '\\/')
    ]
    fs.writeFileSync(configPath, TOML.stringify({
      model: 'default',
      notify: wrappedNotify,
      features: { experimental: true }
    }))

    runScript('scripts/setup/codex.js', ['install'], dir)
    const first = fs.readFileSync(configPath, 'utf-8')
    const parsed = TOML.parse(first)
    assert.deepStrictEqual(Array.from(parsed.notify), wrappedNotify)
    assert.strictEqual(parsed.features.hooks, true)
    assert.strictEqual(parsed.features.experimental, true)
    assert.strictEqual(Object.keys(parsed.hooks.state).length, 6)

    runScript('scripts/setup/codex.js', ['install'], dir)
    assert.strictEqual(fs.readFileSync(configPath, 'utf-8'), first)

    runScript('scripts/setup/codex.js', ['uninstall'], dir)
    assert.deepStrictEqual(Array.from(TOML.parse(fs.readFileSync(configPath, 'utf-8')).notify), wrappedNotify)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex setup preserves the legacy feature when version compatibility needs it', () => {
  const dir = tempDir()
  try {
    const codexDir = path.join(dir, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })
    const configPath = path.join(codexDir, 'config.toml')
    fs.writeFileSync(configPath, [
      'model = "default"',
      '',
      '[features]',
      'codex_hooks = true',
      'experimental = true',
      ''
    ].join('\n'))

    runScript('scripts/setup/codex.js', ['install'], dir)

    const installed = fs.readFileSync(configPath, 'utf-8')
    assert.ok(installed.includes('model = "default"'))
    assert.ok(installed.includes('[features]\nhooks = true'))
    assert.ok(installed.includes('experimental = true'))
    if (installed.includes('codex_hooks')) assert.ok(installed.includes('codex_hooks = true'))

    fs.writeFileSync(configPath, [
      '[features]',
      'codex_hooks = true',
      'experimental = true',
      ''
    ].join('\n'))
    const modernStatus = JSON.parse(execFileSync(process.execPath, ['-e', `
      const codex = require(${JSON.stringify(path.join(__dirname, '..', 'scripts/setup/codex.js'))})
      process.stdout.write(JSON.stringify(codex.status().modern))
    `], {
      env: Object.assign({}, process.env, { HOME: dir }),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    }))
    assert.strictEqual(modernStatus.featuresEnabled, false)
    assert.strictEqual(modernStatus.installed, false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex setup selects feature flags from detected app and CLI versions', () => {
  const none = {
    app: { installed: false, version: null },
    cli: { installed: false, version: null }
  }
  const newCli = {
    app: { installed: false, version: null },
    cli: { installed: true, version: '0.129.0' }
  }
  const oldCli = {
    app: { installed: false, version: null },
    cli: { installed: true, version: '0.128.9' }
  }
  const bothNew = {
    app: { installed: true, version: '26.506.0' },
    cli: { installed: true, version: '0.129.0' }
  }

  assert.deepStrictEqual(codexSetup.resolveFeatureFlags('', oldCli), ['hooks', 'codex_hooks'])
  assert.deepStrictEqual(codexSetup.resolveFeatureFlags('', newCli), ['hooks'])
  assert.deepStrictEqual(codexSetup.resolveFeatureFlags('', none), ['hooks', 'codex_hooks'])
  assert.deepStrictEqual(codexSetup.resolveFeatureFlags('[features]\nhooks = true\n', none), ['hooks'])
  assert.deepStrictEqual(
    codexSetup.selectFeatureFlags('[features]\nhooks = true\ncodex_hooks = true\n', newCli),
    ['hooks', 'codex_hooks']
  )
  assert.deepStrictEqual(
    codexSetup.selectFeatureFlags('[features]\nhooks = true\ncodex_hooks = true\n', bothNew),
    ['hooks']
  )
  assert.ok(codexSetup.upsertFeatures('', ['hooks', 'codex_hooks']).includes(
    '[features]\nhooks = true\ncodex_hooks = true'
  ))

  assert.strictEqual(codexSetup.extractVersion('Node.js 22.17.0\ncodex 0.130.0'), '0.130.0')
  assert.strictEqual(codexSetup.extractVersion('Codex.app version 26.506.1 (build 30905)'), '26.506.1')
  assert.strictEqual(codexSetup.extractVersion('Node.js 22.17.0\nother 2.500.1'), null)

  const tomlVariants = [
    '[features]\n"hooks" = true\n"codex_hooks" = true\nexperimental = true\n',
    '"features"."hooks" = true\n"features"."codex_hooks" = true\nfeatures.experimental = true\n',
    'features = { hooks = true, codex_hooks = true, experimental = true }\n'
  ]
  for (const input of tomlVariants) {
    assert.deepStrictEqual(codexSetup.selectFeatureFlags(input, bothNew), ['hooks'])
    const rewritten = TOML.parse(codexSetup.upsertFeatures(input, ['hooks']))
    assert.strictEqual(rewritten.features.hooks, true)
    assert.strictEqual(rewritten.features.codex_hooks, undefined)
    assert.strictEqual(rewritten.features.experimental, true)
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

test('sync marks running Claude session completed from transcript interrupt marker', () => {
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
      type: 'user',
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
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.endedAt, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.TURN_COMPLETE)
    assert.strictEqual(result.stats.claudeTranscript.filesRead, 1)
    assert.strictEqual(result.stats.claudeTranscript.interrupted, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync does not interrupt when the marker text is merely quoted (strict structural match)', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-quoted-marker'
    const transcriptPath = path.join(dir, 'quoted.jsonl')
    const now = Date.now()
    // The phrase appears only inside an assistant message and a normal user
    // prompt — never as Claude's own `type:'user'` interrupt record. The old
    // recursive text match false-positived here; the strict match must not.
    fs.writeFileSync(transcriptPath,
      JSON.stringify({
        timestamp: new Date(now).toISOString(),
        type: 'user',
        message: { content: [{ type: 'text', text: 'what does "[Request interrupted by user]" mean?' }] }
      }) + '\n' +
      JSON.stringify({
        timestamp: new Date(now + 1000).toISOString(),
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'It is the marker [Request interrupted by user] Claude writes on ESC.' }] }
      }) + '\n')

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        [sessionId]: {
          sessionId,
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now,
          lastUpdated: now,
          lastHookAt: now,
          transcriptPath,
          activeTool: null
        }
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      paneGroundTruth: false,
      stuckSweep: false,
      idleComplete: false
    })
    const session = result.status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(result.stats.claudeTranscript.interrupted, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync skips re-reading an unchanged Claude transcript when a scan cache is supplied', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-cache'
    const transcriptPath = path.join(dir, 'transcript.jsonl')
    const now = Date.now()
    // A running transcript with no interrupt marker yet.
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working on it' }] }
    }) + '\n')

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        [sessionId]: {
          sessionId,
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now,
          lastUpdated: now,
          lastHookAt: now,
          transcriptPath,
          activeTool: null
        }
      }
    }, null, 2))

    const cache = {}
    const runOptions = {
      reconcile: false,
      codexMode: 'none',
      paneGroundTruth: false,
      stuckSweep: false,
      idleComplete: false,
      claudeTranscriptState: cache
    }

    // First run reads the file (no marker -> no hit) and populates the cache.
    const first = sync.run(statusFile, runOptions)
    assert.strictEqual(first.stats.claudeTranscript.filesRead, 1)
    assert.strictEqual(first.stats.claudeTranscript.skippedUnchanged, 0)
    assert.strictEqual(currentPhase(first.status.sessions[sessionId]), 'running')
    assert.ok(cache[sessionId], 'scan-state cache entry was written')

    // Second run: transcript byte-identical -> skip the tail read entirely.
    const second = sync.run(statusFile, runOptions)
    assert.strictEqual(second.stats.claudeTranscript.filesRead, 0)
    assert.strictEqual(second.stats.claudeTranscript.skippedUnchanged, 1)
    assert.strictEqual(currentPhase(second.status.sessions[sessionId]), 'running')

    // Append an interrupt marker: the file grows -> cache miss -> rescanned and
    // detected on the very next run (the marker is never skipped).
    fs.appendFileSync(transcriptPath, JSON.stringify({
      timestamp: new Date(now + 2000).toISOString(),
      type: 'user',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }
    }) + '\n')

    const third = sync.run(statusFile, runOptions)
    assert.strictEqual(third.stats.claudeTranscript.filesRead, 1)
    assert.strictEqual(third.stats.claudeTranscript.skippedUnchanged, 0)
    assert.strictEqual(third.stats.claudeTranscript.interrupted, 1)
    assert.strictEqual(currentPhase(third.status.sessions[sessionId]), 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync batches every sweep into a single status.json write per run', () => {
  const dir = tempDir()
  const realRenameSync = fs.renameSync
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()

    // Two independent sweeps must each mutate a session in the same run:
    //   idleComplete completes `idleClaude`, the interrupt sweep completes
    //   `interruptedClaude`. Pre-batching this produced two full status writes.
    const staleTranscript = path.join(dir, 'stale.jsonl')
    fs.writeFileSync(staleTranscript, JSON.stringify({ type: 'assistant' }) + '\n')
    const staleTime = new Date(now - 300000)
    fs.utimesSync(staleTranscript, staleTime, staleTime)

    const interruptTranscript = path.join(dir, 'interrupt.jsonl')
    fs.writeFileSync(interruptTranscript, JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: 'user',
      message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }
    }) + '\n')

    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        idleClaude: {
          sessionId: 'idleClaude',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          transcriptPath: staleTranscript,
          activeTool: null
        },
        interruptedClaude: {
          sessionId: 'interruptedClaude',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now,
          lastUpdated: now,
          lastHookAt: now,
          transcriptPath: interruptTranscript,
          activeTool: null
        }
      }
    }, null, 2))

    let statusWrites = 0
    fs.renameSync = (from, to) => {
      if (to === statusFile) statusWrites++
      return realRenameSync(from, to)
    }

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      idleCompleteMs: 60000
    })

    assert.strictEqual(statusWrites, 1, 'the whole run flushes status.json exactly once')
    // Both mutations landed and are readable back from the single write.
    const persisted = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(currentPhase(persisted.sessions.idleClaude), 'completed')
    assert.strictEqual(currentPhase(persisted.sessions.interruptedClaude), 'completed')
    assert.strictEqual(currentPhase(result.status.sessions.idleClaude), 'completed')
    assert.strictEqual(currentPhase(result.status.sessions.interruptedClaude), 'completed')
  } finally {
    fs.renameSync = realRenameSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync leaves recently-active running sessions alone (idle-complete threshold)', () => {
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
        idleClaude: {
          sessionId: 'idleClaude',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 10000,
          lastUpdated: now - 10000,
          lastHookAt: now - 10000,
          activeTool: null
        }
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000
    })

    // Idle 10s is well under the 60s threshold — a short lull must not complete.
    const session = result.status.sessions.idleClaude
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(result.stats.claudeTranscript.idleInterrupted, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync applies exact Claude-only idle interrupt conditions', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()

    const staleTranscript = path.join(dir, 'stale.jsonl')
    fs.writeFileSync(staleTranscript, JSON.stringify({ type: 'assistant' }) + '\n')
    const staleTime = new Date(now - 300000)
    fs.utimesSync(staleTranscript, staleTime, staleTime)

    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        stuckRunning: {
          sessionId: 'stuckRunning',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          transcriptPath: staleTranscript,
          activeTool: null
        },
        noTranscriptClaude: {
          sessionId: 'noTranscriptClaude',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          activeTool: null
        },
        idleGemini: {
          sessionId: 'idleGemini',
          agentType: 'gemini',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          activeTool: null
        },
        busyWithTool: {
          sessionId: 'busyWithTool',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          activeTool: 'Bash'
        },
        remoteClaude: {
          sessionId: 'remoteClaude',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          activeTool: null,
          isRemote: true
        }
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000
    })

    const stuck = result.status.sessions.stuckRunning
    assert.strictEqual(currentPhase(stuck), 'completed')
    assert.strictEqual(stuck.status, 'completed')
    assert.strictEqual(stuck.endedAt, null, 'completed reopens on a new turn, so endedAt stays null')
    assert.strictEqual(result.stats.claudeTranscript.idleInterrupted, 2)

    // The Claude 120s fallback does not require a transcript.
    assert.strictEqual(currentPhase(result.status.sessions.noTranscriptClaude), 'completed')

    // The timeout is Claude-specific and excludes remote sessions.
    assert.strictEqual(currentPhase(result.status.sessions.idleGemini), 'running')
    assert.strictEqual(currentPhase(result.status.sessions.remoteClaude), 'running')

    const busy = result.status.sessions.busyWithTool
    assert.strictEqual(currentPhase(busy), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude long-running tool stays BUSY through the idle sweep', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-long-running-tool'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    const staleTime = Date.now() - 180000
    status.sessions[sessionId].lastUpdated = staleTime
    status.sessions[sessionId].lastHookAt = staleTime
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000,
      registryPrune: false
    })
    const session = result.status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(result.stats.claudeTranscript.idleInterrupted, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync does not idle-complete Codex running sessions as done', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()
    const staleTranscript = path.join(dir, 'codex-stale.jsonl')
    fs.writeFileSync(staleTranscript, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'keep working' }
    }) + '\n')
    const staleTime = new Date(now - 300000)
    fs.utimesSync(staleTranscript, staleTime, staleTime)

    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        idleCodex: {
          sessionId: 'idleCodex',
          agentType: 'codex',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          transcriptPath: staleTranscript,
          activeTool: null,
          pendingToolUse: null,
          pendingInteraction: null
        }
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000,
      registryPrune: false
    })

    assert.strictEqual(currentPhase(result.status.sessions.idleCodex), 'running')
    const persisted = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(currentPhase(persisted.sessions.idleCodex), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('notification intent classifier uses structured types and ignores message prose', () => {
  const { classifyNotification } = require('../scripts/lib/notification-intent')
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }).tool, undefined)
  assert.strictEqual(classifyNotification({ message: 'Claude Code needs your approval for the plan' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: 'Claude has a question for you' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: 'Claude is waiting for your input' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: 'Permission prompt shown' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: '请授权执行该命令' }).intent, 'info')
  assert.strictEqual(classifyNotification({ notification_type: 'idle_prompt', message: 'x' }).intent, 'idle')
  assert.strictEqual(classifyNotification({ notification_type: 'elicitation_dialog', message: '请选择' }).intent, 'info')
  assert.strictEqual(classifyNotification({ notification_type: 'ToolPermission', details: { type: 'ask_user' } }).intent, 'question')
  assert.strictEqual(classifyNotification({ notification_type: 'permission_prompt' }).intent, 'permission')
})

test('sync does not resolve WAIT from transcript mtime', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const statusFile = path.join(scoutDir, 'status.json')
    const transcript = path.join(dir, 'wait.jsonl')
    const now = Date.now()
    const waitStart = now - 60000
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n')
    const advanced = new Date(now - 1000)
    fs.utimesSync(transcript, advanced, advanced) // transcript advanced past the wait

    const session = {
      sessionId: 'stuckWait', agentType: 'gemini', status: 'working',
      phase: 'waitingForApproval', needsAttention: 'waiting for approval',
      tmuxPane: '%1', transcriptPath: transcript, startedAt: waitStart, lastUpdated: waitStart,
      pendingInteraction: { type: 'approval', phase: 'waitingForApproval', startedAt: waitStart, updatedAt: waitStart, reason: 'waiting for approval' }
    }
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: now, sessions: { stuckWait: session } }))

    const result = sync.run(statusFile, { reconcile: false, codexMode: 'none', claudeTranscript: false })
    const unresolved = result.status.sessions.stuckWait
    assert.strictEqual(currentPhase(unresolved), 'waitingForApproval')
    assert.strictEqual(unresolved.needsAttention, 'waiting for approval')
    assert.strictEqual(unresolved.pendingInteraction.type, 'approval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync keeps a genuine wait while the transcript stays quiet', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const statusFile = path.join(scoutDir, 'status.json')
    const transcript = path.join(dir, 'quiet.jsonl')
    const now = Date.now()
    const waitStart = now - 60000
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user' }) + '\n')
    const atStart = new Date(waitStart + 1000) // no writes after the wait began
    fs.utimesSync(transcript, atStart, atStart)

    const session = {
      sessionId: 'quietWait', agentType: 'claude', status: 'working',
      phase: 'waitingForApproval', needsAttention: 'waiting for approval',
      tmuxPane: '%1', transcriptPath: transcript, startedAt: waitStart, lastUpdated: waitStart,
      pendingInteraction: { type: 'approval', phase: 'waitingForApproval', startedAt: waitStart, updatedAt: waitStart, reason: 'waiting for approval' }
    }
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: now, sessions: { quietWait: session } }))

    const result = sync.run(statusFile, { reconcile: false, codexMode: 'none', claudeTranscript: false })
    assert.strictEqual(currentPhase(result.status.sessions.quietWait), 'waitingForApproval')
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
        activeGhost: {
          sessionId: 'activeGhost',
          agentType: 'claude',
          status: 'working',
          phase: 'running',
          tmuxPane: '%8888',
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

    assert.strictEqual(stats.reconcile.paneVanished, 2)
    const reloaded = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(reloaded.sessions.ghost.status, 'stale')
    assert.match(reloaded.sessions.ghost.staleReason || '', /pane %9999 no longer exists/)
    assert.strictEqual(reloaded.sessions.activeGhost.status, 'stale')
    assert.strictEqual(reloaded.sessions.activeGhost.terminalKind, 'paneGone')
    assert.strictEqual(reloaded.sessions.live.status, 'completed')
    assert.strictEqual(reloaded.sessions.unbound.status, 'completed')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync prunes terminal sessions after their display window expires', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    const sessionsDir = path.join(scoutDir, 'sessions')
    const statusFile = path.join(scoutDir, 'status.json')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const now = Date.now()
    const oldEndedAt = now - DEFAULT_TERMINAL_DISPLAY_MS - 1000
    const session = {
      sessionId: 'old-stale',
      agentType: 'claude',
      status: 'stale',
      phase: 'stale',
      tmuxPane: '%9999',
      startedAt: now - 120000,
      lastUpdated: oldEndedAt,
      endedAt: oldEndedAt
    }
    fs.writeFileSync(path.join(sessionsDir, 'old-stale.json'), JSON.stringify(session, null, 2))
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        'old-stale': session
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      registryNow: now
    })

    assert.strictEqual(result.status.sessions['old-stale'], undefined)
    assert.strictEqual(fs.existsSync(path.join(sessionsDir, 'old-stale.json')), false)
    assert.strictEqual(result.stats.registry.deleted, 1)
    assert.strictEqual(result.stats.registry.terminal, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync prunes every phase after seven-day stale retention', () => {
  const dir = tempDir()
  try {
    const scoutDir = path.join(dir, '.tmux-scout')
    const sessionsDir = path.join(scoutDir, 'sessions')
    const statusFile = path.join(scoutDir, 'status.json')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const now = Date.now()
    const old = now - DEFAULT_STALE_SESSION_MS - 1000
    const staleWait = {
      sessionId: 'old-codex-app-wait',
      agentType: 'codex',
      phase: 'waitingForAnswer',
      status: 'working',
      needsAttention: 'waiting for answer',
      startedAt: old,
      lastUpdated: old
    }
    const freshBusy = {
      sessionId: 'fresh-tmux-busy',
      agentType: 'codex',
      phase: 'running',
      status: 'working',
      tmuxPane: '%1',
      startedAt: old,
      lastUpdated: now - 1000
    }
    for (const session of [staleWait, freshBusy]) {
      fs.writeFileSync(path.join(sessionsDir, `${session.sessionId}.json`), JSON.stringify(session, null, 2))
    }
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        [staleWait.sessionId]: staleWait,
        [freshBusy.sessionId]: freshBusy
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      registryNow: now
    })

    assert.strictEqual(result.status.sessions[staleWait.sessionId], undefined)
    assert.ok(result.status.sessions[freshBusy.sessionId])
    assert.strictEqual(fs.existsSync(path.join(sessionsDir, `${staleWait.sessionId}.json`)), false)
    assert.strictEqual(result.stats.registry.deleted, 1)
    assert.strictEqual(result.stats.registry.expired, 1)
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

test('render ignores every session outside the tmux management boundary', () => {
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
      },
      codexAppWait: {
        sessionId: 'codexAppWait',
        agentType: 'codex',
        status: 'working',
        phase: 'waitingForAnswer',
        needsAttention: 'waiting for answer',
        pendingInteraction: { type: 'question', phase: 'waitingForAnswer' },
        tmuxPane: null,
        stateSource: 'codex-hooks',
        sessionTitle: 'Hi. What would you like to work on?',
        lastUpdated: Date.now()
      }
    }
  }, new Map())
  assert.deepStrictEqual(active.map(session => session.sessionId), [])
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

test('render prefers wait over newer foreground busy session in the same pane', () => {
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

  assert.deepStrictEqual(active.map(session => session.sessionId), ['staleWait'])
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
      claudeTranscript: false,
      registryPrune: false
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

test('codex sync marks stale active-tool sessions completed when no stop hook arrives', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '35353535-3535-4535-8535-353535353536'
    const now = Date.now()
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      stateSource: 'codex-hooks',
      tmuxPane: '%1',
      activeTool: 'Bash',
      lastUpdated: now - 10000,
      lastHookAt: now - 10000,
      sessionTitle: 'stuck command'
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: now - 10000, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      claudeTranscript: false,
      codexStuckInterruptMs: 1
    })

    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
    assert.strictEqual(updated.terminalKind, 'completed')
    assert.strictEqual(result.stats.codex.idleInterrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex stuck sweep follows the activeTool condition despite display residue', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '35353535-3535-4535-8535-353535353537'
    const now = Date.now()
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      stateSource: 'codex-hooks',
      tmuxPane: '%1',
      activeTool: 'Bash',
      pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: now - 10000 },
      lastUpdated: now - 10000,
      lastHookAt: now - 10000,
      sessionTitle: 'long command'
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, lastUpdated: now - 10000, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      claudeTranscript: false,
      codexStuckInterruptMs: 1
    })

    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
    assert.strictEqual(updated.pendingToolUse, null)
    assert.strictEqual(result.stats.codex.idleInterrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync marks matching current turn completed from transcript interrupt', () => {
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
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.lastEvent.turnId, 'turn-current')
    assert.strictEqual(updated.stateEvidence[0].rawEventName, 'turn_aborted')
    assert.strictEqual(result.stats.codex.interrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync marks a tmux session DONE from matching transcript task_complete', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-review-task-complete'
    const jsonl = path.join(dir, 'codex-review-task-complete.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now - 10000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'turn-old', last_agent_message: 'old result' }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now - 1000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'turn-current', last_agent_message: 'review finished' }
      })
    ].join('\n') + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: '%43',
      lastTurnId: 'turn-current',
      lastUpdated: now - 5000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    const sessionFile = path.join(scoutDir, 'sessions', `${threadId}.json`)
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
    assert.strictEqual(updated.lastEvent.turnId, 'turn-current')
    assert.strictEqual(updated.stateEvidence[0].rawEventName, 'task_complete')
    assert.strictEqual(result.stats.codex.completed, 1)
    assert.strictEqual(result.stats.codex.interrupted, 0)
    assert.strictEqual(currentPhase(JSON.parse(fs.readFileSync(sessionFile, 'utf-8'))), 'completed')
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync ignores task_complete from an older turn', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-stale-task-complete'
    const jsonl = path.join(dir, 'codex-stale-task-complete.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 1000).toISOString(),
      payload: { type: 'task_complete', turn_id: 'turn-old' }
    }) + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: '%44',
      lastTurnId: 'turn-current',
      lastUpdated: now - 5000
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
    assert.strictEqual(updated.lastEvent, undefined)
    assert.strictEqual(result.stats.codex.completed, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex transcript sweep and cache ignore child and remote sessions', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const sessions = {}
    const cases = [
      { sessionId: 'codex-child-abort', parentSessionId: 'codex-parent', interrupted: true },
      { sessionId: 'codex-child-no-hit', parentSessionId: 'codex-parent', interrupted: false },
      { sessionId: 'codex-remote-abort', isRemote: true, interrupted: true }
    ]

    for (const testCase of cases) {
      const transcriptPath = path.join(dir, `${testCase.sessionId}.jsonl`)
      const rows = [{
        type: 'event_msg',
        timestamp: new Date(now - 5000).toISOString(),
        payload: { type: 'user_message', message: 'keep working', turn_id: 'turn-current' }
      }]
      if (testCase.interrupted) {
        rows.push({
          type: 'event_msg',
          timestamp: new Date(now - 4000).toISOString(),
          payload: { type: 'turn_aborted', turn_id: 'turn-current', reason: 'interrupted' }
        })
      }
      fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')

      const session = {
        sessionId: testCase.sessionId,
        threadId: testCase.sessionId,
        agentType: 'codex',
        status: 'working',
        phase: 'running',
        transcriptPath,
        lastTurnId: 'turn-current',
        lastUpdated: now - 5000,
        parentSessionId: testCase.parentSessionId,
        isRemote: testCase.isRemote
      }
      sessions[testCase.sessionId] = session
      fs.writeFileSync(
        path.join(scoutDir, 'sessions', `${testCase.sessionId}.json`),
        JSON.stringify(session, null, 2)
      )
    }

    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions }, null, 2))
    const codexTranscriptState = Object.fromEntries(
      cases.map(testCase => [testCase.sessionId, { transcriptPath: 'stale-cache-entry' }])
    )

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      idleComplete: false,
      claudeTranscript: false,
      codexTranscriptSettleGateMs: 0,
      codexTranscriptState
    })

    for (const testCase of cases) {
      assert.strictEqual(currentPhase(result.status.sessions[testCase.sessionId]), 'running')
    }
    assert.strictEqual(result.stats.codex.filesRead, 0)
    assert.deepStrictEqual(codexTranscriptState, {})
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync does not invent a WAIT state from completed plan transcript text', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-plan-wait-sync'
    const jsonl = path.join(dir, 'codex-plan-wait-sync.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now - 3000).toISOString(),
        payload: {
          type: 'item_completed',
          thread_id: threadId,
          turn_id: 'turn-plan',
          item: { type: 'Plan', id: 'plan-item', text: '# Fix status sync\n\n- Use canonical semantics' }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now - 2500).toISOString(),
        payload: { type: 'task_complete', turn_id: 'turn-plan' }
      })
    ].join('\n') + '\n')
    const fileTime = new Date(now - 2500)
    fs.utimesSync(jsonl, fileTime, fileTime)

    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'completed',
      phase: 'completed',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-plan',
      lastUpdated: now - 2400,
      lifecycle: { phase: 'completed', source: 'notify', priority: 40, updatedAt: now - 2400 }
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      waitResolve: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
    assert.strictEqual(updated.needsAttention, undefined)
    assert.strictEqual(updated.pendingInteraction, undefined)
    assert.strictEqual(updated.lastTurnId, 'turn-plan')
    assert.strictEqual(result.stats.codex.updated, 0)
    assert.strictEqual(Object.hasOwn(result.stats.codex, 'planWaits'), false)

    const counts = statusBar.summarizeSessions([updated])
    assert.strictEqual(counts.wait, 0)
    assert.strictEqual(counts.plan, 0)
    assert.strictEqual(counts.done, 1)
    assert.strictEqual(counts.busy, 0)

    runHook('scripts/hooks/codex.js', {
      hook_event_name: 'UserPromptSubmit',
      session_id: threadId,
      thread_id: threadId,
      cwd: '/tmp/demo',
      transcript_path: jsonl,
      turn_id: 'turn-implement',
      prompt: 'Implement this plan.'
    }, dir)

    const resumed = readScoutStatus(dir).sessions[threadId]
    assert.strictEqual(currentPhase(resumed), 'running')
    assert.strictEqual(resumed.status, 'working')
    assert.strictEqual(resumed.needsAttention, null)
    assert.strictEqual(resumed.pendingInteraction, null)
    assert.strictEqual(resumed.pendingToolUse, null)
    assert.strictEqual(resumed.lastTurnId, 'turn-implement')
    assert.ok(resumed.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PROMPT_SUBMIT))
    assert.ok(!resumed.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_RESOLVED))
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync does not invent a new turn from internal goal transcript text', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-goal-turn-start'
    const jsonl = path.join(dir, 'codex-goal-turn-start.jsonl')
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now - 10000).toISOString(),
        payload: { type: 'task_complete', turn_id: 'turn-plan' }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: new Date(now - 1000).toISOString(),
        payload: {
          type: 'message',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-goal' },
          content: [{ type: 'output_text', text: '<codex_internal_context source="goal">' }]
        }
      })
    ].join('\n') + '\n')

    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'completed',
      phase: 'completed',
      transcriptPath: jsonl,
      tmuxPane: null,
      lastTurnId: 'turn-plan',
      lastUpdated: now - 9000,
      lifecycle: { phase: 'completed', source: 'hook', priority: 90, updatedAt: now - 9000 }
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      waitResolve: false
    })
    const updated = result.status.sessions[threadId]
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
    assert.strictEqual(updated.lastTurnId, 'turn-plan')
    assert.strictEqual(updated.lastUpdated, now - 9000)
    assert.strictEqual(result.stats.codex.updated, 0)
    assert.strictEqual(Object.hasOwn(result.stats.codex, 'turnStarts'), false)
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

test('codex sync rescans legacy transcript cache entries for task_complete', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const now = Date.now()
    const threadId = 'codex-legacy-task-complete-cache'
    const jsonl = path.join(dir, 'codex-legacy-task-complete-cache.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(now - 1000).toISOString(),
      payload: { type: 'task_complete', turn_id: 'turn-current' }
    }) + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: '%45',
      lastTurnId: 'turn-current',
      lastUpdated: now - 5000
    }
    const statusFile = path.join(scoutDir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { [threadId]: session } }, null, 2))
    fs.writeFileSync(path.join(scoutDir, 'sessions', `${threadId}.json`), JSON.stringify(session, null, 2))

    const stat = fs.statSync(jsonl)
    const codexTranscriptState = {
      [threadId]: {
        transcriptPath: jsonl,
        latestTurnId: 'turn-current',
        lastScannedSize: stat.size,
        lastScannedMtimeMs: stat.mtimeMs,
        lastScannedInode: stat.ino,
        lastScannedAt: now - 2000
      }
    }
    const result = sync.run(statusFile, {
      reconcile: false,
      paneGroundTruth: false,
      stuckSweep: false,
      claudeTranscript: false,
      codexTranscriptSettleGateMs: 0,
      codexTranscriptState
    })

    assert.strictEqual(result.stats.codex.filesRead, 1)
    assert.strictEqual(result.stats.codex.completed, 1)
    assert.strictEqual(currentPhase(result.status.sessions[threadId]), 'completed')
    assert.deepStrictEqual(codexTranscriptState, {})
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
    assert.strictEqual(codexTranscriptState[threadId].scanVersion, 2)
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
    assert.strictEqual(currentPhase(third.status.sessions[threadId]), 'completed')
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
    assert.strictEqual(currentPhase(second.status.sessions[threadId]), 'completed')
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex transcript turn-end sweep leaves WAIT sessions untouched', () => {
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
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(now - 500).toISOString(),
          payload: { type: 'task_complete', turn_id: testCase.turnId }
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
      assert.strictEqual(currentPhase(updated), testCase.phase)
      assert.strictEqual(updated.deferredCompletion, undefined)
      assert.strictEqual(updated.lastEvent, undefined)
      assert.strictEqual(updated.stateEvidence, undefined)

      applySessionEvent(updated, {
        type: testCase.phase === 'waitingForAnswer' ? 'question_answered' : 'permission_resolved',
        source: 'hook',
        timestamp: now
      })
      assert.strictEqual(currentPhase(updated), 'running')
    }
    assert.strictEqual(result.stats.codex.completed, 0)
    assert.strictEqual(result.stats.codex.interrupted, 0)
    assert.strictEqual(result.stats.codex.filesRead, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync does not degrade an exact turn lookup to a timestamp match', () => {
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
    assert.strictEqual(currentPhase(updated), 'running')
    assert.strictEqual(updated.stateEvidence, undefined)
    assert.strictEqual(result.stats.codex.interrupted, 0)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex sync uses timestamp fallback only when the current turn id is unknown', () => {
  const dir = tempDir()
  const oldHome = process.env.HOME
  try {
    process.env.HOME = dir
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true })
    const scoutDir = path.join(dir, '.tmux-scout')
    fs.mkdirSync(path.join(scoutDir, 'sessions'), { recursive: true })
    const threadId = '39393939-3939-4939-8939-393939393939'
    const jsonl = path.join(dir, 'codex-interrupted-fallback.jsonl')
    fs.writeFileSync(jsonl, JSON.stringify({
      type: 'event_msg',
      timestamp: new Date(Date.now() - 1000).toISOString(),
      payload: { type: 'turn_aborted', reason: 'interrupted' }
    }) + '\n')
    const session = {
      sessionId: threadId,
      threadId,
      agentType: 'codex',
      status: 'working',
      phase: 'running',
      transcriptPath: jsonl,
      tmuxPane: null,
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
    assert.strictEqual(currentPhase(updated), 'completed')
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

test('claude transcript watcher helper marks running sessions completed', () => {
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
      type: 'user',
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
    assert.strictEqual(currentPhase(updated), 'completed')
    assert.strictEqual(updated.status, 'completed')
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
    fs.appendFileSync(transcriptPath, '{"type":"user","timestamp":"' + new Date(now + 1000).toISOString() + '","message":{"content":[{"type":"text","text":"[Request interrupted')
    assert.strictEqual(manager.scanWatch(sessionId), false)
    fs.appendFileSync(transcriptPath, ' by user]"}]}}\n')
    assert.strictEqual(manager.scanWatch(sessionId), true)
    assert.strictEqual(markClaudeInterrupted(statusFile, sessionId), true)
    const updated = JSON.parse(fs.readFileSync(statusFile, 'utf-8')).sessions[sessionId]
    assert.strictEqual(currentPhase(updated), 'completed')
  } finally {
    if (manager) manager.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook waits for AskUserQuestion only at PermissionRequest', () => {
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

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse.tool, 'AskUserQuestion')
    assert.strictEqual(session.activeTool, 'AskUserQuestion')
    assert.strictEqual(session.lastEvent.type, 'tool_use')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: '继续吗？' }] }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for answer')
    assert.strictEqual(session.activeTool, 'AskUserQuestion')
    assert.strictEqual(session.pendingInteraction.type, 'question')
    assert.strictEqual(session.pendingInteraction.tool, 'AskUserQuestion')
    assert.strictEqual(session.lastEvent.type, 'question_asked')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude PostToolUse resolves a pending question before completing the tool', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-question-resolved'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask me first'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Continue?' }] }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Continue?' }] }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'AskUserQuestion'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    const evidenceTypes = session.stateEvidence.map(evidence => evidence.type)
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
    assert.ok(evidenceTypes.includes('question_answered'))
    // The adapter emits a redundant permissionResolved after questionAnswered here,
    // and SessionState deliberately treats it as an exact no-op.
    assert.ok(!evidenceTypes.includes('permission_resolved'))
    assert.ok(evidenceTypes.includes('post_tool_use'))
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
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.stateEvidence[0].type, 'tool_use')
    assert.strictEqual(session.stateEvidence[0].activeTool, 'Bash')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingToolUse.details, 'Bash: npm test')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.details, 'Bash: npm test')
    assert.strictEqual(session.lastEvent.type, 'permission_request')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude Stop clears a stale approval wait before completing', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-deferred-stop'
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
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.deferredCompletion, null)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_RESOLVED))

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_RESOLVED))
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
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
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

test('claude hook marks Ralph loop Stop as loop iteration in picker', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-ralph-loop'
    const cwd = path.join(dir, 'project')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.claude', 'ralph-loop.local.md'), [
      '---',
      'active: true',
      `session_id: ${sessionId}`,
      'iteration: 2',
      'max_iterations: 5',
      'completion_promise: "ship when green"',
      '---',
      ''
    ].join('\n'))

    const base = { session_id: sessionId, cwd }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run Ralph loop'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'iteration done'
    }), dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.isRalphLoopIteration, true)
    assert.strictEqual(session.ralphLoop.iteration, 2)
    assert.strictEqual(session.ralphLoop.maxIterations, 5)
    assert.strictEqual(session.ralphLoop.completionPromise, 'ship when green')

    const pane = { paneId: '%1', currentCommand: 'node', paneDead: false, windowName: 'main' }
    session._tmuxPaneSnapshot = pane
    const line = stripAnsi(formatLine(session, Date.now(), '%1'))
    assert.ok(line.includes('LOOP'), line)
    assert.ok(line.includes('Ralph loop 2/5'), line)
    assert.deepStrictEqual(
      getActiveSessions(status, new Map([['%1', pane]])).map(item => item.sessionId),
      [sessionId]
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook clears Ralph loop marker on normal Stop', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-ralph-clear'
    const cwd = path.join(dir, 'project')
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    const loopPath = path.join(cwd, '.claude', 'ralph-loop.local.md')
    fs.writeFileSync(loopPath, [
      '---',
      'active: true',
      `session_id: ${sessionId}`,
      'iteration: 1',
      'max_iterations: 3',
      'completion_promise: null',
      '---',
      ''
    ].join('\n'))

    const base = { session_id: sessionId, cwd }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run Ralph loop'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'iteration done'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.isRalphLoopIteration, true)

    fs.writeFileSync(loopPath, [
      '---',
      'active: false',
      `session_id: ${sessionId}`,
      'iteration: 3',
      'max_iterations: 3',
      'completion_promise: null',
      '---',
      ''
    ].join('\n'))
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'all done'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(session.isRalphLoopIteration, null)
    assert.strictEqual(session.ralphLoop, null)
    session._tmuxPaneSnapshot = { paneId: '%1', currentCommand: 'node', paneDead: false, windowName: 'main' }
    const line = stripAnsi(formatLine(session, Date.now(), '%1'))
    assert.ok(line.includes('DONE'), line)
    assert.ok(!line.includes('LOOP'), line)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook keeps compact and clear lifecycle events phase-neutral', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-clear'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'make a plan'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 'do it' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for plan approval')
    assert.strictEqual(session.pendingInteraction.type, 'plan')
    assert.strictEqual(session.pendingInteraction.tool, 'ExitPlanMode')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'compact'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for plan approval')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'clear'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.needsAttention, 'waiting for plan approval')
    assert.strictEqual(session.pendingToolUse.tool, 'ExitPlanMode')
    assert.strictEqual(session.pendingInteraction.type, 'plan')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude hook ignores Notification state and maps PreCompact to activity', () => {
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

    const beforeNotification = readScoutStatus(dir).sessions[sessionId]
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Notification',
      message: 'Permission prompt shown'
    }), dir)
    const afterNotification = readScoutStatus(dir).sessions[sessionId]
    assert.deepStrictEqual(afterNotification, beforeNotification)

    runHook('scripts/hooks/claude.js', {
      hook_event_name: 'Notification',
      session_id: 'claude-notification-must-not-create-session',
      message: 'Claude is waiting for your input'
    }, dir)
    assert.strictEqual(
      readScoutStatus(dir).sessions['claude-notification-must-not-create-session'],
      undefined
    )

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PreCompact',
      trigger: 'manual'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.lastNotification, undefined)
    assert.strictEqual(session.lastCompactReason, 'manual')
    assert.strictEqual(session.currentActivity, 'Compacting conversation...')
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude PreCompact reopens DONE as BUSY but never clears WAIT', () => {
  const dir = tempDir()
  try {
    const doneId = 'claude-precompact-done'
    const doneBase = { session_id: doneId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, doneBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'compact later'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, doneBase, { hook_event_name: 'Stop' }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, doneBase, { hook_event_name: 'PreCompact' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[doneId]), 'running')

    const waitId = 'claude-precompact-wait'
    const waitBase = { session_id: waitId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, waitBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask first'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, waitBase, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, waitBase, { hook_event_name: 'PreCompact' }), dir)
    assert.strictEqual(currentPhase(readScoutStatus(dir).sessions[waitId]), 'waitingForApproval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('claude SubagentStart does not resolve a real parent approval wait', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-notif-subagent'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'plan and build'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Task',
      tool_input: { description: 'launch worker' }
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStart',
      sub_agent: { id: 'sa1', type: 'Plan' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.needsAttention, 'waiting for approval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.ok(Array.isArray(session.activeSubagents) && session.activeSubagents.length === 1)
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

test('claude hook keeps subagent permission waits off the parent session state', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-parent-subagent-wait'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the branch'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStart',
      sub_agent: { id: 'claude-child-wait', type: 'reviewer' }
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      agent_id: 'claude-child-wait',
      tool_name: 'AskUserQuestion',
      tool_input: { question: 'continue?' }
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeSubagents[0].phase, 'waitingForAnswer')
    assert.match(session.activeSubagents[0].lastToolActivity, /AskUserQuestion/)
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
      last_assistant_message: '1. 请选择一个方案？\n- A\n- B'
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
      last_assistant_message: '1. 请选择一个方案？\n- A\n- B'
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

test('codex hook maps request_user_input to answer wait and resolution', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-request-user-input'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-question' }
    const toolInput = {
      questions: [{
        id: 'choice',
        header: 'Implementation',
        question: 'Which implementation should I use?',
        options: [
          { label: 'Keep current API' },
          { label: 'Add adapter' }
        ]
      }]
    }

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask before implementing'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: toolInput,
      tool_use_id: 'call-question'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')
    assert.strictEqual(session.needsAttention, 'waiting for answer')
    assert.strictEqual(session.pendingInteraction.type, 'question')
    assert.strictEqual(session.pendingInteraction.tool, 'request_user_input')
    assert.match(session.pendingInteraction.details, /Which implementation/)
    assert.strictEqual(session.activeTool, 'request_user_input')
    assert.strictEqual(session.lastEvent.type, 'question_asked')

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input',
      tool_input: toolInput,
      tool_response: '{"answers":{"choice":{"answers":["Keep current API"]}}}',
      tool_use_id: 'call-question'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === 'question_answered'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex request_user_input without a parseable prompt stays BUSY', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-empty-request-user-input'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-empty-question' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'continue without inventing a question'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: {}
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.activeTool, 'request_user_input')
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.TOOL_USE)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex Stop clears request_user_input wait before completing', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-request-user-input-deferred'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-question-deferred' }
    const toolInput = { message: '请选择一个方案？\n1. A\n2. B' }

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ask before implementing'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: toolInput
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.QUESTION_ANSWERED))

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'request_user_input',
      tool_input: toolInput,
      tool_response: '{"answers":{"q0":{"answers":["A"]}}}'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.QUESTION_ANSWERED))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook backfills user prompt from transcript before tool activity', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-backfill-prompt'
    const transcriptPath = path.join(dir, 'codex-backfill.jsonl')
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, source: { cli: 'codex' } }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'late prompt from transcript' }
      })
    ].join('\n') + '\n')

    const base = {
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath,
      turn_id: 'turn-backfill'
    }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session._codexUserConfirmed, true)
    assert.strictEqual(session.lastUserPrompt, 'late prompt from transcript')
    assert.strictEqual(session.sessionTitle, 'late prompt from transcript')

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex first-event Stop uses synchronous transcript confirmation and stays visible', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-first-stop-backfill'
    const transcriptPath = path.join(dir, 'codex-first-stop.jsonl')
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, source: 'cli' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'finish this turn' } })
    ].join('\n') + '\n')

    runHook('scripts/hooks/codex.js', {
      hook_event_name: 'Stop',
      session_id: sessionId,
      thread_id: sessionId,
      transcript_path: transcriptPath,
      cwd: '/tmp/demo',
      last_assistant_message: 'done'
    }, dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.lastUserPrompt, 'finish this turn')
    assert.notStrictEqual(session.isHiddenFromScout, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex prompt backfill scans beyond the old two MiB tail cap', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-deep-prompt-backfill'
    const transcriptPath = path.join(dir, 'codex-deep-prompt.jsonl')
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, source: { cli: 'codex' } }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'real prompt before a long transcript tail' }
      })
    ]
    const filler = 'x'.repeat(1024)
    for (let index = 0; index < 2300; index++) {
      lines.push(JSON.stringify({
        type: 'response_item',
        payload: { type: 'reasoning', id: index, text: filler }
      }))
    }
    fs.writeFileSync(transcriptPath, lines.join('\n') + '\n')
    assert.ok(fs.statSync(transcriptPath).size > 2 * 1024 * 1024)

    runHook('scripts/hooks/codex.js', {
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath,
      turn_id: 'turn-deep-backfill',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }, dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.lastUserPrompt, 'real prompt before a long transcript tail')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.isHiddenFromScout, undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex SessionStart without a transcript is silent', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-start-without-transcript'
    runHook('scripts/hooks/codex.js', {
      session_id: sessionId,
      thread_id: sessionId,
      cwd: '/tmp/demo',
      hook_event_name: 'SessionStart',
      source: 'startup'
    }, dir)

    const statusPath = path.join(dir, '.tmux-scout', 'status.json')
    if (fs.existsSync(statusPath)) {
      assert.strictEqual(readScoutStatus(dir).sessions[sessionId], undefined)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pre-confirm Codex and Claude SessionStart shells stay out of the picker', () => {
  const dir = tempDir()
  try {
    const codexId = 'codex-pre-confirm-shell'
    const transcriptPath = path.join(dir, 'codex-pre-confirm.jsonl')
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: codexId, source: { cli: 'codex' } }
    }) + '\n')
    runHook('scripts/hooks/codex.js', {
      session_id: codexId,
      thread_id: codexId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath,
      hook_event_name: 'SessionStart',
      source: 'startup'
    }, dir)

    const claudeId = 'claude-pre-confirm-shell'
    runHook('scripts/hooks/claude.js', {
      session_id: claudeId,
      cwd: '/tmp/demo',
      hook_event_name: 'SessionStart',
      source: 'startup'
    }, dir)

    const status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[codexId]), 'running')
    assert.strictEqual(currentPhase(status.sessions[claudeId]), 'running')
    assert.strictEqual(status.sessions[codexId].lastUserPrompt, undefined)
    assert.strictEqual(status.sessions[claudeId].lastUserPrompt, undefined)
    assert.deepStrictEqual(getActiveSessions(status, new Map([['%1', {
      paneId: '%1', currentCommand: 'codex', paneDead: false, windowName: 'main'
    }]])), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('repeated SessionStart cannot demote confirmed Codex or Claude BUSY to IDLE', () => {
  const dir = tempDir()
  try {
    const codexId = 'codex-repeat-start-busy'
    const transcriptPath = path.join(dir, 'codex-repeat-start.jsonl')
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: codexId, source: { cli: 'codex' } }
    }) + '\n')
    const codexBase = {
      session_id: codexId,
      thread_id: codexId,
      cwd: '/tmp/demo',
      transcript_path: transcriptPath
    }
    runHook('scripts/hooks/codex.js', Object.assign({}, codexBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'keep working'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, codexBase, {
      hook_event_name: 'SessionStart',
      source: 'resume'
    }), dir)

    const claudeId = 'claude-repeat-start-busy'
    const claudeBase = { session_id: claudeId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, claudeBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'keep working'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, claudeBase, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)

    const status = readScoutStatus(dir)
    const pane = { paneId: '%1', currentCommand: 'node', paneDead: false, windowName: 'main' }
    for (const sessionId of [codexId, claudeId]) {
      const session = status.sessions[sessionId]
      assert.strictEqual(currentPhase(session), 'running')
      assert.strictEqual(session.status, 'working')
      assert.strictEqual(session.lastUserPrompt, 'keep working')
      session._tmuxPaneSnapshot = pane
      const line = stripAnsi(formatLine(session, Date.now(), '%1'))
      assert.ok(line.includes('BUSY'), line)
      assert.ok(!line.includes('IDLE'), line)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown Claude compact and clear starts do not create session shells', () => {
  for (const source of ['compact', 'clear']) {
    const dir = tempDir()
    try {
      const sessionId = `claude-${source}-without-session`
      runHook('scripts/hooks/claude.js', {
        session_id: sessionId,
        cwd: '/tmp/demo',
        hook_event_name: 'SessionStart',
        source
      }, dir)
      const statusPath = path.join(dir, '.tmux-scout', 'status.json')
      if (fs.existsSync(statusPath)) {
        assert.strictEqual(readScoutStatus(dir).sessions[sessionId], undefined)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('codex hook hides Stop without confirmed user prompt instead of showing done', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-unconfirmed-stop'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'generated title'
    }), dir)

    const status = readScoutStatus(dir)
    const session = status.sessions[sessionId]
    assert.strictEqual(session.isHiddenFromScout, true)
    assert.strictEqual(session.hiddenReason, 'codex-unconfirmed-session')
    assert.deepStrictEqual(getActiveSessions(status, new Map()), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex legacy notify does not overwrite hook-managed busy session as done', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-notify-busy-guard'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-busy' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runHook('scripts/hooks/codex.js', {
      type: 'agent-turn-complete',
      'thread-id': sessionId,
      'turn-id': 'turn-busy',
      cwd: '/tmp/demo',
      'input-messages': [{ role: 'user', content: 'run tests' }],
      'last-assistant-message': 'done'
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.lastEvent.type, 'tool_use')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex legacy notify without user prompt does not create visible done session', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-notify-no-prompt'
    runHook('scripts/hooks/codex.js', {
      type: 'agent-turn-complete',
      'thread-id': sessionId,
      'turn-id': 'turn-no-prompt',
      cwd: '/tmp/demo',
      'last-assistant-message': '{"suggestions":[{"title":"internal"}]}'
    }, dir)

    const statusPath = path.join(dir, '.tmux-scout', 'status.json')
    if (!fs.existsSync(statusPath)) return
    const status = readScoutStatus(dir)
    assert.ok(!status.sessions[sessionId])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook bypasses PermissionRequest when approval_policy is never', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-approval-never'
    const transcriptPath = path.join(dir, 'codex-approval-never.jsonl')
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, source: 'cli' } }),
      JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'never' } })
    ].join('\n') + '\n')
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', transcript_path: transcriptPath, turn_id: 'turn-never' }

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, 'prompt_submit')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex bypass PermissionRequest is byte-for-byte inert during an existing WAIT', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-bypass-existing-wait'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'wait for approval'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    const before = JSON.stringify(readScoutStatus(dir).sessions[sessionId])

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' }
    }), dir)

    const after = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(JSON.stringify(after), before)
    assert.strictEqual(currentPhase(after), 'waitingForApproval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex hook bypasses duplicate native-approved PermissionRequest only for the same request', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-duplicate-native-approval'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-approval' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.ok(session._codexPendingNativeRequestId)

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session._codexPendingNativeRequestId, null)
    assert.strictEqual(session._codexNativeApprovedRequestIds.length, 1)

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, 'tool_use')
    assert.strictEqual(session.activeTool, 'Bash')

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.lastEvent.type, 'permission_request')
    assert.match(session.pendingInteraction.details, /npm run build/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex Stop clears a stale approval wait before completing', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-deferred-stop'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-deferred' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'done'
    }), dir)

    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.ok(session.stateEvidence.some(evidence => evidence.type === AGENT_EVENTS.PERMISSION_RESOLVED))

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
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

test('codex hook clears active tool after PostToolUse completion', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-post-tool-active'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo', turn_id: 'turn-tool' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
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

test('codex hook does not treat unstructured Stop question text as input wait', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-unstructured-question-text'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'finish and ask if needed'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      last_assistant_message: 'Which implementation should I use?'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.lastEvent.type, 'stop')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex Stop ignores unsupported payload wait flags and English option lists', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-payload-wait-flags'
    const base = { session_id: sessionId, thread_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'finish the task'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'Stop',
      awaiting_input: true,
      requires_input: true,
      wait_for_user: true,
      last_assistant_message: 'Which option should I use?\n1. Keep current API\n2. Add adapter'
    }), dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.STOP)
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

test('codex classifier hides newer internal background prompts and agent jobs', () => {
  const cases = [
    {
      prompt: 'Using the current thread context and the diff below, generate a single-line git commit message.',
      reason: 'codex-commit-message'
    },
    {
      prompt: 'Using the current thread context and the commit and pull request contexts below, generate one git commit message plus one pull request title and body.',
      reason: 'codex-commit-pr-message'
    },
    {
      prompt: '## GDPA Agent Box Runtime\n\nRun this automated task.',
      reason: 'codex-agent-box-runtime'
    }
  ]

  for (const testCase of cases) {
    const classification = classifyCodexSession({ prompt: testCase.prompt })
    assert.strictEqual(classification.hidden, true)
    assert.strictEqual(classification.isInternal, true)
    assert.strictEqual(classification.reason, testCase.reason)
  }

  const agentJob = classifyCodexSession({
    sessionMeta: {
      id: 'codex-agent-job',
      source: { subagent: { other: 'agent_job:123' } }
    }
  })
  assert.strictEqual(agentJob.hidden, true)
  assert.strictEqual(agentJob.isInternal, true)
  assert.strictEqual(agentJob.reason, 'codex-agent-job')
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

test('codex hook keeps fork-only transcript session visible', () => {
  const dir = tempDir()
  try {
    const sessionId = 'codex-large-transcript-fork'
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
    assert.notStrictEqual(session.isHiddenFromScout, true)
    assert.notStrictEqual(session.isCodexSubagent, true)
    assert.strictEqual(session.codexForkedFromId, 'parent-session')
    assert.strictEqual(currentPhase(session), 'running')
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
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [{ question: 'Continue child task?', options: [{ label: 'Yes' }] }] }
    }), dir)
    status = readScoutStatus(dir)
    assert.strictEqual(status.sessions[parentId].activeSubagents[0].phase, 'waitingForAnswer')
    assert.strictEqual(status.sessions[parentId].activeSubagents[0].lastToolActivity, 'Continue child task?')

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

test('Codex routing keeps a parent BUSY when child hooks reuse the parent session_id', () => {
  const dir = tempDir()
  try {
    const parentId = 'codex-reused-parent-id'
    const childFromMeta = 'codex-child-from-meta'
    const childFromPayload = 'codex-child-from-payload'
    const parentBase = { session_id: parentId, thread_id: parentId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/codex.js', Object.assign({}, parentBase, {
      hook_event_name: 'SessionStart',
      source: 'startup'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, parentBase, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'coordinate two workers'
    }), dir)

    const sessionMeta = {
      id: childFromMeta,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_nickname: 'worker'
          }
        }
      }
    }
    const reusedParentBase = Object.assign({}, parentBase, { _session_meta: sessionMeta })

    // No agent_id: derive the child from session_meta.id because
    // session_id is the parent_thread_id.
    runHook('scripts/hooks/codex.js', Object.assign({}, reusedParentBase, {
      hook_event_name: 'SessionStart'
    }), dir)
    runHook('scripts/hooks/codex.js', Object.assign({}, reusedParentBase, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    let status = readScoutStatus(dir)
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')
    assert.notStrictEqual(status.sessions[parentId].isHiddenFromScout, true)
    assert.strictEqual(status.sessions[parentId].activeSubagents.length, 1)
    assert.strictEqual(status.sessions[parentId].activeSubagents[0].agentId, childFromMeta)
    assert.strictEqual(status.sessions[childFromMeta].parentSessionId, parentId)
    assert.strictEqual(status.sessions[childFromMeta].isHiddenFromScout, true)

    // agent_id wins over session_meta.id and a child question cannot put the
    // parent itself into WAIT.
    runHook('scripts/hooks/codex.js', Object.assign({}, reusedParentBase, {
      hook_event_name: 'PreToolUse',
      agent_id: childFromPayload,
      tool_name: 'request_user_input',
      tool_input: { questions: [{ question: 'Which option?', options: [{ label: 'A' }] }] }
    }), dir)

    status = readScoutStatus(dir)
    const parent = status.sessions[parentId]
    assert.strictEqual(currentPhase(parent), 'running')
    assert.strictEqual(parent.pendingInteraction, null)
    assert.deepStrictEqual(
      parent.activeSubagents.map(item => item.agentId).sort(),
      [childFromMeta, childFromPayload].sort()
    )
    assert.strictEqual(
      parent.activeSubagents.find(item => item.agentId === childFromPayload).phase,
      'waitingForAnswer'
    )

    // Stop removes only the addressed child.
    runHook('scripts/hooks/codex.js', Object.assign({}, reusedParentBase, {
      hook_event_name: 'Stop',
      agent_id: childFromPayload,
      last_assistant_message: 'done'
    }), dir)
    status = readScoutStatus(dir)
    assert.deepStrictEqual(status.sessions[parentId].activeSubagents.map(item => item.agentId), [childFromMeta])
    assert.strictEqual(currentPhase(status.sessions[parentId]), 'running')

    // An IDLE pane-discovery placeholder must not beat the real BUSY root.
    status.sessions['tmux-pane:%1:codex'] = {
      sessionId: 'tmux-pane:%1:codex',
      agentType: 'codex',
      phase: 'idle',
      status: 'idle',
      tmuxPane: '%1',
      pid: null,
      lastUpdated: Date.now()
    }
    const pane = { paneId: '%1', currentCommand: 'codex', paneDead: false, windowName: 'main' }
    assert.deepStrictEqual(
      getActiveSessions(status, new Map([['%1', pane]])).map(session => session.sessionId),
      [parentId]
    )
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
    const result = sync.run(statusFile, {
      paneDiscovery: false
    })
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
