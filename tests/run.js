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
const { findLatestCodexInterrupt } = require('../scripts/lib/codex-transcript-detector')
const { DEFAULT_TERMINAL_DISPLAY_MS } = require('../scripts/lib/session-registry')
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
    assert.ok(installed.includes('timeout: 600'))
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
    assert.ok(eventBlock.includes('timeout: 600'))

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
    assert.ok(installed.startsWith('model: hermes-3\n\nhooks:\n'))
    assert.ok(installed.includes('--agent'))
    assert.ok(installed.includes('hermes'))
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
    windowName: 'agent'
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
  assert.strictEqual(session.pid, agentPid)
  assert.strictEqual(session.phase, SESSION_PHASES.IDLE)
  assert.strictEqual(session.status, 'idle')
  assert.strictEqual(session.stateSource, 'pane-discovery')
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

test('agent event aliases normalize to persisted event names', () => {
  assert.strictEqual(normalizeAgentEventType('sessionStarted'), AGENT_EVENTS.SESSION_START)
  assert.strictEqual(normalizeAgentEventType('toolUseStarted'), AGENT_EVENTS.TOOL_USE)
  assert.strictEqual(normalizeAgentEventType('subagentStarted'), AGENT_EVENTS.SUBAGENT_START)
  assert.strictEqual(normalizeAgentEventType('sessionDeleted'), AGENT_EVENTS.SESSION_DELETE)
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
  assert.strictEqual(phaseForAgentEvent({ type: AGENT_EVENTS.PROCESS_EXIT_DETECTED }), SESSION_PHASES.INTERRUPTED)
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
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.NOTIFICATION)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook still maps Trae elicitation notifications as answer waits', () => {
  const dir = tempDir()
  try {
    const sessionId = 'trae-elicitation'
    runGenericHook('trae', {
      hook_event_name: 'notification',
      session_id: sessionId,
      cwd: '/tmp/demo',
      notification_type: 'elicitation_dialog',
      message: '请选择一个方案'
    }, dir)

    const session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForAnswer')
    assert.strictEqual(session.needsAttention, 'waiting for answer')
    assert.strictEqual(session.pendingInteraction.type, 'question')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('generic hook classifies text-only notifications and preserves tool and plan intent', () => {
  const dir = tempDir()
  try {
    // Permission text that names the tool — the recovered tool must survive.
    const permId = 'gemini-text-perm'
    runGenericHook('gemini', {
      session_id: permId,
      cwd: '/tmp/demo',
      hook_event_name: 'Notification',
      message: 'Gemini needs your permission to use Bash'
    }, dir)
    let session = readScoutStatus(dir).sessions[permId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.pendingInteraction.tool, 'Bash')

    // Plan-approval text must land as a plan wait (W:PLAN), not a bare approval.
    const planId = 'gemini-text-plan'
    runGenericHook('gemini', {
      session_id: planId,
      cwd: '/tmp/demo',
      hook_event_name: 'Notification',
      message: 'Gemini needs your approval for the plan'
    }, dir)
    session = readScoutStatus(dir).sessions[planId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.pendingInteraction.type, 'plan')
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
    assert.strictEqual(session.lastEvent.type, AGENT_EVENTS.PERMISSION_BYPASSED)

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

test('session reducer recovers a stuck interrupted session on genuine new activity', () => {
  const session = { sessionId: 'int-recover', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  applySessionEvent(session, { type: 'interrupted', source: 'transcript', timestamp: 2000 })
  assert.strictEqual(currentPhase(session), 'interrupted')

  // A real tool hook newer than the interrupt proves the agent resumed — recover.
  const recovered = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3000,
    activeTool: 'Bash'
  })
  assert.strictEqual(recovered.applied, true)
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

test('session reducer recovers an idle-sweep completed session on a genuinely new tool', () => {
  const session = { sessionId: 'idle-done-recover', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  // The idle-complete sweep INFERS the turn ended (source 'stale'), not a real Stop.
  applySessionEvent(session, { type: 'turn_complete', source: 'stale', timestamp: 2000, force: true })
  assert.strictEqual(currentPhase(session), 'completed')

  // A genuinely new tool start proves the inference wrong -> reopen (self-heal),
  // so a wrongly idle-completed turn can never stay stuck at DONE.
  const recovered = applySessionEvent(session, { type: 'tool_use', source: 'hook', timestamp: 3000, activeTool: 'Bash' })
  assert.strictEqual(recovered.applied, true)
  assert.strictEqual(currentPhase(session), 'running')
})

test('session reducer keeps completed sticky against later activity (only a new turn reopens)', () => {
  const session = { sessionId: 'done-sticky', agentType: 'claude', startedAt: 1000 }
  applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 1000 })
  applySessionEvent(session, { type: 'stop', source: 'hook', timestamp: 2000 })
  assert.strictEqual(currentPhase(session), 'completed')

  // A stray late tool event must NOT un-finish a normally-completed turn.
  const stray = applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3000,
    activeTool: 'Bash'
  })
  assert.strictEqual(stray.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')

  // A fresh prompt still reopens it.
  const reopened = applySessionEvent(session, { type: 'prompt_submit', source: 'hook', timestamp: 4000 })
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

  assert.strictEqual(currentPhase(session), 'interrupted')
  assert.strictEqual(session.status, 'interrupted')
  assert.strictEqual(session.endedAt, null)
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

  applySessionEvent(session, {
    type: 'tool_use',
    source: 'hook',
    timestamp: 3000,
    pendingToolUse: { tool: 'Bash', details: 'Bash: npm test', timestamp: 3000 },
    activeTool: 'Bash'
  })
  applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 4000,
    pendingToolUse: null,
    preserveActiveTool: true
  })

  assert.strictEqual(currentPhase(session), 'running')
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, 'Bash')
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

test('session reducer defers completion while a pending interaction is visible', () => {
  const session = { sessionId: 's2-deferred', agentType: 'claude', startedAt: 1000 }
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
  assert.strictEqual(session.deferredCompletion.phase, 'completed')
  assert.strictEqual(session.deferredCompletion.type, 'stop')
  assert.strictEqual(session.lastEvent.deferred, true)

  const resolved = applySessionEvent(session, {
    type: 'permission_resolved',
    source: 'hook',
    timestamp: 2000,
    details: 'approved'
  })

  assert.strictEqual(resolved.applied, true)
  assert.strictEqual(currentPhase(session), 'completed')
  assert.strictEqual(session.status, 'completed')
  assert.strictEqual(session.pendingInteraction, null)
  assert.strictEqual(session.pendingToolUse, null)
  assert.strictEqual(session.activeTool, null)
  assert.strictEqual(session.deferredCompletion, null)
  assert.strictEqual(session.terminalKind, 'completed')
  assert.strictEqual(session.terminalReason, 'turn completed')
  assert.strictEqual(session.lastEvent.type, 'stop')
  assert.strictEqual(session.lastEvent.resolvedBy, 'permission_resolved')

  const lateTool = applySessionEvent(session, {
    type: 'post_tool_use',
    source: 'hook',
    timestamp: 2100,
    force: true
  })
  assert.strictEqual(lateTool.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')
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
    type: 'stop',
    source: 'hook',
    timestamp: 1500,
    reason: 'turn completed'
  })

  assert.strictEqual(currentPhase(session), 'waitingForApproval')
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

test('session reducer lets interrupted deferred completion win over completed', () => {
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
  assert.strictEqual(session.deferredCompletion.phase, 'interrupted')

  applySessionEvent(session, {
    type: 'question_answered',
    source: 'hook',
    timestamp: 2000
  })
  assert.strictEqual(currentPhase(session), 'interrupted')
  assert.strictEqual(session.status, 'interrupted')
  assert.strictEqual(session.terminalKind, 'interrupted')
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
    assert.strictEqual(currentPhase(third.status.sessions[sessionId]), 'interrupted')
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
    //   idleComplete completes `idleClaude`, the interrupt sweep interrupts
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
    assert.strictEqual(currentPhase(persisted.sessions.interruptedClaude), 'interrupted')
    assert.strictEqual(currentPhase(result.status.sessions.idleClaude), 'completed')
    assert.strictEqual(currentPhase(result.status.sessions.interruptedClaude), 'interrupted')
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

test('sync completes idle running sessions past the threshold (missed-stop safety net)', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()

    // Positive evidence the turn ended: a transcript that has been stale as long
    // as the session has been silent.
    const staleTranscript = path.join(dir, 'stale.jsonl')
    fs.writeFileSync(staleTranscript, JSON.stringify({ type: 'assistant' }) + '\n')
    const staleTime = new Date(now - 300000)
    fs.utimesSync(staleTranscript, staleTime, staleTime)

    // No transcript => no evidence => must NOT be completed (could be thinking).
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
        noTranscript: {
          sessionId: 'noTranscript',
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
          agentType: 'codex',
          status: 'working',
          phase: 'running',
          startedAt: now - 600000,
          lastUpdated: now - 300000,
          lastHookAt: now - 300000,
          activeTool: 'Bash'
        }
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000
    })

    // Silent past the threshold WITH a stale transcript => the turn ended
    // without a Stop hook; complete it (DONE, not interrupted).
    const stuck = result.status.sessions.stuckRunning
    assert.strictEqual(currentPhase(stuck), 'completed')
    assert.strictEqual(stuck.status, 'completed')
    assert.strictEqual(stuck.endedAt, null, 'completed reopens on a new turn, so endedAt stays null')
    assert.strictEqual(result.stats.claudeTranscript.idleInterrupted, 1)

    // No transcript => we have no evidence the turn ended => leave it running.
    assert.strictEqual(currentPhase(result.status.sessions.noTranscript), 'running')

    // A session still holding an active tool is genuinely busy — never sweep it.
    const busy = result.status.sessions.busyWithTool
    assert.strictEqual(currentPhase(busy), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('notification intent classifier maps agent notifications to wait/idle intents', () => {
  const { classifyNotification } = require('../scripts/lib/notification-intent')
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }).intent, 'permission')
  assert.strictEqual(classifyNotification({ message: 'Claude needs your permission to use Bash' }).tool, 'Bash')
  assert.strictEqual(classifyNotification({ message: 'Claude Code needs your approval for the plan' }).intent, 'plan')
  assert.strictEqual(classifyNotification({ message: 'Claude has a question for you' }).intent, 'question')
  assert.strictEqual(classifyNotification({ message: 'Claude is waiting for your input' }).intent, 'idle')
  assert.strictEqual(classifyNotification({ message: 'Permission prompt shown' }).intent, 'info')
  assert.strictEqual(classifyNotification({ message: '请授权执行该命令' }).intent, 'permission')
  assert.strictEqual(classifyNotification({ notification_type: 'idle_prompt', message: 'x' }).intent, 'idle')
  assert.strictEqual(classifyNotification({ notification_type: 'elicitation_dialog', message: '请选择' }).intent, 'question')
  assert.strictEqual(classifyNotification({ notification_type: 'ToolPermission', details: { type: 'ask_user' } }).intent, 'question')
  assert.strictEqual(classifyNotification({ notification_type: 'permission_prompt' }).intent, 'permission')
})

test('sync resolves a stale wait once the transcript advances (missed-resolve backstop)', () => {
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
    const resolved = result.status.sessions.stuckWait
    assert.strictEqual(currentPhase(resolved), 'running')
    assert.strictEqual(resolved.needsAttention, null)
    assert.strictEqual(resolved.pendingInteraction, null)
    assert.strictEqual(result.stats.claudeTranscript.waitResolved, 1)
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
    assert.strictEqual(result.stats.claudeTranscript.waitResolved, 0)
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

test('codex sync marks stale active-tool sessions interrupted when no stop hook arrives', () => {
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
    assert.strictEqual(currentPhase(updated), 'interrupted')
    assert.strictEqual(updated.status, 'interrupted')
    assert.strictEqual(updated.terminalKind, 'interrupted')
    assert.strictEqual(result.stats.codex.idleInterrupted, 1)
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('codex stuck sweep skips in-flight tools with pending tool state', () => {
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
    assert.strictEqual(currentPhase(updated), 'running')
    assert.strictEqual(updated.status, 'working')
    assert.strictEqual(updated.pendingToolUse.tool, 'Bash')
    assert.strictEqual(result.stats.codex.idleInterrupted, 0)
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
      assert.strictEqual(currentPhase(updated), testCase.phase)
      assert.strictEqual(updated.deferredCompletion.phase, 'interrupted')
      assert.strictEqual(updated.lastEvent.turnId, testCase.turnId)
      assert.strictEqual(updated.stateEvidence[0].rawEventName, 'turn_aborted')

      applySessionEvent(updated, {
        type: testCase.phase === 'waitingForAnswer' ? 'question_answered' : 'permission_resolved',
        source: 'hook',
        timestamp: now
      })
      assert.strictEqual(currentPhase(updated), 'interrupted')
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
    fs.appendFileSync(transcriptPath, '{"type":"user","timestamp":"' + new Date(now + 1000).toISOString() + '","message":{"content":[{"type":"text","text":"[Request interrupted')
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

test('claude hook defers Stop while approval wait is still pending', () => {
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
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.status, 'working')
    assert.strictEqual(session.pendingInteraction.type, 'approval')
    assert.strictEqual(session.deferredCompletion.phase, 'completed')
    assert.strictEqual(session.lastEvent.deferred, true)

    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' }
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.status, 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.pendingToolUse, null)
    assert.strictEqual(session.activeTool, null)
    assert.strictEqual(session.lastEvent.type, 'stop')
    assert.strictEqual(session.lastEvent.resolvedBy, 'permission_resolved')
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

test('claude hook resolves a notification approval wait when a subagent starts', () => {
  const dir = tempDir()
  try {
    const sessionId = 'claude-notif-subagent'
    const base = { session_id: sessionId, cwd: '/tmp/demo' }
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'plan and build'
    }), dir)
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission'
    }), dir)
    let session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'waitingForApproval')

    // Approving in the terminal produces no resolve hook — the next hook is the
    // subagent launch. That must un-stick the wait back to running.
    runHook('scripts/hooks/claude.js', Object.assign({}, base, {
      hook_event_name: 'SubagentStart',
      sub_agent: { id: 'sa1', type: 'Plan' }
    }), dir)
    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'running')
    assert.strictEqual(session.needsAttention, null)
    assert.strictEqual(session.pendingInteraction, null)
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

test('codex hook defers Stop while approval wait is still pending', () => {
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
    assert.strictEqual(currentPhase(session), 'waitingForApproval')
    assert.strictEqual(session.deferredCompletion.phase, 'completed')

    runHook('scripts/hooks/codex.js', Object.assign({}, base, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash'
    }), dir)

    session = readScoutStatus(dir).sessions[sessionId]
    assert.strictEqual(currentPhase(session), 'completed')
    assert.strictEqual(session.pendingInteraction, null)
    assert.strictEqual(session.lastEvent.type, 'stop')
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

test('codex hook preserves active tool after PostToolUse for stuck-turn fallback', () => {
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
    assert.strictEqual(session.activeTool, 'Bash')
    assert.strictEqual(session.preserveActiveTool, undefined)
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
