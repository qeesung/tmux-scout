#!/usr/bin/env node

const assert = require('assert')
const { execFileSync, spawn } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const TOML = require('../scripts/vendor/iarna-toml/toml')

// Nothing here may read or change the tmux server the tests happen to run
// under. Several scripts read tmux options — @scout-state-source among them —
// and a developer running in jev mode turned hook-install tests into no-ops.
// An empty socket directory means "no server", which is what every test
// expects unless it puts a fake tmux on PATH itself.
const TMUX_ISOLATION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-scout-test-'))
process.env.TMUX_TMPDIR = TMUX_ISOLATION_DIR
delete process.env.TMUX
process.on('exit', () => fs.rmSync(TMUX_ISOLATION_DIR, { recursive: true, force: true }))

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
  SESSION_PHASE_VALUES,
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
const { normalizePaneText, paneFingerprint } = require('../scripts/lib/pane-capture')
const { loadPaneFixtures } = require('../scripts/lib/pane-fixtures')
const { answerCacheKey, createAnswerCache } = require('../scripts/lib/pane-answer-cache')
const { readShadow } = require('../scripts/lib/pane-store')
const { createPaneMetrics, readMetrics } = require('../scripts/lib/pane-metrics')
const { extractPromptAndTitle, extractToolLine } = require('../scripts/lib/pane-text-extract')
const {
  interpretPaneAnswers,
  paneEventsFromInterpretation
} = require('../scripts/lib/pane-classifier')
const { createPaneObserver } = require('../scripts/lib/pane-observer')
const { PANE_QUESTION_SET_VERSION } = require('../scripts/lib/pane-questions')
const { createJevClient } = require('../scripts/lib/jev-client')
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

// Every temp dir this run creates, removed again when it ends. Most tests
// remove their own, but sync keeps the last status file it was pointed at in
// module state, and a later test writing through it recreates a removed one.
const createdTempDirs = []
process.on('exit', () => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-scout-test-'))
  createdTempDirs.push(dir)
  return dir
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

test('normalizePaneText strips animation but keeps the state signal', () => {
  const codex = [
    '─ Worked for 3m 37s ──────────────────────────────',
    '⠁   ⠈      ⠄        ⢀       ⠐',
    '»⠁Ask Codex to do anything      ⠈',
    '  model · repo · master · Ready · Context 100% left'
  ].join('\n')
  const text = normalizePaneText(codex)

  // The decision-bearing words survive.
  assert.ok(text.includes('Ask Codex to do anything'))
  assert.ok(text.includes('Ready'))
  assert.ok(text.includes('Worked for'))
  // The frame-variable parts do not.
  assert.ok(!/[⠀-⣿]/.test(text), 'braille particles should be stripped')
  assert.ok(text.includes('<dur>'), 'elapsed time should be a placeholder')
  assert.ok(text.includes('<pct>'), 'context percentage should be a placeholder')
  assert.ok(!text.includes('3m 37s'))
  // Blank and padding-only lines are dropped.
  assert.ok(!text.split('\n').some(line => line !== line.trim()))
})

test('normalizePaneText collapses a stripped particle to the same spacing', () => {
  // The particle lands inside the placeholder text, so removing it would leave
  // "»Ask" where an unanimated frame has "» Ask".
  assert.strictEqual(
    normalizePaneText('»⠁Ask Codex to do anything'),
    normalizePaneText('» Ask Codex to do anything')
  )
})

test('normalizePaneText keeps markdown bullets and table borders intact', () => {
  const text = normalizePaneText(['- first item', '| col | col |'].join('\n'))
  assert.ok(text.includes('- first item'), 'ASCII bullets must not be read as spinners')
  assert.ok(text.includes('| col | col |'))
})

test('pane fixtures with a second frame produce a stable fingerprint', () => {
  const fixtures = loadPaneFixtures()
  assert.ok(fixtures.length >= 5, 'expected pane fixtures to be present')

  let compared = 0
  for (const fixture of fixtures) {
    if (!fixture.frame2) continue
    compared++
    const a = paneFingerprint(normalizePaneText(fixture.text))
    const b = paneFingerprint(normalizePaneText(fixture.frame2))
    // This is the assertion the cost model rests on: an unchanged screen must
    // not look changed, or every tick pays to re-classify a static session.
    assert.strictEqual(a, b, `${fixture.id}: fingerprint flapped between frames`)
  }
  assert.ok(compared >= 2, 'expected at least two multi-frame fixtures')
})

test('pane fixtures declare an agent and an expected classification', () => {
  for (const fixture of loadPaneFixtures()) {
    assert.ok(fixture.agent, `${fixture.id}: missing agent`)
    assert.ok(fixture.expect.choice, `${fixture.id}: missing expect.choice`)
    assert.ok(
      // null is a legitimate expectation: a shell prompt is a reading the
      // classifier deliberately declines to turn into a phase.
      fixture.expect.phase === null || SESSION_PHASE_VALUES.includes(fixture.expect.phase),
      `${fixture.id}: expect.phase must be a canonical phase or null`
    )
    assert.ok(normalizePaneText(fixture.text).length > 0, `${fixture.id}: empty after normalization`)
  }
})

test('normalizePaneText materially shrinks a padded TUI pane', () => {
  const fixture = loadPaneFixtures().find(item => item.id.endsWith('codex/idle'))
  assert.ok(fixture, 'codex/idle fixture missing')
  const ratio = normalizePaneText(fixture.text).length / fixture.text.length
  assert.ok(ratio < 0.8, `expected normalization to shrink the pane, got ratio ${ratio.toFixed(2)}`)
})

function sampleAnswers(choice = 'idle_ready') {
  return { screen_state: { type: 'choice', choice, confidence: 0.9 } }
}

test('answerCacheKey separates agents, question sets and screens', () => {
  const base = answerCacheKey('claude', 1, 'abc123')
  assert.notStrictEqual(base, answerCacheKey('codex', 1, 'abc123'))
  assert.notStrictEqual(base, answerCacheKey('claude', 2, 'abc123'))
  assert.notStrictEqual(base, answerCacheKey('claude', 1, 'def456'))
  assert.strictEqual(answerCacheKey('claude', 1, ''), null)
  assert.strictEqual(answerCacheKey('', 1, 'abc123'), null)
})

test('answer cache returns the same screen without a second lookup miss', () => {
  const cache = createAnswerCache()
  const key = answerCacheKey('claude', 1, 'abc123')

  assert.strictEqual(cache.get(key), null)
  cache.set(key, { answers: sampleAnswers(), usage: { input_tokens: 1700 } })

  const hit = cache.get(key)
  assert.ok(hit)
  assert.strictEqual(hit.answers.screen_state.choice, 'idle_ready')
  assert.strictEqual(cache.stats().hits, 1)
  assert.strictEqual(cache.stats().misses, 1)
})

test('answer cache misses when the question set version changes', () => {
  const cache = createAnswerCache()
  cache.set(answerCacheKey('claude', 1, 'abc123'), { answers: sampleAnswers() })
  // Rewording criteria invalidates every stored answer, and the confidence
  // scale shifts with the label count, so v2 must not read v1's answers.
  assert.strictEqual(cache.get(answerCacheKey('claude', 2, 'abc123')), null)
})

test('answer cache evicts least recently used entries', () => {
  const cache = createAnswerCache({ maxEntries: 2 })
  const a = answerCacheKey('claude', 1, 'a')
  const b = answerCacheKey('claude', 1, 'b')
  const c = answerCacheKey('claude', 1, 'c')

  cache.set(a, { answers: sampleAnswers() })
  cache.set(b, { answers: sampleAnswers() })
  cache.get(a)                                  // a is now the most recent
  cache.set(c, { answers: sampleAnswers() })    // evicts b, not a

  assert.ok(cache.get(a), 'recently read entry should survive')
  assert.strictEqual(cache.get(b), null, 'least recently used entry should be evicted')
  assert.ok(cache.get(c))
  assert.strictEqual(cache.size, 2)
  assert.strictEqual(cache.stats().evicted, 1)
})

test('answer cache expires entries past the ttl', () => {
  let clock = 1000
  const cache = createAnswerCache({ ttlMs: 500, now: () => clock })
  const key = answerCacheKey('claude', 1, 'abc123')

  cache.set(key, { answers: sampleAnswers() })
  clock += 499
  assert.ok(cache.get(key), 'entry should still be live inside the ttl')
  clock += 2
  assert.strictEqual(cache.get(key), null)
  assert.strictEqual(cache.stats().expired, 1)
})

test('answer cache stores low-confidence answers but never failures', () => {
  const cache = createAnswerCache()
  const lowConfidence = answerCacheKey('claude', 1, 'low')
  const failed = answerCacheKey('claude', 1, 'failed')

  // Re-asking about identical pixels yields the same low confidence, so paying
  // twice buys nothing. Gating happens at interpretation time, not here.
  assert.strictEqual(cache.set(lowConfidence, { answers: { screen_state: { type: 'choice', choice: 'unknown', confidence: 0.1 } } }), true)
  assert.ok(cache.get(lowConfidence))

  // A timeout or a 429 says nothing about the screen; it must stay retryable.
  assert.strictEqual(cache.set(failed, { ok: false, errorKind: 'timeout' }), false)
  assert.strictEqual(cache.get(failed), null)
})

test('answer cache warm-starts from entries persisted by pane-store', () => {
  let clock = 10000
  const cache = createAnswerCache({ ttlMs: 5000, now: () => clock })
  const key = answerCacheKey('claude', 1, 'abc123')

  assert.strictEqual(cache.seed({ [key]: { answers: sampleAnswers('working'), at: clock - 1000 } }), 1)
  const hit = cache.get(key)
  assert.ok(hit, 'seeded entry should be readable after a watcher restart')
  assert.strictEqual(hit.answers.screen_state.choice, 'working')
  assert.strictEqual(cache.stats().seeded, 1)

  assert.strictEqual(cache.seed({ [key]: { answers: sampleAnswers(), at: clock } }), 0, 'seeding twice should be a no-op')
})

test('answer cache refuses to warm-start from an entry older than the ttl', () => {
  let clock = 10000
  const cache = createAnswerCache({ ttlMs: 5000, now: () => clock })
  const key = answerCacheKey('claude', 1, 'abc123')
  assert.strictEqual(cache.seed({ [key]: { answers: sampleAnswers(), at: clock - 9000 } }), 0)
  assert.strictEqual(cache.seed({ [key]: { at: clock } }), 0, 'an entry without answers is not seedable')
  assert.strictEqual(cache.seed(null), 0)
})

// The cache is keyed by screen content, not by session, so what pane-store
// hands back on a restart is exactly what snapshot() wrote out.
test('answer cache round-trips through a snapshot', () => {
  const cache = createAnswerCache()
  const key = answerCacheKey('codex', 2, 'ff00ff')
  cache.set(key, { answers: sampleAnswers('awaiting_approval'), model: 'jev-1.13.0' })

  const restored = createAnswerCache()
  assert.strictEqual(restored.seed(cache.snapshot()), 1)
  assert.strictEqual(restored.get(key).answers.screen_state.choice, 'awaiting_approval')
})

// Shape taken from a live Claude pane: the submitted prompt is echoed at
// column zero with the same glyph the composer uses, and the empty composer
// sits between two horizontal rules near the bottom.
const CLAUDE_PANE = [
  '❯ summarize what changed this week',
  '',
  '  I looked through the diff and found three themes.',
  '',
  '✻ Worked for 3m 27s · done 10:36 AM                     Jump to bottom',
  '',
  '──────────────────────────────────────────────────────────────────────',
  '❯                                                                     ',
  '──────────────────────────────────────────────────────────────────────',
  '  󰉋 repos/example  Opus 5 (1M context) ctx:90%',
  '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)'
].join('\n')

test('extractPromptAndTitle reads the submitted prompt, not the empty composer', () => {
  const result = extractPromptAndTitle(CLAUDE_PANE, 'claude')
  assert.strictEqual(result.confidence, 'exact')
  assert.strictEqual(result.lastUserPrompt, 'summarize what changed this week')
  assert.strictEqual(result.sessionTitle, 'summarize what changed this week')
})

test('extractPromptAndTitle ignores text the user is still typing', () => {
  // The composer and a submitted prompt render identically, so an unsubmitted
  // draft must not become the session title.
  const typing = CLAUDE_PANE.replace('❯                    ', '❯ half-written thou')
  assert.strictEqual(extractPromptAndTitle(typing, 'claude').lastUserPrompt, 'summarize what changed this week')
})

test('extractPromptAndTitle ignores a greyed placeholder composer', () => {
  const codex = [
    '» an earlier real instruction',
    '  ... agent output ...',
    '─ Worked for 5m 14s ──────────────────────────────',
    '» Ask Codex to do anything',
    '  model · repo · master · Ready · Context 54% left'
  ].join('\n')
  assert.strictEqual(extractPromptAndTitle(codex, 'codex').lastUserPrompt, 'an earlier real instruction')
})

test('extractPromptAndTitle ignores quoted output that is not at column zero', () => {
  const quoted = [
    '  The docs say:',
    '    > this is quoted output, not a prompt',
    '──────────────────────────────────',
    '❯ ',
    '──────────────────────────────────'
  ].join('\n')
  assert.strictEqual(extractPromptAndTitle(quoted, 'claude').confidence, 'none')
})

test('extractPromptAndTitle reports none rather than guessing', () => {
  // Claude draws on the alternate screen, so once output pushes the echo off
  // the top there is nothing left to read. Callers must fall back, and because
  // the field comes back undefined the reducer keeps any earlier value.
  const scrolled = ['  output only', '────────────', '❯ ', '────────────'].join('\n')
  const result = extractPromptAndTitle(scrolled, 'claude')
  assert.strictEqual(result.confidence, 'none')
  assert.strictEqual(result.lastUserPrompt, undefined)
  assert.strictEqual(result.sessionTitle, undefined)
  assert.strictEqual(extractPromptAndTitle('', 'claude').confidence, 'none')
})

test('extractPromptAndTitle truncates a long title but keeps the full prompt', () => {
  const long = 'x'.repeat(250)
  const pane = [`❯ ${long}`, '──────', '❯ ', '──────'].join('\n')
  const result = extractPromptAndTitle(pane, 'claude')
  assert.strictEqual(result.lastUserPrompt.length, 250)
  assert.strictEqual(result.sessionTitle.length, 100)
})

test('extractToolLine reads the most recent codex tool invocation', () => {
  const pane = ['    Read bootstrap-prod.yml', '    Search TTPProxyToken', '  done'].join('\n')
  assert.deepStrictEqual(extractToolLine(pane, 'codex'), {
    tool: 'Search',
    details: 'Search: TTPProxyToken'
  })
  assert.deepStrictEqual(extractToolLine('  nothing here', 'codex'), {})
})

function paneAnswers(overrides = {}) {
  const base = {
    screen_state: { type: 'choice', choice: 'working', confidence: 0.9 },
    blocked_on_user: { type: 'noul', noul: 0.02 },
    is_running: { type: 'noul', noul: 0.95 },
    interrupt_marker_visible: { type: 'noul', noul: 0.01 },
    active_tool: { type: 'choice', choice: 'none', confidence: 0.9 }
  }
  const answers = Object.assign({}, base)
  for (const [key, value] of Object.entries(overrides)) {
    answers[key] = Object.assign({}, base[key], value)
  }
  return answers
}

test('interpretPaneAnswers maps each verdict onto its phase', () => {
  const cases = [
    ['awaiting_approval', { blocked_on_user: { noul: 0.95 } }, 'waitingForApproval', 'approval'],
    ['awaiting_plan_approval', { blocked_on_user: { noul: 0.95 } }, 'waitingForApproval', 'plan'],
    ['awaiting_answer', { blocked_on_user: { noul: 0.95 } }, 'waitingForAnswer', 'question'],
    ['working', {}, 'running', null],
    ['idle_ready', { is_running: { noul: 0.02 } }, 'completed', null]
  ]
  for (const [choice, overrides, phase, interactionType] of cases) {
    const result = interpretPaneAnswers(
      paneAnswers(Object.assign({ screen_state: { choice } }, overrides)),
      { currentPhase: 'running' }
    )
    assert.strictEqual(result.gate, 'accept', `${choice} should be accepted`)
    assert.strictEqual(result.phase, phase, `${choice} should map to ${phase}`)
    assert.strictEqual(result.interactionType, interactionType)
  }
})

test('interpretPaneAnswers stays silent on a shell prompt', () => {
  // Process liveness owns "the agent is gone"; leftover pixels do not.
  const result = interpretPaneAnswers(
    paneAnswers({ screen_state: { choice: 'shell_prompt' } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(result.gate, 'accept')
  assert.strictEqual(result.phase, null)
})

test('interpretPaneAnswers rejects low confidence and unreadable screens', () => {
  const lowConfidence = interpretPaneAnswers(
    paneAnswers({ screen_state: { choice: 'awaiting_approval', confidence: 0.3 } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(lowConfidence.gate, 'reject')
  assert.strictEqual(lowConfidence.phase, null)

  const unknown = interpretPaneAnswers(paneAnswers({ screen_state: { choice: 'unknown' } }), {})
  assert.strictEqual(unknown.gate, 'reject')

  const missing = interpretPaneAnswers({}, {})
  assert.strictEqual(missing.gate, 'reject')
})

test('interpretPaneAnswers rejects a wait its cross-check contradicts', () => {
  // Inventing a WAIT asks the user for attention they do not owe.
  const result = interpretPaneAnswers(
    paneAnswers({ screen_state: { choice: 'awaiting_approval' }, blocked_on_user: { noul: 0.05 } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(result.gate, 'reject')
  assert.ok(/blocked_on_user disagrees/.test(result.blockedReason))
})

test('interpretPaneAnswers separates a cancelled turn from a finished one', () => {
  const result = interpretPaneAnswers(
    paneAnswers({
      screen_state: { choice: 'idle_ready' },
      is_running: { noul: 0.02 },
      interrupt_marker_visible: { noul: 0.92 }
    }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(result.phase, 'interrupted')
})

test('interpretPaneAnswers withholds an activeTool it cannot vouch for', () => {
  const trusted = interpretPaneAnswers(
    paneAnswers({ active_tool: { choice: 'shell', confidence: 0.8 } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(trusted.activeTool, 'shell')

  // Still running, but nothing visibly executing: claiming a tool would change
  // what the Claude idle sweep does, not just what the picker shows.
  const unsure = interpretPaneAnswers(
    paneAnswers({ active_tool: { choice: 'shell', confidence: 0.8 }, is_running: { noul: 0.05 } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(unsure.phase, 'running')
  assert.strictEqual(unsure.activeTool, null)

  const lowConfidenceTool = interpretPaneAnswers(
    paneAnswers({ active_tool: { choice: 'shell', confidence: 0.2 } }),
    { currentPhase: 'running' }
  )
  assert.strictEqual(lowConfidenceTool.activeTool, null)
})

test('interpretPaneAnswers leaves a WAIT only on sufficient evidence', () => {
  const working = confidence => paneAnswers({ screen_state: { choice: 'working', confidence } })
  const wait = { currentPhase: 'waitingForApproval' }
  const with_ = extra => Object.assign({}, wait, extra)

  assert.strictEqual(interpretPaneAnswers(working(0.9), with_({ exitStreak: 1 })).resolvesWait, false,
    'a single reading is not enough to conclude the user acted')
  assert.strictEqual(interpretPaneAnswers(working(0.9), with_({ exitStreak: 2 })).resolvesWait, true)

  // Below the strict bar, a streak is worth nothing — only duration is.
  assert.strictEqual(interpretPaneAnswers(working(0.6), with_({ exitStreak: 9 })).resolvesWait, false)
  assert.strictEqual(interpretPaneAnswers(working(0.6), with_({ exitSustainedMs: 9999 })).resolvesWait, false)
  assert.strictEqual(interpretPaneAnswers(working(0.6), with_({ exitSustainedMs: 10000 })).resolvesWait, true)

  const blocked = paneAnswers({ screen_state: { choice: 'working', confidence: 0.95 }, blocked_on_user: { noul: 0.8 } })
  assert.strictEqual(interpretPaneAnswers(blocked, with_({ exitStreak: 5, exitSustainedMs: 60000 })).exitGrade, null,
    'a cross-check that still sees a block grades nothing')
  assert.strictEqual(interpretPaneAnswers(blocked, with_({ exitStreak: 5, exitSustainedMs: 60000 })).resolvesWait, false)

  assert.strictEqual(interpretPaneAnswers(working(0.95), { currentPhase: 'running', exitStreak: 5 }).resolvesWait, false,
    'there is nothing to resolve outside a wait')
})
// The screen said X; the session holds Y. These are the events that carry the
// first into the second. No new event type exists for this — the classifier is
// restricted to the vocabulary hooks already speak, which is what lets the
// reducer stay completely unchanged.
function paneEvents(verdictAnswers, session, extras = {}) {
  const interp = interpretPaneAnswers(
    verdictAnswers,
    Object.assign({ currentPhase: currentPhase(session) }, extras.context)
  )
  return paneEventsFromInterpretation(interp, Object.assign({ session, now: 1000 }, extras.options))
}

// A wait verdict is refused unless the independent blocked_on_user question
// agrees, so asking for one here has to move both.
const WAIT_VERDICTS = new Set(['awaiting_approval', 'awaiting_plan_approval', 'awaiting_answer'])

function confidently(choice, overrides = {}) {
  const base = { screen_state: { choice, confidence: 0.95 } }
  if (WAIT_VERDICTS.has(choice)) base.blocked_on_user = { noul: 0.95 }
  return paneAnswers(Object.assign(base, overrides))
}

// Evidence that clears the strict bar for leaving a wait: this reading and the
// one before it both graded strict. The verdict argument documents which
// reading is meant.
const LEAVING_WAIT = { context: { exitStreak: 2 } }

function leaving(verdict) {
  void verdict
  return LEAVING_WAIT
}

test('the transition table maps every reading onto events hooks already speak', () => {
  const cases = [
    // from            verdict                   expected event types
    ['running', 'working', []],
    ['idle', 'working', [AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE]],
    ['completed', 'working', [AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE]],
    ['interrupted', 'working', [AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE]],
    ['running', 'awaiting_approval', [AGENT_EVENTS.PERMISSION_REQUEST]],
    ['running', 'awaiting_plan_approval', [AGENT_EVENTS.PERMISSION_REQUEST]],
    ['running', 'awaiting_answer', [AGENT_EVENTS.QUESTION_ASKED]],
    ['running', 'idle_ready', [AGENT_EVENTS.TURN_COMPLETE]],
    ['completed', 'idle_ready', []],
    // WAIT to WAIT needs no resolver: both targets are explicit waits.
    ['waitingForApproval', 'awaiting_answer', [AGENT_EVENTS.QUESTION_ASKED]],
    ['waitingForAnswer', 'awaiting_approval', [AGENT_EVENTS.PERMISSION_REQUEST]],
    // Neither of these is a phase the screen is allowed to assert.
    ['running', 'shell_prompt', []],
    ['running', 'unknown', []]
  ]

  for (const [from, verdict, expected] of cases) {
    const session = { sessionId: 's1', agentType: 'claude', phase: from, status: 'working' }
    const events = paneEvents(confidently(verdict), session, leaving(verdict))
    assert.deepStrictEqual(
      events.map(event => event.type),
      expected,
      `${from} + ${verdict}`
    )
    for (const event of events) assert.strictEqual(event.stateSource, 'pane-model')
  }
})

test('leaving a wait takes a resolver first, then the state it moved to', () => {
  const approval = () => ({
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval' }, stateEvidence: []
  })

  // The resolver alone lands on running, so a working reading needs nothing more.
  assert.deepStrictEqual(
    paneEvents(confidently('working'), approval(), leaving('working')).map(event => event.type),
    [AGENT_EVENTS.PERMISSION_RESOLVED]
  )
  // Completing needs both: the user acted, and the turn then finished.
  assert.deepStrictEqual(
    paneEvents(confidently('idle_ready'), approval(), leaving('idle_ready')).map(event => event.type),
    [AGENT_EVENTS.PERMISSION_RESOLVED, AGENT_EVENTS.TURN_COMPLETE]
  )

  const session = approval()
  for (const event of paneEvents(confidently('idle_ready'), session, leaving('idle_ready'))) {
    applySessionEvent(session, event)
  }
  assert.strictEqual(currentPhase(session), 'completed')
  assert.strictEqual(session.pendingInteraction, null)
})

test('a wait the screen still shows is never released on weak evidence', () => {
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval' }
  }
  // One reading is not a streak.
  assert.deepStrictEqual(paneEvents(confidently('working'), session, { context: { exitStreak: 1 } }), [])
  // Ordinary confidence does not clear the higher bar for leaving a wait.
  assert.deepStrictEqual(
    paneEvents(paneAnswers({ screen_state: { choice: 'working', confidence: 0.6 } }), session, leaving('working')),
    []
  )
  // The cross-check still sees a block.
  assert.deepStrictEqual(
    paneEvents(confidently('working', { blocked_on_user: { noul: 0.8 } }), session, leaving('working')),
    []
  )
})

test('re-reading an unchanged wait emits nothing, and a changed one keeps the clock', () => {
  // Trap: sameWaitRefresh() requires both pendingToolUse and activeTool to be
  // absent from the event. Sending activeTool (even as null) would make every
  // re-read a brand new wait, dropping pendingToolUse and resetting how long
  // the user has been staring at the dialog.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'running', status: 'working', stateEvidence: []
  }
  for (const event of paneEvents(confidently('awaiting_approval'), session)) {
    assert.strictEqual(event.activeTool, undefined, 'a wait event must not carry activeTool')
    assert.strictEqual(event.pendingToolUse, undefined)
    applySessionEvent(session, event)
  }
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  const startedAt = session.pendingInteraction.startedAt

  // The same dialog, still on screen: nothing to say.
  assert.deepStrictEqual(paneEvents(confidently('awaiting_approval'), session), [])

  // The same dialog, but the title finally became readable. The event that
  // carries it must refresh the wait rather than restart it.
  const [refresh] = paneEvents(confidently('awaiting_approval'), session, {
    options: { extracted: { sessionTitle: 'review the migration' } }
  })
  applySessionEvent(session, refresh)
  assert.strictEqual(session.sessionTitle, 'review the migration')
  assert.strictEqual(session.pendingInteraction.startedAt, startedAt, 'the wait clock must not restart')

  // A tool confirmation becoming a plan confirmation is a genuinely different
  // dialog, and it still routes through the permission_request hooks already send.
  const [toPlan] = paneEvents(confidently('awaiting_plan_approval'), session)
  assert.strictEqual(toPlan.type, AGENT_EVENTS.PERMISSION_REQUEST)
  assert.strictEqual(toPlan.attentionReason, 'waiting for plan approval')
  applySessionEvent(session, toPlan)
  assert.strictEqual(session.pendingInteraction.type, 'plan')
  assert.strictEqual(session.needsAttention, 'waiting for plan approval')
})

test('the classifier never sends question_answered outside an answer wait', () => {
  // Trap: the reducer applies question_answered unconditionally from any phase,
  // crashed and stale included, so the phase check has to happen here.
  for (const phase of ['crashed', 'stale', 'completed', 'running', 'waitingForApproval']) {
    const session = { sessionId: 's1', agentType: 'claude', phase, status: phase }
    for (const verdict of ['working', 'idle_ready', 'awaiting_approval', 'shell_prompt']) {
      const types = paneEvents(confidently(verdict), session, leaving(verdict)).map(event => event.type)
      assert.ok(
        !types.includes(AGENT_EVENTS.QUESTION_ANSWERED),
        `${phase} + ${verdict} must not resolve an answer wait`
      )
    }
  }
})

test('a terminal session cannot be revived by the screen', () => {
  // crashed and stale come from PID probing and are revivable only by a hook.
  // The reading is refused outright, and its display updates must not sneak an
  // ended session back to life either — event.updates run before the guards.
  for (const phase of ['crashed', 'stale']) {
    const session = {
      sessionId: 's1', agentType: 'claude', phase, status: phase, endedAt: 500, stateEvidence: []
    }
    for (const event of paneEvents(confidently('working'), session, leaving('working'))) {
      applySessionEvent(session, event)
    }
    assert.strictEqual(currentPhase(session), phase, `${phase} must stay terminal`)
    assert.strictEqual(session.endedAt, 500)
  }
})

test('reopening a finished session drops its stale turn correlation', () => {
  // Trap: prompt_submit is the only member of TURN_START_EVENTS, so it resets
  // currentTurnId/turnStartedAt. assistant_message_update reopens the turn just
  // as well without claiming a new one started.
  const session = {
    sessionId: 's1', agentType: 'codex', phase: 'completed', status: 'completed',
    transcriptPath: '/tmp/codex.jsonl',
    currentTurnId: 'turn-1', lastTurnId: 'turn-1', stateEvidence: []
  }
  const [event] = paneEvents(confidently('working'), session)
  assert.strictEqual(event.type, AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE)
  // Synthesizing one would be worse than leaving it: codexTurnEndForSession()
  // looks lastTurnId up exactly and refuses timestamp fallback, so a made-up id
  // would permanently hide the real turn's task_complete.
  assert.strictEqual(event.turnId, undefined)

  const status = { version: 1, sessions: { s1: session } }
  sync.applyPaneEvents(status, [{ sessionId: 's1', event }], sync.createStats())

  assert.strictEqual(currentPhase(session), 'running')
  // The id belongs to the turn that ENDED. Kept, the Codex transcript sweep
  // finds that turn's task_complete by exact id and completes the turn that
  // just started. Cleared, the lookup degrades to timestamp matching, which
  // cannot match a completion older than this reopen.
  assert.strictEqual(session.lastTurnId, null)
  assert.strictEqual(session.currentTurnId, null)
})

test('a pane refresh within a live turn keeps its correlation', () => {
  // Only a reopen invalidates the id. A session already running still owns its
  // turn, and clearing it there would throw away a correlation that is correct.
  const session = {
    sessionId: 's1', agentType: 'codex', phase: 'running', status: 'working',
    currentTurnId: 'turn-9', lastTurnId: 'turn-9', activeTool: null, stateEvidence: []
  }
  const events = paneEvents(confidently('working', { active_tool: { choice: 'shell', confidence: 0.9 } }), session)
    .map(event => ({ sessionId: 's1', event }))
  assert.strictEqual(events.length, 1, 'a display field moved, so there is something to send')
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, events, sync.createStats())

  assert.strictEqual(session.activeTool, 'shell')
  assert.strictEqual(session.lastTurnId, 'turn-9')
})

test('a reading the guards refuse never clears the ended flag', () => {
  // event.updates land before the guards, which is why nothing is smuggled
  // through them: the correction runs only once the reducer accepted the event.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'stale', status: 'stale', endedAt: 500, stateEvidence: []
  }
  const events = paneEvents(confidently('working'), session, leaving('working'))
    .map(event => ({ sessionId: 's1', event }))
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, events, sync.createStats())

  assert.strictEqual(currentPhase(session), 'stale')
  assert.strictEqual(session.endedAt, 500)
})

test('a classification the gate rejects leaves the placeholder hidden', () => {
  // isVisibleInPicker() hides a pane-discovery shell until something confirms
  // it. Nothing was added there for the pane model: an accepted reading rewrites
  // stateSource to pane-model on its way through setPhase, and a rejected one
  // emits no event at all, so the shell keeps hiding itself.
  const shell = {
    sessionId: 's1', agentType: 'claude', phase: 'running', status: 'working',
    stateSource: 'pane-discovery', tmuxPane: '%1', stateEvidence: []
  }
  const unsure = paneEvents(paneAnswers({ screen_state: { choice: 'working', confidence: 0.3 } }), shell)
  assert.deepStrictEqual(unsure, [])
  assert.strictEqual(shell.stateSource, 'pane-discovery')
  assert.strictEqual(isVisibleInPicker(shell), 'hidden')

  for (const event of paneEvents(confidently('awaiting_approval'), shell)) applySessionEvent(shell, event)
  assert.strictEqual(shell.stateSource, 'pane-model')
  assert.notStrictEqual(isVisibleInPicker(shell), 'hidden')
})

test('a reading that failed to extract a prompt never clears the old one', () => {
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'completed', status: 'completed',
    lastUserPrompt: 'the prompt from an earlier capture'
  }
  const [event] = paneEvents(confidently('working'), session, {
    options: { extracted: { confidence: 'none' } }
  })
  // undefined is skipped by the reducer, so the earlier capture survives. Claude
  // draws on the alternate screen, which makes the echo readable exactly once.
  assert.strictEqual(event.updates.lastUserPrompt, undefined)
  applySessionEvent(session, event)
  assert.strictEqual(session.lastUserPrompt, 'the prompt from an earlier capture')
})

test('pane_state is still phase-neutral', () => {
  const session = { sessionId: 's1', agentType: 'claude', phase: 'completed', status: 'completed' }
  const result = applySessionEvent(session, {
    type: AGENT_EVENTS.PANE_STATE,
    phase: 'running',
    source: 'pane',
    timestamp: Date.now()
  })
  assert.strictEqual(result.applied, false)
  assert.strictEqual(currentPhase(session), 'completed')
})

test('a hook that lands after the screen was read wins over the reading', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, 'status.json')
    const session = {
      sessionId: 'raced',
      agentType: 'claude',
      phase: 'running',
      status: 'working',
      // A prompt hook arrived after the screen was captured: a new turn just
      // started, so the older idle_ready reading must not complete it.
      lastHookAt: 5000,
      stateEvidence: []
    }
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, sessions: { raced: session } }))

    const completion = at => ({
      sessionId: 'raced',
      event: {
        type: AGENT_EVENTS.TURN_COMPLETE,
        source: 'pane-model',
        stateSource: 'pane-model',
        rawEventName: 'pane_idle_ready',
        timestamp: at
      }
    })

    const stats = sync.createStats()
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    sync.applyPaneEvents(status, [completion(4000)], stats)

    assert.strictEqual(currentPhase(status.sessions.raced), 'running')
    assert.strictEqual(stats.paneModel.superseded, 1)
    assert.strictEqual(stats.paneModel.applied, 0)

    // A reading taken after the hook is current evidence and still applies.
    sync.applyPaneEvents(status, [completion(6000)], stats)
    assert.strictEqual(currentPhase(status.sessions.raced), 'completed')
    assert.strictEqual(stats.paneModel.applied, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function paneSyncFixture(sessionOverrides = {}) {
  const dir = tempDir()
  const statusFile = path.join(dir, 'status.json')
  const now = Date.now()
  fs.writeFileSync(statusFile, JSON.stringify({
    version: 1,
    lastUpdated: now,
    sessions: {
      paneSession: Object.assign({
        sessionId: 'paneSession',
        agentType: 'claude',
        status: 'working',
        phase: 'running',
        startedAt: now - 600000,
        lastUpdated: now,
        activeTool: null
      }, sessionOverrides)
    }
  }, null, 2))
  return { dir, statusFile, now }
}

test('sync.run applies queued pane classifications', () => {
  const { dir, statusFile, now } = paneSyncFixture({ phase: 'completed', status: 'completed' })
  try {
    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      paneEvents: [{
        sessionId: 'paneSession',
        event: {
          type: AGENT_EVENTS.PERMISSION_REQUEST,
          source: 'pane-model',
          stateSource: 'pane-model',
          rawEventName: 'pane_awaiting_approval',
          attentionReason: 'waiting for approval',
          timestamp: now
        }
      }]
    })

    assert.strictEqual(currentPhase(result.status.sessions.paneSession), 'waitingForApproval')
    assert.strictEqual(result.stats.paneModel.applied, 1)
    const persisted = JSON.parse(fs.readFileSync(statusFile, 'utf-8'))
    assert.strictEqual(currentPhase(persisted.sessions.paneSession), 'waitingForApproval')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sync.run ignores pane events for sessions it does not know', () => {
  const { dir, statusFile, now } = paneSyncFixture()
  try {
    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      paneEvents: [{
        sessionId: 'ghost',
        event: { type: AGENT_EVENTS.TURN_COMPLETE, source: 'pane-model', timestamp: now }
      }]
    })
    assert.deepStrictEqual(Object.keys(result.status.sessions), ['paneSession'])
    assert.strictEqual(result.stats.paneModel.applied, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a watched frozen screen is not force-completed by the idle sweep', () => {
  // The regression this guards: the classifier only emits when its reading
  // disagrees with the session, so an agent running a long silent command stops
  // producing events. If the sweep measured the persisted observation instead
  // of the live one, it would force-complete exactly the case this feature is
  // meant to keep marked BUSY.
  const { dir, statusFile, now } = paneSyncFixture({ lastUpdated: Date.now() - 300000 })
  try {
    const watched = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000,
      paneObservedAt: new Map([['paneSession', now]])
    })
    assert.strictEqual(currentPhase(watched.status.sessions.paneSession), 'running')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the idle sweep still fires for a session nobody is watching', () => {
  const { dir, statusFile, now } = paneSyncFixture({ lastUpdated: Date.now() - 300000 })
  try {
    const unwatched = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000
    })
    assert.strictEqual(currentPhase(unwatched.status.sessions.paneSession), 'completed')

    // A stale observation must not shield it either.
    const { dir: dir2, statusFile: file2 } = paneSyncFixture({ lastUpdated: Date.now() - 300000 })
    try {
      const stale = sync.run(file2, {
        reconcile: false,
        codexMode: 'none',
        claudeTranscript: false,
        idleCompleteMs: 60000,
        paneObservedAt: new Map([['paneSession', now - 300000]])
      })
      assert.strictEqual(currentPhase(stale.status.sessions.paneSession), 'completed')
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('pane modules load and degrade when the TypeSafe SDK is absent', () => {
  // tmux-scout installs via TPM and nobody runs npm install, so the SDK has to
  // behave like an optional dependency. A top-level require anywhere in the
  // pane pipeline would crash every existing user; this test is the guard.
  // Works whether or not the SDK happens to be installed: on a machine without
  // it the absent condition already holds, and on a dev machine we simulate it.
  let sdkPath = null
  try { sdkPath = require.resolve('@typesafe-ai/sdk') } catch (_) {}
  const cached = sdkPath ? require.cache[sdkPath] : null
  if (sdkPath) {
    require.cache[sdkPath] = { get exports() { throw new Error('Cannot find module @typesafe-ai/sdk') } }
  }

  const paneModules = [
    '../scripts/lib/pane-capture',
    '../scripts/lib/pane-fixtures',
    '../scripts/lib/pane-answer-cache',
    '../scripts/lib/pane-text-extract',
    '../scripts/lib/pane-questions',
    '../scripts/lib/pane-classifier',
    '../scripts/lib/pane-observer',
    '../scripts/lib/jev-client'
  ]
  const reloaded = paneModules.map(name => require.resolve(name))
  for (const resolved of reloaded) delete require.cache[resolved]

  try {
    for (const name of paneModules) {
      assert.doesNotThrow(() => require(name), `${name} must load without the SDK`)
    }
    const { createJevClient, MIN_NODE_MAJOR } = require('../scripts/lib/jev-client')
    const client = createJevClient({ apiKey: 'test-key' })
    assert.strictEqual(client.available, false)
    // The runtime-version gate short-circuits ahead of the require, so on the
    // Node 16 and 18 this plugin still supports the reason is the version, not
    // the missing module. Either way the contract is the same: report, never throw.
    const nodeMajor = Number.parseInt(String(process.versions.node).split('.')[0], 10)
    assert.strictEqual(client.reason, nodeMajor < MIN_NODE_MAJOR ? 'node-too-old' : 'no-sdk')
  } finally {
    if (sdkPath) {
      if (cached) require.cache[sdkPath] = cached
      else delete require.cache[sdkPath]
    }
    for (const resolved of reloaded) delete require.cache[resolved]
  }
})

test('jev client reports why it is unavailable instead of throwing', async () => {
  // createJevClient does not go looking for a key — resolveApiKey() is the
  // caller's job — so this stays true on a machine that has one configured.
  const noKey = createJevClient({ apiKey: '', sdk: {} })
  assert.strictEqual(noKey.available, false)
  assert.strictEqual(noKey.reason, 'no-key')
  // Even unavailable, classify resolves rather than rejecting: a watcher tick
  // must never be taken down by an optional feature.
  const result = await noKey.classify({}, {})
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.errorKind, 'no-key')
})

test('jev client turns SDK failures into typed outcomes', async () => {
  const failures = [
    [Object.assign(new Error('timed out'), { constructor: { name: 'APITimeoutError' } }), 'timeout'],
    [Object.assign(new Error('rate limited'), { status: 429 }), 'rate-limited'],
    [Object.assign(new Error('bad key'), { status: 401 }), 'auth']
  ]
  for (const [error, expected] of failures) {
    const client = createJevClient({
      apiKey: 'test-key',
      sdk: { TypeSafeClient: class { async systemOne() { throw error } } }
    })
    assert.strictEqual(client.available, true)
    const result = await client.classify({}, {})
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.errorKind, expected)
  }
})

test('jev client returns answers and usage on success', async () => {
  const client = createJevClient({
    apiKey: 'test-key',
    sdk: {
      TypeSafeClient: class {
        async systemOne() {
          return { answers: { screen_state: { choice: 'working' } }, usage: { input_tokens: 2551 }, model: 'jev-1.13.0' }
        }
      }
    }
  })
  const result = await client.classify({}, {})
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.answers.screen_state.choice, 'working')
  assert.strictEqual(result.usage.input_tokens, 2551)
})

// --- pane observer ---

function observerHarness(overrides = {}) {
  let clock = 1_000_000
  const calls = []
  const screens = new Map()

  const capture = paneId => {
    const text = screens.has(paneId) ? screens.get(paneId) : 'agent line one\nagent line two\nagent line three'
    if (text === null) return null
    return { paneId, raw: text, text, fingerprint: `fp:${text.length}:${text.slice(0, 12)}` }
  }

  const answersByCall = overrides.answers || [sampleAnswers('working')]
  const client = {
    available: true,
    reason: null,
    async classify(state) {
      calls.push(state)
      const next = answersByCall[Math.min(calls.length - 1, answersByCall.length - 1)]
      if (next instanceof Error) return { ok: false, errorKind: next.message }
      return { ok: true, answers: next, usage: { input_tokens: 2551 }, model: 'jev-1.13.0' }
    }
  }

  // Every observer gets its own store files: shadow mode and cache persistence
  // both write to ~/.tmux-scout by default, which is the user's real registry.
  // Removed when the run ends whether or not the test called cleanup().
  const storeDir = overrides.store || fs.mkdtempSync(path.join(os.tmpdir(), 'scout-pane-'))
  if (!overrides.store) createdTempDirs.push(storeDir)
  const observer = createPaneObserver(Object.assign({
    mode: 'on',
    client,
    capture,
    now: () => clock,
    shadowFile: path.join(storeDir, 'pane-agreement.jsonl'),
    cacheFile: path.join(storeDir, 'pane-cache.json'),
    metricsFile: path.join(storeDir, 'pane-metrics.jsonl'),
    observedFile: path.join(storeDir, 'pane-observed.json')
  }, overrides.observer))

  return {
    observer,
    storeDir,
    shadowRows: () => readShadow({ file: path.join(storeDir, 'pane-agreement.jsonl') }),
    metricRows: () => readMetrics({ file: path.join(storeDir, 'pane-metrics.jsonl') }),
    cleanup() { fs.rmSync(storeDir, { recursive: true, force: true }) },
    calls,
    screens,
    client,
    now: () => clock,
    advance(ms) { clock += ms },
    // The watcher applies whatever the previous tick produced, then dispatches
    // against the fresh status — the same ordering as runLoop.
    async tick(status, panes = new Map()) {
      const events = observer.drain()
      observer.dispatch(status, panes)
      await new Promise(resolve => setImmediate(resolve))
      return events
    }
  }
}

function paneStatus(session = {}) {
  return {
    sessions: {
      s1: Object.assign({
        sessionId: 's1',
        agentType: 'claude',
        tmuxPane: '%1',
        phase: 'running',
        status: 'working',
        stateEvidence: []
      }, session)
    }
  }
}

test('the agent allowlist survives being normalized twice', async () => {
  // watcher.js normalizes the tmux option before handing it over, and
  // createPaneObserver normalizes whatever it gets. Stringifying a Set yields
  // "[object Set]", so a non-idempotent normalizer silently empties the
  // allowlist and every enabled mode makes zero calls.
  const { toAgentSet } = require('../scripts/lib/pane-observer')
  const once = toAgentSet('claude,codex,gemini')
  assert.deepStrictEqual([...toAgentSet(once)], ['claude', 'codex', 'gemini'])

  const h = observerHarness({ observer: { agents: toAgentSet('claude,codex,gemini') } })
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1, 'a pre-normalized allowlist must still match')
})

test('pane observer only stands the timeout sweeps down for a reading it trusts', async () => {
  // A rejected reading yields no conclusion, so it must not disable the
  // fallbacks. Cached rejected answers would otherwise refresh this every tick
  // and leave a session that really did stall marked BUSY forever.
  const unusable = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'unknown', confidence: 0.99 }
  }] })
  await unusable.tick(paneStatus())
  await unusable.tick(paneStatus())
  assert.strictEqual(unusable.observer.observedAt().size, 0)

  const lowConfidence = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'idle_ready', confidence: 0.3 }
  }] })
  await lowConfidence.tick(paneStatus())
  await lowConfidence.tick(paneStatus())
  assert.strictEqual(lowConfidence.observer.observedAt().size, 0)

  // An accepted reading that merely agrees with the session still counts: that
  // is the frozen-screen case the fallbacks exist to not misjudge.
  const trusted = observerHarness({ answers: [sampleAnswers('working')] })
  await trusted.tick(paneStatus())
  await trusted.tick(paneStatus())
  assert.strictEqual(trusted.observer.observedAt().size, 1)
})

test('pane observer stays completely inert while switched off', async () => {
  const h = observerHarness({ observer: { mode: 'off' } })
  const status = paneStatus()

  await h.tick(status)
  await h.tick(status)

  assert.strictEqual(h.calls.length, 0)
  assert.strictEqual(h.observer.drain().length, 0)
  assert.strictEqual(h.observer.observedAt().size, 0)
})

test('pane observer answers a repeated screen from cache without calling the model', async () => {
  const h = observerHarness({ answers: [sampleAnswers('idle_ready')] })
  const status = paneStatus()

  await h.tick(status)
  assert.strictEqual(h.calls.length, 1)

  // Same screen on every later tick. Cache hits deliberately ignore the
  // interval, so the reading keeps arriving without ever paying again.
  for (let i = 0; i < 5; i++) {
    h.advance(10_000)
    await h.tick(status)
  }
  assert.strictEqual(h.calls.length, 1, 'an unchanged screen must never be re-asked')
  assert.strictEqual(h.observer.stats().cacheHits, 5)
})

test('pane observer throttles a screen that keeps changing', async () => {
  const h = observerHarness({ answers: [sampleAnswers('working')] })
  const status = paneStatus()

  for (let i = 0; i < 4; i++) {
    h.screens.set('%1', `line a\nline b\nchanging content ${'x'.repeat(i)}`)
    h.advance(2000)
    await h.tick(status)
  }

  // Four distinct screens across 8s, with a 6s floor between calls.
  assert.ok(h.calls.length <= 2, `expected throttling, got ${h.calls.length} calls`)
  assert.ok(h.observer.stats().throttled > 0)
})

test('pane observer backs off a session after an error and never caches the failure', async () => {
  const h = observerHarness({ answers: [new Error('timeout'), sampleAnswers('working')] })
  const status = paneStatus()

  await h.tick(status)
  assert.strictEqual(h.calls.length, 1)
  assert.strictEqual(h.observer.stats().errors, 1)

  // Same screen, but the failure was not cached — the retry is blocked by the
  // 60s error backoff rather than served a stale answer.
  h.advance(10_000)
  await h.tick(status)
  assert.strictEqual(h.calls.length, 1, 'an errored session must back off')

  h.advance(60_000)
  await h.tick(status)
  assert.strictEqual(h.calls.length, 2, 'the session must retry once the backoff expires')
})

test('pane observer pauses every session on a rate limit, not just the one that hit it', async () => {
  const h = observerHarness({ answers: [new Error('rate-limited'), sampleAnswers('working')] })
  const status = paneStatus()
  status.sessions.s2 = Object.assign({}, status.sessions.s1, { sessionId: 's2', tmuxPane: '%2' })

  await h.tick(status)
  const afterFirst = h.calls.length
  assert.ok(afterFirst >= 1)

  h.advance(10_000)
  await h.tick(status)
  assert.strictEqual(h.calls.length, afterFirst, 'a 429 is an account-wide signal')
})

test('pane observer skips sessions a cheaper or better source already owns', async () => {
  const cases = [
    ['a remote session', { isRemote: true }],
    ['an ended session', { endedAt: Date.now() }],
    ['a crashed session', { phase: 'crashed', status: 'crashed' }],
    ['an agent outside the allowlist', { agentType: 'traex' }],
    ['a session with no pane', { tmuxPane: null }]
  ]
  for (const [label, session] of cases) {
    const h = observerHarness()
    await h.tick(paneStatus(session))
    assert.strictEqual(h.calls.length, 0, `${label} must not be classified`)
  }

  // A recent hook is no longer a reason to skip a pane. The two sources are
  // configured either/or (@scout-state-source), so in jev mode there are no
  // hooks to defer to, and a leftover lastHookAt from before the switch must
  // not put a session permanently out of reach.
  const hooked = observerHarness()
  await hooked.tick(paneStatus({ lastHookAt: hooked.now() - 5000 }))
  assert.strictEqual(hooked.calls.length, 1)
})

test('pane observer refuses to revive a session from the leftovers of its own exit', async () => {
  // The pane still shows the agent UI after the process is gone. Process
  // liveness outranks the screen — without this the model reads the leftover
  // chrome as an idle composer and resurrects a finished session.
  const h = observerHarness()
  await h.tick(paneStatus({ phase: 'interrupted', status: 'interrupted', terminalKind: 'processExit' }))
  assert.strictEqual(h.calls.length, 0)

  // An interrupt the user typed is different: that process is still there.
  const cancelled = observerHarness()
  await cancelled.tick(paneStatus({ phase: 'interrupted', status: 'interrupted', terminalKind: 'userInterrupt' }))
  assert.strictEqual(cancelled.calls.length, 1)
})

test('pane observer classifies one screen once, no matter how many sessions claim the pane', async () => {
  // Resumed turns and re-runs in the same window routinely leave several live
  // records pointing at one pane. A pane shows one screen, so it is evidence
  // about one session; classifying all of them would apply the same verdict
  // repeatedly and put a row per record in the picker.
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'awaiting_approval', confidence: 0.95 },
    blocked_on_user: { type: 'noul', noul: 0.95 }
  }] })
  const status = { sessions: {} }
  for (let i = 0; i < 4; i++) {
    status.sessions[`s${i}`] = {
      sessionId: `s${i}`,
      agentType: 'claude',
      tmuxPane: '%1',
      phase: 'running',
      status: 'working',
      // Newest by when the record was started — the process start time for a
      // discovered session — not by lastUpdated, which the sweeps also write.
      startedAt: 1000 + i,
      stateEvidence: []
    }
  }

  await h.tick(status)
  const events = await h.tick(status)
  assert.strictEqual(h.calls.length, 1)
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].sessionId, 's3', 'the newest record owns the screen')
  assert.strictEqual(h.observer.observedAt().size, 1)
})

test('pane observer ignores a dead pane but not an unreadable tmux', async () => {
  const dead = new Map([['%1', { paneId: '%1', paneDead: true }]])
  dead.tmuxAvailable = true
  const h = observerHarness()
  await h.tick(paneStatus(), dead)
  assert.strictEqual(h.calls.length, 0)

  // tmux failing to answer is not evidence that a pane vanished.
  const unknown = new Map()
  unknown.tmuxAvailable = false
  const blind = observerHarness()
  await blind.tick(paneStatus(), unknown)
  assert.strictEqual(blind.calls.length, 1)
})

test('pane observer lets a frozen screen accumulate the agreement that leaves a WAIT', async () => {
  // The regression this guards: streaks count ticks, not API calls. If a cache
  // hit did not advance the streak, a session whose dialog closed onto a screen
  // already seen could never gather the two agreeing readings that leaving a
  // WAIT requires, and would sit in WAIT forever.
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'working', confidence: 0.95 },
    blocked_on_user: { type: 'noul', noul: 0.02 },
    is_running: { type: 'noul', noul: 0.95 }
  }] })
  const status = paneStatus({ phase: 'waitingForApproval', status: 'waiting' })

  await h.tick(status)
  assert.deepStrictEqual(await h.tick(status), [], 'one reading is not enough')
  assert.strictEqual(h.calls.length, 1)

  h.advance(2000)
  const second = await h.tick(status)
  assert.strictEqual(h.calls.length, 1, 'the second reading came from cache')
  assert.deepStrictEqual(
    second.map(entry => entry.event.type),
    [AGENT_EVENTS.PERMISSION_RESOLVED],
    'a cached reading must still count toward the streak'
  )
  h.cleanup()
})

test('pane observer stays silent once the session already agrees with the screen', async () => {
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'working', confidence: 0.95 },
    is_running: { type: 'noul', noul: 0.9 }
  }] })
  const status = paneStatus({ phase: 'running', status: 'working' })

  await h.tick(status)
  const events = await h.tick(status)
  assert.strictEqual(events.length, 0, 'agreeing with the screen must not rewrite the session')

  h.advance(5000)
  assert.strictEqual((await h.tick(status)).length, 0)
})

test('shadow mode records readings in its own file and changes nothing', async () => {
  // Shadow has exactly one job: leave a row for the agreement report. Routing
  // that through the reducer cannot be behaviour-neutral — every path through
  // applySessionEvent refreshes lastUpdated and lastEvent, the timestamps the
  // 120s/180s idle sweeps measure, so a stream of shadow readings would
  // postpone the very completions shadow mode must not touch.
  const h = observerHarness({
    observer: { mode: 'shadow' },
    answers: [{
      screen_state: { type: 'choice', choice: 'awaiting_approval', confidence: 0.95 },
      blocked_on_user: { type: 'noul', noul: 0.95 }
    }]
  })
  const status = paneStatus({ phase: 'running', status: 'working' })

  await h.tick(status)
  assert.deepStrictEqual(await h.tick(status), [], 'shadow must never reach the reducer')

  const rows = h.shadowRows()
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].verdict, 'awaiting_approval')
  assert.strictEqual(rows[0].gate, 'accept')
  assert.strictEqual(rows[0].hookPhase, 'running', 'the report needs what the hooks thought at the time')
  assert.strictEqual(rows[0].sessionId, 's1')

  // Standing the idle sweeps down is itself a behaviour change.
  assert.strictEqual(h.observer.observedAt().size, 0)

  // The same verdict again is not new information for the report.
  h.advance(5000)
  await h.tick(status)
  assert.strictEqual(h.shadowRows().length, 1)
  h.cleanup()
})

test('pane observer reports observation times from memory so a frozen screen keeps the sweeps away', async () => {
  const h = observerHarness({ answers: [sampleAnswers('working')] })
  const status = paneStatus()

  const captureAt = h.now()
  await h.tick(status)
  await h.tick(status)
  // Stamped with when the screen was read, not when the answer was processed —
  // the staleness checks that consume this depend on it saying so honestly.
  assert.strictEqual(h.observer.observedAt().get('s1'), captureAt)

  // No event is emitted for an unchanged screen, so the persisted
  // paneObservation would go stale here — the in-memory map must not. Readings
  // are interpreted one tick after capture, so the timestamp trails the clock
  // by a tick; what matters is that it never trails far enough for the 120s
  // sweep to call a session unobserved.
  for (let i = 0; i < 5; i++) {
    h.advance(30_000)
    await h.tick(status)
    assert.ok(h.now() - h.observer.observedAt().get('s1') <= 30_000)
  }
  assert.ok(h.observer.observedAt().get('s1') > captureAt, 'cache hits must keep it moving')
  assert.strictEqual(h.calls.length, 1, 'and none of that cost an API call')
})

test('pane observer caps captures per tick and rotates so no session starves', async () => {
  const h = observerHarness({ observer: { maxCapturesPerTick: 2 } })
  const status = { sessions: {} }
  for (let i = 0; i < 5; i++) {
    status.sessions[`s${i}`] = {
      sessionId: `s${i}`,
      agentType: 'claude',
      tmuxPane: `%${i}`,
      phase: 'running',
      status: 'working',
      stateEvidence: []
    }
  }

  const seen = new Set()
  for (let tick = 0; tick < 5; tick++) {
    h.advance(10_000)
    await h.tick(status)
    for (const state of h.calls) seen.add(state.screen)
  }

  assert.ok(h.observer.stats().captureCapped > 0, 'the cap must actually bite')
  assert.strictEqual(h.observer.stats().captured, 10, '2 captures per tick across 5 ticks')
})

test('pane observer forgets sessions that left the registry', async () => {
  const h = observerHarness()
  const status = paneStatus()

  await h.tick(status)
  await h.tick(status)
  assert.strictEqual(h.observer.stats().tracked, 1)
  assert.strictEqual(h.observer.observedAt().size, 1)

  h.observer.prune({ sessions: {} })
  assert.strictEqual(h.observer.stats().tracked, 0)
  assert.strictEqual(h.observer.observedAt().size, 0)
})

test('pane observer warm-starts its cache across a watcher restart', async () => {
  // tmux reloading its config restarts the watcher. Without a warm start every
  // session is reclassified from scratch even though no screen changed.
  const text = 'agent line one\nagent line two\nagent line three'
  const status = paneStatus()

  const first = observerHarness()
  await first.tick(status)
  await first.tick(status)
  assert.strictEqual(first.calls.length, 1)
  first.observer.close()

  const restarted = observerHarness({ store: first.storeDir })
  // Real time, not the harness clock: the cache checks its TTL against
  // Date.now(), and a seed stamped in the past would be rejected as expired.
  assert.strictEqual(restarted.observer.seed(), 1)
  assert.strictEqual(
    restarted.observer.stats().cache.size,
    1,
    `the entry is keyed by screen content (fp:${text.length})`
  )

  await restarted.tick(status)
  assert.strictEqual(restarted.calls.length, 0, 'a screen unchanged across a restart must not be re-asked')
  first.cleanup()
})

test('every question in the set is read by a decision', () => {
  // The question set is ~88% of the input tokens in a call, so a question
  // nobody reads is a recurring bill for nothing. Both of the ones that were
  // dropped also duplicated something already being asked.
  const { paneQuestions } = require('../scripts/lib/pane-questions')
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'pane-classifier.js'), 'utf-8')
  for (const name of Object.keys(paneQuestions())) {
    assert.ok(source.includes(`'${name}'`), `${name} is asked but never read`)
  }
})

test('jev metrics report latency, tokens and what they cost', () => {
  let clock = 1_000_000
  const metrics = createPaneMetrics({ now: () => clock })
  for (const ms of [100, 200, 300, 400, 5000]) {
    metrics.recordCall({ ok: true, latencyMs: ms, usage: { input_tokens: 2000 } }, { sessionId: 's1', agentType: 'claude' })
  }
  metrics.recordCall({ ok: false, errorKind: 'timeout', latencyMs: 8000 }, { sessionId: 's1', agentType: 'claude' })
  clock += 3600_000

  const snap = metrics.snapshot({ cacheHits: 94 })
  assert.strictEqual(snap.calls, 6)
  assert.strictEqual(snap.ok, 5)
  assert.deepStrictEqual(snap.errorsByKind, { timeout: 1 })
  assert.strictEqual(snap.latency.maxMs, 8000)
  assert.strictEqual(snap.latency.p50Ms, 400, 'percentiles come from the samples, not the mean')
  assert.strictEqual(snap.inputTokens, 10000)
  // 10k tokens at $0.042/Mtok, over exactly one hour of uptime.
  assert.strictEqual(snap.costUsd, 0.00042)
  assert.strictEqual(snap.costUsdPerHour, 0.0004)

  // A rate extrapolated from seconds of uptime is arithmetically right and
  // practically nonsense, so it is withheld rather than shown.
  const fresh = createPaneMetrics({ now: () => clock })
  fresh.recordCall({ ok: true, latencyMs: 50, usage: { input_tokens: 2500 } }, {})
  assert.strictEqual(fresh.snapshot().costUsdPerHour, null)
  assert.ok(fresh.snapshot().costUsd > 0, 'what was already spent is always known')
  // 6 paid calls out of 100 screens that needed an answer: the number that says
  // whether normalization is still keeping animation out of the fingerprint.
  assert.strictEqual(snap.paidShare, 0.06)
})

test('per-call jev logging is opt-in and off by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-metrics-'))
  try {
    const file = path.join(dir, 'pane-metrics.jsonl')
    const quiet = createPaneMetrics({ file })
    quiet.recordCall({ ok: true, latencyMs: 10, usage: { input_tokens: 5 } }, {})
    assert.strictEqual(readMetrics({ file }).length, 0, 'a watcher must not append per call unasked')

    const loud = createPaneMetrics({ file, logCalls: true })
    loud.recordCall({ ok: false, errorKind: 'rate-limited', latencyMs: 12 }, { sessionId: 's1', agentType: 'codex' })
    const [row] = readMetrics({ file })
    assert.strictEqual(row.ok, false)
    assert.strictEqual(row.error, 'rate-limited')
    assert.strictEqual(row.agent, 'codex')
    assert.strictEqual(row.ms, 12)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the observer reports what its calls cost', async () => {
  const h = observerHarness()
  await h.tick(paneStatus())
  await h.tick(paneStatus())

  const jev = h.observer.stats().jev
  assert.strictEqual(jev.calls, 1)
  assert.strictEqual(jev.ok, 1)
  assert.strictEqual(jev.inputTokens, 2551, 'usage must survive from the client to the report')
  assert.ok(jev.costUsd > 0)
  h.cleanup()
})

test('a reading in flight loses to a process exit that landed first', () => {
  // The observer refuses to read a session whose process was seen to exit, but
  // that check runs when the request is dispatched. An exit recorded while the
  // answer is in flight has to be caught when it lands, or a permission_request
  // turns the exit back into a wait — and no PID sweep can undo that, because
  // leaving a wait needs an explicit resolver the sweeps cannot send.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'interrupted', status: 'interrupted',
    terminalKind: 'processExit', endedAt: 900, stateEvidence: []
  }
  const stats = sync.createStats()
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, [{
    sessionId: 's1',
    event: {
      type: AGENT_EVENTS.PERMISSION_REQUEST,
      source: 'pane-model', stateSource: 'pane-model',
      rawEventName: 'pane_awaiting_approval', timestamp: 800
    }
  }], stats)

  assert.strictEqual(currentPhase(session), 'interrupted')
  assert.strictEqual(session.endedAt, 900, 'the exit marker must survive')
  assert.strictEqual(stats.paneModel.superseded, 1)

  // crashed and stale are PID-only phases and get the same treatment.
  for (const phase of ['crashed', 'stale']) {
    const terminal = { sessionId: 's2', agentType: 'claude', phase, status: phase, stateEvidence: [] }
    sync.applyPaneEvents({ version: 1, sessions: { s2: terminal } }, [{
      sessionId: 's2',
      event: { type: AGENT_EVENTS.TURN_COMPLETE, source: 'pane-model', timestamp: 800 }
    }], sync.createStats())
    assert.strictEqual(currentPhase(terminal), phase)
  }
})

test('the capture cursor advances past the batch it processed', async () => {
  // Stepping by one reuses all but one pane of the previous batch. With more
  // panes than the cap, the last one then waits far past the 120s window the
  // idle sweeps stand down for, which is when a false completion becomes
  // possible on a session that is simply waiting its turn to be read.
  const h = observerHarness({ observer: { maxCapturesPerTick: 4 } })
  const status = { sessions: {} }
  for (let i = 0; i < 20; i++) {
    status.sessions[`s${i}`] = {
      sessionId: `s${i}`, agentType: 'claude', tmuxPane: `%${i}`,
      phase: 'running', status: 'working', stateEvidence: []
    }
  }

  const seen = new Set()
  for (let tick = 0; tick < 5; tick++) {
    h.advance(2000)
    await h.tick(status)
    for (const state of h.calls) seen.add(state.screen)
  }
  // 5 ticks x 4 captures must cover all 20 panes exactly once, not 4 panes
  // twenty times. One more tick to drain the last batch, since drain() runs
  // ahead of dispatch() exactly as it does in the watcher loop.
  await h.tick(status)
  assert.strictEqual(h.observer.stats().captured, 24)
  assert.strictEqual(h.observer.observedAt().size, 20, 'every pane must have been read once')
  h.cleanup()
})

test('a shell prompt reading does not stand the timeout fallbacks down', async () => {
  // shell_prompt is accepted but decides nothing — it defers to process
  // liveness. Refreshing the observation for it would suppress the idle
  // fallback forever on a session with no usable pid, leaving it BUSY while
  // the model is saying the agent is gone.
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'shell_prompt', confidence: 0.95 }
  }] })
  const status = paneStatus({ phase: 'running', status: 'working' })

  await h.tick(status)
  assert.deepStrictEqual(await h.tick(status), [], 'a phase-less verdict emits nothing')
  assert.strictEqual(h.observer.observedAt().size, 0)
  h.cleanup()
})

test('the shadow log keeps a disagreement the verdict alone would hide', async () => {
  // Rows exist to answer "did the model and the hooks agree". When the hooks
  // move and the verdict does not, the second row IS the disagreement, so
  // deduplicating on the verdict alone discards the only interesting one.
  const h = observerHarness({
    observer: { mode: 'shadow' },
    answers: [sampleAnswers('working')]
  })
  const session = {
    sessionId: 's1', agentType: 'claude', tmuxPane: '%1',
    phase: 'running', status: 'working', stateEvidence: []
  }
  const status = { sessions: { s1: session } }

  await h.tick(status)
  await h.tick(status)
  assert.strictEqual(h.shadowRows().length, 1)

  // A hook completes the turn; the screen still reads as working.
  session.phase = 'completed'
  session.status = 'completed'
  h.advance(5000)
  await h.tick(status)

  const rows = h.shadowRows()
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(rows.map(row => row.hookPhase), ['running', 'completed'])
  assert.deepStrictEqual(rows.map(row => row.verdict), ['working', 'working'])
  h.cleanup()
})

test('doctor and the watcher agree on whether the pane model is running', () => {
  // A doctor that read only @scout-pane-model reported every prerequisite as
  // fine for a `jev` install — no SDK, no key, and by then no hooks either.
  const { effectivePaneMode } = require('../scripts/lib/state-source')
  const { paneModelSettings } = require('../scripts/watcher')
  const reader = options => name => options[name] || ''

  for (const options of [
    {},
    { '@scout-state-source': 'jev' },
    { '@scout-pane-model': 'shadow' },
    { '@scout-pane-model': 'on' },
    { '@scout-state-source': 'hook', '@scout-pane-model': 'on' },
    { '@scout-state-source': 'hook', '@scout-pane-model': 'shadow' },
    { '@scout-state-source': 'jev', '@scout-pane-model': 'off' }
  ]) {
    assert.strictEqual(
      effectivePaneMode(reader(options)),
      paneModelSettings(reader(options)).mode,
      JSON.stringify(options)
    )
  }
  // `on` is no longer accepted there: it let the model write phase with the
  // hooks still installed, a side door around the either/or switch.
  assert.strictEqual(effectivePaneMode(reader({ '@scout-pane-model': 'on' })), 'off')
  // jev wins over an explicit off: the state source is the stronger statement.
  assert.strictEqual(effectivePaneMode(reader({ '@scout-state-source': 'jev', '@scout-pane-model': 'off' })), 'on')
})

test('an observer rebuilt after a settings change keeps its cache and its bill', async () => {
  // The watcher is not restarted by a tmux config reload, so it rebuilds the
  // observer itself. Rebuilding without the handoff would re-buy every screen
  // on the wall and reset the spend report on every config edit.
  const h = observerHarness()
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1)

  const carry = h.observer.handoff()
  assert.ok(carry.cache && carry.metrics)
  const before = h.observer.stats().jev

  const rebuilt = observerHarness({ store: h.storeDir, observer: carry })
  await rebuilt.tick(paneStatus())
  assert.strictEqual(rebuilt.calls.length, 0, 'an unchanged screen must not be re-bought')
  assert.strictEqual(rebuilt.observer.stats().jev.inputTokens, before.inputTokens)
  h.cleanup()
})

test('a queued pane wait never outruns a process exit found in the same tick', () => {
  // The agent exits after the screen was captured, so the exit is not recorded
  // yet when the reading is queued — the supersession guard has nothing to
  // catch. Ordering is what fixes it: once the record is in a WAIT, no PID
  // sweep can move it, because leaving a wait needs an explicit resolver no
  // sweep can send, and the dead session asks for attention forever.
  const dir = tempDir()
  // Pane %1 exists; only its agent is gone. Without a reachable tmux the
  // liveness sweeps stand down — tmux being unreachable is not evidence of
  // anything — so the test brings its own.
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'tmux'),
    '#!/bin/sh\ncase "$1" in list-panes) printf "%s\\n" "%1\t999998\tzsh\t0\twork\t0\twin\t/tmp" ;; *) exit 1 ;; esac\n',
    { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath}`
  try {
    const statusFile = path.join(dir, 'status.json')
    const now = Date.now()
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      sessions: {
        dying: {
          sessionId: 'dying',
          agentType: 'claude',
          phase: 'running',
          status: 'working',
          tmuxPane: '%1',
          pid: 999999,
          lastUpdated: now,
          stateEvidence: []
        }
      }
    }))

    const result = sync.run(statusFile, {
      codexMode: 'none',
      claudeTranscript: false,
      // The pid is long gone, so reconcileSessions records the exit this tick.
      paneEvents: [{
        sessionId: 'dying',
        event: {
          type: AGENT_EVENTS.PERMISSION_REQUEST,
          source: 'pane-model',
          stateSource: 'pane-model',
          rawEventName: 'pane_awaiting_approval',
          timestamp: now - 2000
        }
      }]
    })

    const session = result.status.sessions.dying
    assert.notStrictEqual(currentPhase(session), 'waitingForApproval',
      'a dead session must not be left asking for attention')
    assert.strictEqual(result.stats.paneModel.superseded, 1)
  } finally {
    process.env.PATH = savedPath
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a slow response never overwrites a newer reading of the same pane', async () => {
  // Readings arrive in the order they were produced, not the order they were
  // captured: a cache hit is recorded during dispatch while a request from an
  // earlier tick lands whenever it lands. Applying the older one sends the
  // session back to a wait it already left, and walks observedAt backwards.
  const IDLE = 'the composer is empty\nnothing is running\nready for input'
  const DIALOG = 'a dialog is open\nallow this command?\n1. Yes'
  const held = []
  const client = {
    available: true,
    reason: null,
    classify(state) {
      const dialog = state.screen.includes('dialog')
      const answers = dialog
        ? {
          screen_state: { type: 'choice', choice: 'awaiting_approval', confidence: 0.95 },
          blocked_on_user: { type: 'noul', noul: 0.95 }
        }
        : {
          screen_state: { type: 'choice', choice: 'idle_ready', confidence: 0.95 },
          blocked_on_user: { type: 'noul', noul: 0.02 }
        }
      const result = { ok: true, answers, usage: { input_tokens: 2551 }, model: 'jev-1.13.0', latencyMs: dialog ? 6000 : 40 }
      // The dialog request is the slow one, resolved by hand below so a newer
      // reading of the same pane can be queued ahead of it.
      return dialog ? new Promise(resolve => held.push(() => resolve(result))) : Promise.resolve(result)
    }
  }

  const h = observerHarness({ observer: { client } })
  const status = {
    sessions: {
      s1: {
        sessionId: 's1', agentType: 'claude', tmuxPane: '%1',
        phase: 'running', status: 'working', stateEvidence: []
      }
    }
  }

  h.screens.set('%1', IDLE)
  await h.tick(status)                       // answers IDLE, caches it
  h.advance(6000)
  await h.tick(status)                       // drains it, queues a cache hit

  h.screens.set('%1', DIALOG)
  h.advance(6000)
  await h.tick(status)                       // starts the slow dialog request

  h.screens.set('%1', IDLE)
  h.advance(6000)
  await h.tick(status)                       // queues a fresh IDLE cache hit
  const newestAt = h.observer.observedAt().get('s1')

  held.pop()()                               // the stale dialog answer lands now
  await new Promise(resolve => setImmediate(resolve))

  const events = await h.tick(status)
  assert.ok(
    !events.some(entry => entry.event.type === AGENT_EVENTS.PERMISSION_REQUEST),
    'a reading older than one already processed describes a screen that is gone'
  )
  assert.strictEqual(h.observer.stats().stale, 1)
  assert.ok(h.observer.observedAt().get('s1') >= newestAt, 'observedAt must never walk backwards')
  h.cleanup()
})

test('per-call logging follows the option across a rebuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-metrics-'))
  try {
    const file = path.join(dir, 'pane-metrics.jsonl')
    const metrics = createPaneMetrics({ file })
    metrics.recordCall({ ok: true, latencyMs: 10, usage: { input_tokens: 5 } }, {})
    assert.strictEqual(readMetrics({ file }).length, 0)

    // The watcher reconfigures a running observer rather than restarting it, so
    // this object outlives the settings it was built with. A switch left in the
    // original closure would never take effect in either direction.
    metrics.configure({ logCalls: true })
    metrics.recordCall({ ok: true, latencyMs: 11, usage: { input_tokens: 5 } }, { agentType: 'claude' })
    assert.strictEqual(readMetrics({ file }).length, 1)
    assert.strictEqual(metrics.snapshot().calls, 2, 'the totals survive the reconfigure')

    metrics.configure({ logCalls: false })
    metrics.recordCall({ ok: true, latencyMs: 12, usage: { input_tokens: 5 } }, {})
    assert.strictEqual(readMetrics({ file }).length, 1, 'disabling must stop the writes')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuilt observer applies the new logging option to inherited metrics', async () => {
  const h = observerHarness()
  await h.tick(paneStatus())
  await h.tick(paneStatus())

  const carry = h.observer.handoff()
  const rebuilt = observerHarness({
    store: h.storeDir,
    observer: Object.assign({ logCalls: true }, carry)
  })
  rebuilt.screens.set('%1', 'a different screen\nline two\nline three')
  rebuilt.advance(10_000)
  await rebuilt.tick(paneStatus())
  await rebuilt.tick(paneStatus())

  assert.strictEqual(rebuilt.calls.length, 1, 'the changed screen costs one call')
  assert.strictEqual(rebuilt.metricRows().length, 1, 'and logging turned on without a restart')
  assert.ok(rebuilt.observer.stats().jev.calls >= 2, 'the earlier calls are still counted')
  h.cleanup()
})

test('the pane tail skips the empty rows below a short CLI', () => {
  // capture-pane returns every row of the pane. A tall pane with a few lines of
  // output at the top is mostly blank rows beneath them; slicing the tail first
  // kept only those, and the classifier skipped the empty screen forever.
  const { lastLines } = require('../scripts/lib/pane-capture')
  const raw = ['❯ fix the tests', '', '  Working on it', ...Array(67).fill('')].join('\n')
  assert.strictEqual(lastLines(raw, 40), '❯ fix the tests\n\n  Working on it')
  assert.strictEqual(normalizePaneText(lastLines(raw, 40)).split('\n').length, 2)
  // Content taller than the limit is still cut from the top, as before.
  const tall = Array.from({ length: 50 }, (_, i) => `line ${i}`).concat(['', ''])
  assert.strictEqual(lastLines(tall.join('\n'), 3), 'line 47\nline 48\nline 49')
})

test('the jev client turns SDK retries off so the observer owns the budget', () => {
  // SDK 0.6 retries 408/429/5xx and timeouts twice by default. That is up to
  // three HTTP requests behind one budgeted call, and a 429 that only reaches
  // the observer's account-wide cooldown after the SDK finishes retrying.
  let config = null
  const sdk = { TypeSafeClient: function (options) { config = options; this.systemOne = async () => ({}) } }
  const { createJevClient } = require('../scripts/lib/jev-client')
  assert.ok(createJevClient({ apiKey: 'test', sdk }).available)
  assert.deepStrictEqual(config.retry, { maxRetries: 0 })
})

function fakePaneObserver(available, label) {
  const observer = {
    label,
    closed: false,
    seeded: 0,
    stats: () => ({ available }),
    handoff: () => ({ cache: `cache-of-${label}`, metrics: `metrics-of-${label}` }),
    close() { observer.closed = true },
    seed() { observer.seeded++ }
  }
  return observer
}

test('the settings poll rebuilds on a change and hands the cache over', () => {
  const { refreshPaneObserver } = require('../scripts/watcher')
  const old = fakePaneObserver(true, 'old')
  const starts = []
  const deps = {
    log: () => {},
    probe: () => { throw new Error('a ready client must never be probed') },
    start: (settings, carry) => { starts.push({ settings, carry }); return fakePaneObserver(true, 'new') }
  }
  const current = { settings: { mode: 'shadow' }, signature: JSON.stringify({ mode: 'shadow' }), observer: old }

  // Unchanged and healthy: the same object back, nothing rebuilt.
  assert.strictEqual(refreshPaneObserver(current, { mode: 'shadow' }, deps), current)
  assert.strictEqual(starts.length, 0)

  const next = refreshPaneObserver(current, { mode: 'on' }, deps)
  assert.strictEqual(old.closed, true)
  assert.strictEqual(next.observer.label, 'new')
  assert.strictEqual(starts[0].carry.cache, 'cache-of-old', 'a config edit must not re-buy every screen')
  assert.strictEqual(next.observer.seeded, 0, 'a handed-over cache needs no reseed from disk')

  // Switching off closes the observer — this is the change that stops billing.
  const off = refreshPaneObserver(next, { mode: 'off' }, Object.assign({}, deps, { start: () => null }))
  assert.strictEqual(off.observer, null)
  assert.strictEqual(next.observer.closed, true)
})

test('the settings poll recovers once a missing key or SDK is supplied', () => {
  // Enable-then-configure is the documented order, and supplying the key does
  // not change the settings signature, so without this the client built at
  // enable time stayed unavailable until someone restarted the watcher.
  const { refreshPaneObserver } = require('../scripts/watcher')
  const waiting = fakePaneObserver(false, 'waiting')
  let ready = false
  const logs = []
  const starts = []
  const deps = {
    log: line => logs.push(line),
    probe: () => (ready ? { available: true, model: 'jev-latest' } : { available: false, reason: 'no-key' }),
    start: (settings, carry) => { starts.push(carry); return fakePaneObserver(true, 'ready') }
  }
  const current = { settings: { mode: 'on' }, signature: JSON.stringify({ mode: 'on' }), observer: waiting }

  // Still no key: nothing rebuilt and nothing logged, however many polls.
  for (let i = 0; i < 3; i++) assert.strictEqual(refreshPaneObserver(current, { mode: 'on' }, deps), current)
  assert.deepStrictEqual(logs, [])

  ready = true
  const next = refreshPaneObserver(current, { mode: 'on' }, deps)
  assert.strictEqual(waiting.closed, true)
  assert.strictEqual(next.observer.label, 'ready')
  assert.strictEqual(starts[0].client.available, true, 'the probed client is reused, not built twice')
  assert.strictEqual(starts[0].cache, 'cache-of-waiting')
  assert.strictEqual(logs.length, 1)
})

test('a timeout sweep touching an old record does not hand it the pane', async () => {
  // Several live records routinely share a pane. The fallback sweeps write
  // lastUpdated too, so ranking by it gave the screen to whichever record a
  // sweep had just completed — reopening the obsolete one with readings that
  // belong to the live session.
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'awaiting_approval', confidence: 0.95 },
    blocked_on_user: { type: 'noul', noul: 0.95 }
  }] })
  const base = { agentType: 'claude', tmuxPane: '%1', stateEvidence: [] }
  const status = {
    sessions: {
      live: Object.assign({}, base, { sessionId: 'live', phase: 'running', status: 'working', startedAt: 5000, lastUpdated: 6000 }),
      old: Object.assign({}, base, {
        sessionId: 'old', phase: 'completed', status: 'completed', startedAt: 1000,
        // The idle sweep just completed it: the newest write on the pane.
        lastUpdated: 9_000_000, lastEvent: { type: 'turn_complete', timestamp: 9_000_000 }
      })
    }
  }

  await h.tick(status)
  const events = await h.tick(status)
  assert.deepStrictEqual([...new Set(events.map(entry => entry.sessionId))], ['live'])
  h.cleanup()
})

test('the prompt extractor finds the composer above blank pane rows', () => {
  // A short CLI in a tall pane leaves blank rows below the composer. Counted
  // from the last row, the composer fell outside the bottom window, and the
  // unsent draft in it was read back as the submitted prompt and title.
  const raw = [
    '❯ the prompt that was actually sent',
    '',
    '  Done.',
    '─'.repeat(40),
    '❯ a draft the user has not sent',
    '─'.repeat(40),
    ...Array(30).fill('')
  ].join('\n')
  const extracted = extractPromptAndTitle(raw, 'claude')
  assert.strictEqual(extracted.lastUserPrompt, 'the prompt that was actually sent')
})

test('observation times survive a settings rebuild and a watcher restart', async () => {
  // Starting empty re-opens the window the map exists to close: the first tick
  // after a rebuild runs the idle sweeps before anything has been read, and a
  // session frozen on a long command is completed.
  const h = observerHarness()
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  const seenAt = h.observer.observedAt().get('s1')
  assert.ok(Number.isFinite(seenAt))

  // Rebuild: handed over in memory.
  const rebuilt = observerHarness({ store: h.storeDir, observer: h.observer.handoff() })
  assert.strictEqual(rebuilt.observer.observedAt().get('s1'), seenAt)

  // Restart: written out, then read back by a fresh process.
  h.observer.close()
  const restarted = observerHarness({ store: h.storeDir })
  restarted.observer.seed()
  assert.strictEqual(restarted.observer.observedAt().get('s1'), seenAt)
  h.cleanup()
})

test('switching from shadow to on keeps what shadow already read', async () => {
  // Shadow reads every screen too. Starting the `on` observer empty ran the
  // first tick's idle sweeps against nothing, completing a session frozen on a
  // long command that shadow had been watching all along.
  const h = observerHarness({ observer: { mode: 'shadow' } })
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  assert.strictEqual(h.observer.observedAt().size, 0, 'shadow still stands nothing down')

  const on = observerHarness({ store: h.storeDir, observer: Object.assign({ mode: 'on' }, h.observer.handoff()) })
  assert.ok(Number.isFinite(on.observer.observedAt().get('s1')))
  h.cleanup()
})

test('the key-file check matches the rule the watcher reads it by', () => {
  const { keyFileState } = require('../scripts/lib/jev-client')
  // Only the vocabulary is asserted here: the real file is the user's, and a
  // test must not create, chmod or remove it.
  assert.ok(['ok', 'bad-mode', 'missing'].includes(keyFileState()))
  const doctor = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'doctor.js'), 'utf-8')
  assert.ok(!/existsSync\(KEY_FILE\)/.test(doctor), 'doctor must not treat a file that exists as a file that works')
})

// A process snapshot in the shape readProcessTable() returns.
function processTableOf(procs) {
  const byPid = new Map()
  const childrenByPpid = new Map()
  for (const proc of procs) {
    const full = Object.assign({ args: proc.command, commandLine: proc.command, basename: path.basename(proc.command), startedAtMs: Date.now() - 300000 }, proc)
    byPid.set(full.pid, full)
    if (!childrenByPpid.has(full.ppid)) childrenByPpid.set(full.ppid, [])
    childrenByPpid.get(full.ppid).push(full)
  }
  return { byPid, childrenByPpid }
}

function discoveryFixture(windowName, agentPid = 556051) {
  const now = Date.now()
  const panePid = 556050
  const panes = new Map([['%88', {
    paneId: '%88', panePid, currentCommand: 'zsh', paneDead: false,
    sessionName: 'work', windowIndex: 1, windowName, currentPath: '/tmp/demo'
  }]])
  panes.tmuxAvailable = true
  const shell = { pid: panePid, ppid: 1, command: '/bin/zsh', args: '-zsh', commandLine: '-zsh', basename: 'zsh', startedAtMs: now - 600000 }
  const claude = { pid: agentPid, ppid: panePid, command: '/opt/homebrew/bin/claude', args: 'claude', commandLine: 'claude', basename: 'claude', startedAtMs: now - 300000 }
  const table = {
    byPid: new Map([[shell.pid, shell], [claude.pid, claude]]),
    childrenByPpid: new Map([[1, [shell]], [panePid, [claude]]])
  }
  return { now, panes, table }
}

test('a pane metadata change does not reset a session the model has moved', () => {
  // In jev mode discovery records are the only records. A window rename —
  // copy-mode alone renames it to "[tmux]" — re-sent DISCOVERED, which the
  // contract maps to idle, and handed stateSource back to pane-discovery,
  // which the picker hides as a placeholder.
  const opts = { writeSession: false, writeStatus: false }
  const first = discoveryFixture('agent')
  const status = { version: 1, lastUpdated: first.now, sessions: {} }
  sync.discoverPaneSessions(status, first.panes, first.table, sync.createStats(), Object.assign({ now: first.now }, opts))
  const id = sync.discoverySessionId('claude', '%88')
  const session = status.sessions[id]

  applySessionEvent(session, {
    type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, source: 'pane-model', stateSource: 'pane-model', timestamp: first.now + 1
  })
  assert.strictEqual(currentPhase(session), 'running')

  const renamed = discoveryFixture('[tmux]')
  sync.discoverPaneSessions(status, renamed.panes, first.table, sync.createStats(), Object.assign({ now: first.now + 2000 }, opts))

  const after = status.sessions[id]
  assert.strictEqual(after.tmuxWindowName, '[tmux]', 'the metadata still lands')
  assert.strictEqual(currentPhase(after), 'running')
  assert.strictEqual(after.stateSource, 'pane-model')
  assert.notStrictEqual(isVisibleInPicker(after), 'hidden')
})

test('a wait ends when the agent it belonged to is gone', () => {
  // The user answers an approval dialog with Ctrl-C twice and lands at a shell.
  // shell_prompt decides no phase — PID liveness does — but PID liveness sends
  // process_exit, and the WAIT guard refuses that without a resolver. Without
  // the resolver from the screen, the dead session asks for approval forever.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval' }, pid: 424242, stateEvidence: []
  }
  const events = paneEvents(confidently('shell_prompt'), session, leaving('shell_prompt'))
  assert.deepStrictEqual(events.map(event => event.type), [AGENT_EVENTS.PERMISSION_RESOLVED])
  for (const event of events) applySessionEvent(session, event)

  applySessionEvent(session, {
    type: AGENT_EVENTS.PROCESS_EXIT_DETECTED, source: 'pid', force: true, timestamp: Date.now()
  })
  assert.notStrictEqual(currentPhase(session), 'waitingForApproval')

  // Outside a wait a shell prompt still sends nothing.
  const running = { sessionId: 's2', agentType: 'claude', phase: 'running', status: 'working' }
  assert.deepStrictEqual(paneEvents(confidently('shell_prompt'), running, leaving('shell_prompt')), [])
})

test('a never-prompted session stays idle when its empty composer is read', () => {
  // idle_ready maps to completed; applied to a fresh session it showed DONE for
  // work that never happened. A prompt on screen means there was a turn.
  const fresh = { sessionId: 's1', agentType: 'claude', phase: 'idle', status: 'idle' }
  assert.deepStrictEqual(paneEvents(confidently('idle_ready'), fresh), [])

  const withPrompt = paneEvents(confidently('idle_ready'), fresh, {
    options: { extracted: { lastUserPrompt: 'fix the tests' } }
  })
  assert.deepStrictEqual(withPrompt.map(event => event.type), [AGENT_EVENTS.TURN_COMPLETE])
})

test('a resolver meets the phase it lands on, not the one it was built for', () => {
  // Two readings of one session can land in the same batch, both built while
  // it was waiting. The first leaves the wait; the second's question_answered
  // would then reopen a completed turn and drop its turn ids.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'completed', status: 'completed',
    lastTurnId: 'turn-7', stateEvidence: []
  }
  const stats = sync.createStats()
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, [{
    sessionId: 's1',
    event: { type: AGENT_EVENTS.QUESTION_ANSWERED, source: 'pane-model', stateSource: 'pane-model', timestamp: Date.now() }
  }], stats)
  assert.strictEqual(currentPhase(session), 'completed')
  assert.strictEqual(session.lastTurnId, 'turn-7')
  assert.strictEqual(stats.paneModel.superseded, 1)
})

test('a reading captured before the process started is about another process', () => {
  // Discovery ids are per pane, so an agent restarted in the same pane keeps
  // the record, with the new process's start time.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'idle', status: 'idle', startedAt: 5000, stateEvidence: []
  }
  const stats = sync.createStats()
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, [{
    sessionId: 's1',
    event: { type: AGENT_EVENTS.PERMISSION_REQUEST, source: 'pane-model', stateSource: 'pane-model', timestamp: 4000 }
  }], stats)
  assert.strictEqual(currentPhase(session), 'idle')
  assert.strictEqual(stats.paneModel.superseded, 1)
})

test('one rejected reading cannot be bridged into a wait exit', async () => {
  // The streak used to count verdicts, not readings that passed: a working
  // reading rejected at 0.1 followed by one at 0.99 was a "streak of two".
  const h = observerHarness({ answers: [
    { screen_state: { type: 'choice', choice: 'working', confidence: 0.1 } },
    { screen_state: { type: 'choice', choice: 'working', confidence: 0.99 } }
  ] })
  const status = paneStatus({
    phase: 'waitingForApproval', status: 'waiting',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval', startedAt: 0 }
  })
  const screens = ['first screen\nline two\nline three', 'second screen\nline two\nline three']
  let emitted = []
  for (let i = 0; i < 3; i++) {
    h.screens.set('%1', screens[Math.min(i, 1)])
    h.advance(7000)
    emitted = emitted.concat(await h.tick(status))
  }
  assert.strictEqual(h.calls.length, 2)
  assert.deepStrictEqual(emitted, [], 'one trusted reading is not two')
  h.cleanup()
})

test('a frozen screen below the strict bar leaves a wait on duration alone', async () => {
  // Approved, then a long command with nothing on screen but a spinner, read at
  // 0.7 — accepted, below the 0.75 exit bar. With strict evidence the only way
  // out, the session stayed in WAIT for the whole command it was approved to run.
  const h = observerHarness({ answers: [{
    screen_state: { type: 'choice', choice: 'working', confidence: 0.7 },
    blocked_on_user: { type: 'noul', noul: 0.02 }
  }] })
  const status = paneStatus({
    phase: 'waitingForApproval', status: 'waiting',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval', startedAt: 0 }
  })

  let emitted = []
  for (let i = 0; i < 8; i++) {
    h.advance(2000)
    emitted = emitted.concat(await h.tick(status))
  }
  assert.strictEqual(h.calls.length, 1, 'all of it from one paid answer')
  assert.deepStrictEqual([...new Set(emitted.map(entry => entry.event.type))], [AGENT_EVENTS.PERMISSION_RESOLVED])
  h.cleanup()
})

test('a long free stretch does not delay reading the dialog that ends it', async () => {
  // Backoff used to count cache hits. A frozen working screen — which costs
  // nothing — ratcheted the interval to 30s, so the approval dialog that
  // replaced it waited up to 30s to be read at all.
  const h = observerHarness({ answers: [sampleAnswers('working')] })
  const status = paneStatus({ phase: 'running', status: 'working' })
  // 18s of cache hits: long enough to have ratcheted the old backoff to its
  // 30s ceiling, short enough that the ceiling is still in force when the
  // dialog appears.
  for (let i = 0; i < 9; i++) {
    h.advance(2000)
    await h.tick(status)
  }
  assert.strictEqual(h.calls.length, 1)

  h.screens.set('%1', 'a dialog appeared\nallow this?\n1. Yes')
  h.advance(2000)
  await h.tick(status)
  assert.strictEqual(h.calls.length, 2, 'the changed screen is read on the next tick')
  h.cleanup()
})

test('a rebuild inherits the rate-limit cooldown it was still inside', async () => {
  const h = observerHarness({ answers: [new Error('rate-limited')] })
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1)

  const rebuilt = observerHarness({ store: h.storeDir, observer: h.observer.handoff() })
  rebuilt.advance(2000)
  await rebuilt.tick(paneStatus())
  assert.strictEqual(rebuilt.calls.length, 0, 'the new observer must not fire straight back into the 429')
  h.cleanup()
})

test('switching from on to shadow stops standing the sweeps down', async () => {
  const h = observerHarness()
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  assert.strictEqual(h.observer.observedAt().size, 1)

  const shadow = observerHarness({
    store: h.storeDir,
    observer: Object.assign({ mode: 'shadow' }, h.observer.handoff())
  })
  assert.strictEqual(shadow.observer.observedAt().size, 0, 'shadow changes no behaviour, inherited or not')
  h.cleanup()
})

test('an answer from another model behind the alias is never served', async () => {
  const calls = []
  const models = ['jev-1.13.0', 'jev-1.14.0']
  const client = {
    available: true,
    reason: null,
    async classify(state) {
      calls.push(state)
      return { ok: true, answers: sampleAnswers('working'), usage: { input_tokens: 10 }, model: models[Math.min(calls.length - 1, 1)] }
    }
  }
  const h = observerHarness({ observer: { client } })
  const status = paneStatus()
  await h.tick(status)
  await h.tick(status)

  h.screens.set('%1', 'another screen\nline two\nline three')
  h.advance(7000)
  await h.tick(status)
  await h.tick(status)
  h.screens.delete('%1')
  h.advance(7000)
  await h.tick(status)
  assert.strictEqual(calls.length, 3, 'the old model\'s answer is not served again')
  h.cleanup()
})

test('answers seeded from disk are checked against the model answering now', async () => {
  // The old wipe compared against the model this process had last seen, which
  // after a restart is nothing — so a previous model's answers loaded from disk
  // were served indefinitely.
  const first = observerHarness()
  await first.tick(paneStatus())
  await first.tick(paneStatus())
  first.observer.close()

  const calls = []
  const client = {
    available: true,
    reason: null,
    async classify(state) {
      calls.push(state)
      return { ok: true, answers: sampleAnswers('working'), usage: { input_tokens: 10 }, model: 'jev-2.0.0' }
    }
  }
  const second = observerHarness({ store: first.storeDir, observer: { client } })
  second.screens.set('%1', 'a screen the old model never saw\nline two\nline three')
  await second.tick(paneStatus())
  await second.tick(paneStatus())
  assert.strictEqual(calls.length, 1)

  second.screens.delete('%1')
  second.advance(7000)
  await second.tick(paneStatus())
  assert.strictEqual(calls.length, 2, 'the seeded answer came from jev-1.13.0 and is a miss now')
  second.cleanup()
})

test('a rollout alternating models keeps both models\' answers', async () => {
  // Wiping on every change threw the whole cache away at each alternation.
  let answering = 'jev-a'
  const calls = []
  const client = {
    available: true,
    reason: null,
    async classify(state) {
      calls.push(state)
      return { ok: true, answers: sampleAnswers('working'), usage: { input_tokens: 10 }, model: answering }
    }
  }
  const h = observerHarness({ observer: { client } })
  const status = paneStatus()
  // Past the backoff ceiling, so a read that is not made was served from cache.
  const show = async (text, advance = 40000) => {
    if (text === null) h.screens.delete('%1')
    else h.screens.set('%1', text)
    h.advance(advance)
    await h.tick(status)
    await h.tick(status)
  }
  await show(null)
  answering = 'jev-b'
  await show('screen two\nline two\nline three')
  answering = 'jev-a'
  await show('screen three\nline two\nline three')
  assert.strictEqual(calls.length, 3)
  await show(null)
  assert.strictEqual(calls.length, 3, 'jev-a is answering again, so its first answer is still good')
  h.cleanup()
})

// --- review round 6 ---

test('an exited hook-era record does not hold its pane against a restarted agent', () => {
  // After a switch to jev, a hook-era record whose agent exited still counted
  // as a live real session for the pane, so discovery never created a record
  // for the agent restarted there — and the observer rightly refuses to read
  // the exited one. The pane went unwatched for good.
  const { isRecordedProcessExit } = require('../scripts/lib/session-state')
  const opts = { writeSession: false, writeStatus: false }
  const f = discoveryFixture('agent')
  const exited = {
    sessionId: 'hook-1', agentType: 'claude', tmuxPane: '%88', phase: 'running', status: 'working',
    startedAt: f.now - 900000, lastHookEventName: 'UserPromptSubmit', stateEvidence: []
  }
  applySessionEvent(exited, { type: AGENT_EVENTS.PROCESS_EXIT_DETECTED, source: 'pid', force: true, timestamp: f.now - 1000 })
  assert.ok(isRecordedProcessExit(exited))

  const status = { version: 1, lastUpdated: f.now, sessions: { 'hook-1': exited } }
  sync.discoverPaneSessions(status, f.panes, f.table, sync.createStats(), Object.assign({ now: f.now }, opts))
  assert.ok(status.sessions[sync.discoverySessionId('claude', '%88')], 'the restarted agent gets a record')
})

test('an agent restarted in the same pane starts a new record, not the old one revived', () => {
  // Discovery ids are per pane, so the restart lands on the previous run's
  // record. Revived in place it kept that run's prompt, title and turn ids.
  const opts = { writeSession: false, writeStatus: false }
  const id = sync.discoverySessionId('claude', '%88')
  const previousRun = (status, now) => {
    const session = status.sessions[id]
    Object.assign(session, {
      lastUserPrompt: 'the previous run\'s prompt', sessionTitle: 'the previous run', lastTurnId: 'turn-old'
    })
    applySessionEvent(session, {
      type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, source: 'pane-model', stateSource: 'pane-model', timestamp: now + 1
    })
    return session
  }

  // Recorded as exited: a new session, whatever the pid.
  const first = discoveryFixture('agent')
  const exitedStatus = { version: 1, lastUpdated: first.now, sessions: {} }
  sync.discoverPaneSessions(exitedStatus, first.panes, first.table, sync.createStats(), Object.assign({ now: first.now }, opts))
  const exited = previousRun(exitedStatus, first.now)
  applySessionEvent(exited, { type: AGENT_EVENTS.PROCESS_EXIT_DETECTED, source: 'pid', force: true, timestamp: first.now + 2 })
  // Even with its old pid since reused by something alive.
  exited.pid = process.pid
  const restarted = discoveryFixture('agent', 556052)
  sync.discoverPaneSessions(exitedStatus, restarted.panes, restarted.table, sync.createStats(), Object.assign({ now: first.now + 5000 }, opts))
  const fresh = exitedStatus.sessions[id]
  assert.strictEqual(fresh.lastUserPrompt, undefined)
  assert.strictEqual(fresh.lastTurnId, undefined)
  assert.strictEqual(fresh.sessionTitle, 'claude session')
  assert.strictEqual(fresh.pid, 556052)

  // Not recorded yet, but the old pid is gone and a new one is in the pane.
  const second = discoveryFixture('agent')
  const deadStatus = { version: 1, lastUpdated: second.now, sessions: {} }
  sync.discoverPaneSessions(deadStatus, second.panes, second.table, sync.createStats(), Object.assign({ now: second.now }, opts))
  previousRun(deadStatus, second.now).pid = 4194305
  sync.discoverPaneSessions(deadStatus, restarted.panes, restarted.table, sync.createStats(), Object.assign({ now: second.now + 5000 }, opts))
  assert.strictEqual(deadStatus.sessions[id].lastUserPrompt, undefined)

  // A pid change along one process chain is the process-tree walk settling on
  // a different process of the same run, not a restart.
  const third = discoveryFixture('agent')
  const liveStatus = { version: 1, lastUpdated: third.now, sessions: {} }
  sync.discoverPaneSessions(liveStatus, third.panes, third.table, sync.createStats(), Object.assign({ now: third.now }, opts))
  previousRun(liveStatus, third.now).pid = 556050
  sync.discoverPaneSessions(liveStatus, restarted.panes, restarted.table, sync.createStats(), Object.assign({ now: third.now + 5000 }, opts))
  assert.strictEqual(liveStatus.sessions[id].lastUserPrompt, 'the previous run\'s prompt')

  // An old process that lives outside the chain — suspended with Ctrl-Z while
  // a new agent was started in the pane — is a different run.
  const fourth = discoveryFixture('agent')
  const suspendedStatus = { version: 1, lastUpdated: fourth.now, sessions: {} }
  sync.discoverPaneSessions(suspendedStatus, fourth.panes, fourth.table, sync.createStats(), Object.assign({ now: fourth.now }, opts))
  previousRun(suspendedStatus, fourth.now)
  const withSuspended = processTableOf([
    { pid: 556050, ppid: 1, command: '/bin/zsh' },
    { pid: 556052, ppid: 556050, command: '/opt/homebrew/bin/claude' },
    { pid: 556051, ppid: 1, command: '/opt/homebrew/bin/claude' }
  ])
  sync.discoverPaneSessions(suspendedStatus, restarted.panes, withSuspended, sync.createStats(), Object.assign({ now: fourth.now + 5000 }, opts))
  assert.strictEqual(suspendedStatus.sessions[id].pid, 556052)
  assert.strictEqual(suspendedStatus.sessions[id].lastUserPrompt, undefined)
})

test('a reading the reducer refuses does not clear an ended flag', () => {
  // applySessionUpdate reports `changed` for a refused event too — the refusal
  // is written as evidence — so the correction keyed on `changed` ran for
  // readings the guards had turned away.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working', endedAt: 500,
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval' }, stateEvidence: []
  }
  sync.applyPaneEvents({ version: 1, sessions: { s1: session } }, [{ sessionId: 's1', event: {
    type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, source: 'pane-model', stateSource: 'pane-model', timestamp: 1000
  } }], sync.createStats())
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.strictEqual(session.endedAt, 500)
})

test('a refreshed wait with unchanged details keeps the wait clock running', () => {
  // Re-sending the same details made sameWaitRefresh() false, so a title that
  // became readable on an unchanged dialog restarted how long the user had
  // been waiting.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working',
    pendingInteraction: { type: 'approval', phase: 'waitingForApproval', details: 'Bash: rm -rf build', startedAt: 500 },
    stateEvidence: []
  }
  const extracted = { pendingDetails: 'Bash: rm -rf build', lastUserPrompt: 'clean the build', sessionTitle: 'clean the build' }
  const events = paneEvents(confidently('awaiting_approval'), session, { options: { extracted, now: 9000 } })
  for (const event of events) {
    assert.strictEqual(event.pendingToolUse, undefined)
    applySessionEvent(session, event)
  }
  assert.strictEqual(session.pendingInteraction.startedAt, 500)

  const changed = paneEvents(confidently('awaiting_approval'), session,
    { options: { extracted: Object.assign({}, extracted, { pendingDetails: 'Bash: rm -rf dist' }), now: 9500 } })
  assert.strictEqual(changed[0].pendingToolUse.details, 'Bash: rm -rf dist', 'a new dialog is still announced')
})

test('a multi-line draft in the Claude composer is not read as the submitted prompt', () => {
  // A four-line draft pushed the composer's marker out of the six-line window
  // the fallback searches, and the draft's first line became the prompt.
  const draft = [
    '❯ the prompt that was actually sent',
    '',
    '  Done.',
    '─'.repeat(40),
    '❯ first line of a draft',
    '  second line',
    '  third line',
    '  fourth line',
    '  fifth line',
    '─'.repeat(40),
    '  󰉋 repos/example  Opus 5',
    '  -- INSERT --'
  ].join('\n')
  assert.strictEqual(extractPromptAndTitle(draft, 'claude').lastUserPrompt, 'the prompt that was actually sent')
})

test('the wait-exit bar stays above the accept bar however high that is set', () => {
  // A fixed offset capped at 0.9 stopped being any higher at all once the
  // accept bar was 0.9, and leaving a wait became as easy as entering one.
  const { paneModelSettings } = require('../scripts/watcher')
  for (const accept of ['0.6', '0.9', '0.95']) {
    const read = name => ({ '@scout-state-source': 'jev', '@scout-pane-model-confidence': accept })[name] || ''
    const { thresholds } = paneModelSettings(read)
    assert.ok(thresholds.waitExit > thresholds.accept, `accept ${accept}`)
    assert.ok(thresholds.waitExit < 1, `accept ${accept}`)
  }
})

test('a changed bottom of screen is read at the minimum interval despite a backoff', async () => {
  // Streaming output reaching the same verdict backs a session off. A dialog
  // replacing the composer is a different screen, and was held up to 30s.
  let n = 0
  let bottom = 'composer'
  const capture = paneId => {
    const text = `body ${n++}\nline two\nline three\n${bottom}`
    return { paneId, raw: text, text, fingerprint: `fp:${text}`, bottom }
  }
  const h = observerHarness({ observer: { capture, intervalMs: 2000 } })
  for (let i = 0; i < 5; i++) {
    h.advance(40000)
    await h.tick(paneStatus())
  }
  assert.strictEqual(h.calls.length, 5)
  h.advance(2500)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 5, 'five identical verdicts back the body off')
  bottom = 'Do you want to proceed?'
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 6, 'the moved bottom is not')
  h.cleanup()
})

test('a changed bottom of screen waits the minimum interval, not the base one', async () => {
  // A finished turn moves the bottom — the spinner line becomes "Worked for" —
  // and waiting out the base 6s interval kept it BUSY that much longer.
  let n = 0
  let bottom = 'spinner'
  const capture = paneId => {
    const text = `body ${n++}\nline two\nline three\n${bottom}`
    return { paneId, raw: text, text, fingerprint: `fp:${text}`, bottom }
  }
  const h = observerHarness({ observer: { capture } })
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1)
  bottom = 'done'
  h.advance(1500)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1, 'still inside the minimum interval')
  h.advance(600)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 2, 'read 2.1s after the last call, not 6s')
  h.advance(2100)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 2, 'a body that scrolls under an unchanged bottom still waits the base interval')
  h.cleanup()
})

test('a screen that stops changing is read at the minimum interval despite a backoff', async () => {
  // A finished Claude turn changes the line above the composer, not the
  // bottom few lines — so after a streak of `working` it waited out the whole
  // backoff before anyone read it.
  let n = 0
  let body = null
  const capture = paneId => {
    const text = `${body || `body ${n++}`}\nline two\nline three\ncomposer`
    return { paneId, raw: text, text, fingerprint: `fp:${text}`, bottom: 'composer' }
  }
  const h = observerHarness({ observer: { capture, intervalMs: 2000 } })
  for (let i = 0; i < 5; i++) {
    h.advance(40000)
    await h.tick(paneStatus())
  }
  assert.strictEqual(h.calls.length, 5)
  body = 'Worked for <dur> · done'
  h.advance(2100)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 5, 'first sight of the new screen: it might still be moving')
  h.advance(2100)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 6, 'seen twice: it has settled')
  h.cleanup()
})

test('a screen whose answer the gate rejected is asked again, a bounded number of times', async () => {
  // %166: a finished turn answered idle_ready at 0.46 was cached, the screen
  // stayed put, and the same rejected answer came back every tick for good.
  const weak = { screen_state: { type: 'choice', choice: 'idle_ready', confidence: 0.46 } }
  const h = observerHarness({ answers: [weak], observer: { intervalMs: 2000 } })
  h.screens.set('%1', 'finished\nline two\nline three')
  for (let i = 0; i < 8; i++) {
    await h.tick(paneStatus())
    h.advance(40000)
  }
  assert.strictEqual(h.calls.length, 3, 'the first answer and two more')
  assert.strictEqual(h.observer.stats().reasks, 2)

  // A different rejected screen has its own allowance.
  h.screens.set('%1', 'another\nline two\nline three')
  for (let i = 0; i < 8; i++) {
    await h.tick(paneStatus())
    h.advance(40000)
  }
  assert.strictEqual(h.calls.length, 6)
  h.cleanup()
})

test('a re-asked screen that is accepted moves the session and stops the re-asking', async () => {
  const weak = { screen_state: { type: 'choice', choice: 'idle_ready', confidence: 0.46 } }
  const h = observerHarness({ answers: [weak, sampleAnswers('idle_ready')], observer: { intervalMs: 2000 } })
  h.screens.set('%1', 'finished\nline two\nline three')
  const emitted = []
  for (let i = 0; i < 6; i++) {
    emitted.push(...await h.tick(paneStatus()))
    h.advance(40000)
  }
  assert.strictEqual(h.calls.length, 2)
  assert.ok(emitted.some(item => item.event.type === AGENT_EVENTS.TURN_COMPLETE), 'the accepted answer completes the turn')
  h.cleanup()
})

test('an unreadable screen is not asked again', async () => {
  // `unknown` is the model saying there is nothing to decide; asking again
  // buys the same answer.
  const unreadable = { screen_state: { type: 'choice', choice: 'unknown', confidence: 0.9 } }
  const h = observerHarness({ answers: [unreadable], observer: { intervalMs: 2000 } })
  for (let i = 0; i < 6; i++) {
    await h.tick(paneStatus())
    h.advance(40000)
  }
  assert.strictEqual(h.calls.length, 1)
  h.cleanup()
})

test('a paid answer landing wakes the watcher; a cached one does not', async () => {
  let woken = 0
  const h = observerHarness({ observer: { onReading: () => woken++ } })
  await h.tick(paneStatus())
  assert.strictEqual(woken, 1)
  h.advance(40000)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1, 'the same screen is answered from cache')
  assert.strictEqual(woken, 1)
  h.cleanup()
})

test('every pane a tick reads is captured in one call', async () => {
  const batches = []
  const captureMany = paneIds => {
    batches.push(paneIds)
    return new Map(paneIds.map(paneId => {
      const text = `${paneId} one\ntwo\nthree`
      return [paneId, { paneId, raw: text, text, fingerprint: `fp:${paneId}` }]
    }))
  }
  const h = observerHarness({ observer: { captureMany } })
  const status = { sessions: {} }
  for (const n of [1, 2, 3]) {
    status.sessions[`s${n}`] = { sessionId: `s${n}`, agentType: 'claude', tmuxPane: `%${n}`, phase: 'running', status: 'working', stateEvidence: [] }
  }
  await h.tick(status)
  assert.deepStrictEqual(batches, [['%1', '%2', '%3']])
  assert.strictEqual(h.calls.length, 3)
  h.cleanup()
})

test('capturePanes reads many panes in one tmux call and resumes after one that closed', () => {
  const { capturePanes } = require('../scripts/lib/pane-capture')
  // %2 closed after it was listed. tmux prints the marker for it with an empty
  // pane id, then stops the whole sequence at its capture-pane.
  const screens = { '%1': 'one\n\n', '%3': 'three\n' }
  const runs = []
  const run = args => {
    runs.push(args)
    let stdout = ''
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'display-message') {
        stdout += args[i + 4].replace('#{pane_id}', screens[args[i + 3]] ? args[i + 3] : '') + '\n'
      } else if (args[i] === 'capture-pane') {
        if (!screens[args[i + 4]]) return { status: 1, stdout }
        stdout += screens[args[i + 4]]
      }
    }
    return { status: 0, stdout }
  }
  const captures = capturePanes(['%1', '%2', '%3'], 40, run)
  assert.deepStrictEqual([...captures.keys()], ['%1', '%3'])
  assert.strictEqual(captures.get('%1').raw, 'one', 'trailing blank rows trimmed as for a single capture')
  assert.strictEqual(captures.get('%3').raw, 'three')
  assert.strictEqual(runs.length, 2)
  assert.ok(!runs[1].includes('%1') && !runs[1].includes('%2'), 'the second call reads only what the first did not reach')
  // Unavailable tmux reads nothing rather than throwing into the tick.
  assert.strictEqual(capturePanes(['%1'], 40, () => ({ error: new Error('ENOENT'), stdout: null })).size, 0)
})

test('the tick timer wakes early on a landed answer, but not sooner than its minimum gap', async () => {
  const { createTickTimer } = require('../scripts/watcher')
  const timer = createTickTimer()
  let started = Date.now()
  const woken = timer.sleep(2000, 60)
  setTimeout(() => timer.wake(), 5)
  await woken
  const early = Date.now() - started
  assert.ok(early >= 55 && early < 1000, `woke after ${early}ms`)

  // A wake between sleeps is not carried into the next one.
  timer.wake()
  started = Date.now()
  await timer.sleep(150, 10)
  assert.ok(Date.now() - started >= 140, 'a sleep nobody wakes runs its full length')
})

test('a cached answer with a different verdict ends the backoff', async () => {
  // The screen went back to one seen before, so the change was answered from
  // cache — but it is still a change, and the backoff built on the old verdict
  // held the next paid read at the ceiling.
  const answers = [sampleAnswers('idle_ready')].concat(Array(6).fill(sampleAnswers('working')))
  const h = observerHarness({ answers, observer: { intervalMs: 2000 } })
  const show = text => h.screens.set('%1', `${text}\nline two\nline three`)
  show('the idle screen')
  await h.tick(paneStatus())
  for (let i = 0; i < 5; i++) {
    h.advance(40000)
    show(`streaming ${i}`)
    await h.tick(paneStatus())
  }
  assert.strictEqual(h.calls.length, 6)
  h.advance(100)
  show('the idle screen')
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 6, 'served from cache')
  h.advance(2400)
  show('a new screen')
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 7)
  h.cleanup()
})

test('paid reads go to the session that has waited longest', async () => {
  // Capture order is the same every tick when the capture cap is not binding,
  // so with the concurrency cap binding the first pane took the only slot on
  // every tick and the others were never read.
  let n = 0
  const capture = paneId => {
    const text = `${paneId} screen ${n++}\nline two\nline three`
    return { paneId, raw: text, text, fingerprint: `fp:${text}` }
  }
  const h = observerHarness({ observer: { capture, concurrency: 1, intervalMs: 2000 } })
  const status = { sessions: {} }
  for (const i of [1, 2, 3]) {
    status.sessions[`s${i}`] = {
      sessionId: `s${i}`, agentType: 'claude', tmuxPane: `%${i}`, phase: 'running', status: 'working',
      startedAt: 1000 + i, stateEvidence: []
    }
  }
  const served = new Set()
  for (let i = 0; i < 3; i++) {
    h.advance(2000)
    await h.tick(status)
    served.add(h.calls[h.calls.length - 1].screen.split(' ')[0])
  }
  assert.strictEqual(h.calls.length, 3)
  assert.deepStrictEqual([...served].sort(), ['%1', '%2', '%3'])
  h.cleanup()
})

test('a settings rebuild keeps readings not yet drained and the counters', async () => {
  // Paid for, landed, not yet applied: dropped with the old observer, and the
  // counters restarted at zero next to inherited spend.
  const h = observerHarness()
  await h.tick(paneStatus({ phase: 'idle', status: 'idle' }))
  assert.strictEqual(h.calls.length, 1)

  const rebuilt = observerHarness({ store: h.storeDir, observer: h.observer.handoff() })
  const events = rebuilt.observer.drain()
  assert.ok(events.length > 0, 'the landed reading is applied by the replacement')
  assert.strictEqual(rebuilt.observer.stats().calls, 1)
  h.cleanup()
})

test('a throttled screen is never parsed', async () => {
  // Prompt and title extraction ran for every captured pane before the throttle
  // decided nothing would be done with them.
  let reads = 0
  let n = 0
  const capture = paneId => {
    const text = `screen ${n++}\nline two\nline three`
    return { paneId, text, fingerprint: `fp:${text}`, get raw() { reads++; return text } }
  }
  const h = observerHarness({ observer: { capture, intervalMs: 2000 } })
  await h.tick(paneStatus())
  const afterCall = reads
  h.advance(100)
  await h.tick(paneStatus())
  assert.strictEqual(reads, afterCall)
  h.cleanup()
})

test('shadow rows repeat at a heartbeat while nothing changes', async () => {
  // The agreement report weighs each row by the time until the next one. Rows
  // written only on a change leave a long agreeing stretch looking like one
  // instant, and a burst of flapping outweighing it.
  const h = observerHarness({ observer: { mode: 'shadow' } })
  for (let i = 0; i < 8; i++) {
    await h.tick(paneStatus())
    h.advance(10000)
  }
  assert.strictEqual(h.shadowRows().length, 2)
  h.cleanup()
})

test('pane agreement is reported over time, not over rows', () => {
  const home = tempDir()
  try {
    const now = Date.now()
    const t0 = now - 600000
    const row = (at, verdict, modelPhase) => JSON.stringify({
      at, sessionId: 's1', agentType: 'claude', hookPhase: 'running', verdict, modelPhase, gate: 'accept'
    })
    const rows = [row(t0, 'working', 'running')]
    for (let i = 0; i < 10; i++) rows.push(row(t0 + 60000 + i * 1000, 'idle_ready', 'completed'))
    rows.push(row(t0 + 70000, 'working', 'running'))
    fs.mkdirSync(path.join(home, '.tmux-scout'), { recursive: true })
    fs.writeFileSync(path.join(home, '.tmux-scout', 'pane-agreement.jsonl'), rows.join('\n') + '\n')
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'debug.js'), 'pane-agreement'], {
      encoding: 'utf-8', env: Object.assign({}, process.env, { HOME: home })
    })
    // Two agreeing minutes against ten disagreeing seconds, not 2 rows of 12.
    assert.ok(/agreement 92% of observed time/.test(out), out)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

function fakeTmuxEnv(home, options) {
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const cases = Object.entries(options).map(([name, value]) => `  *${name}*) echo '${value}' ;;`).join('\n')
  fs.writeFileSync(path.join(bin, 'tmux'), [
    '#!/bin/sh',
    'case "$*" in',
    '  -V) echo "tmux 3.4" ;;',
    '  show-option*)',
    '    case "$*" in',
    cases,
    '    esac ;;',
    '  *) exit 1 ;;',
    'esac',
    ''
  ].join('\n'), { mode: 0o755 })
  const env = Object.assign({}, process.env, { HOME: home, PATH: `${bin}:${process.env.PATH}` })
  delete env.TYPESAFE_API_KEY
  delete env.TMUX
  return env
}

test('a missing key fails the doctor only when the screen is the state source', () => {
  // Shadow changes nothing; a missing prerequisite there is worth a warning,
  // not a failed health check.
  const doctor = path.join(__dirname, '..', 'scripts', 'doctor.js')
  const clientLine = options => {
    const home = tempDir()
    try {
      const result = require('child_process').spawnSync(process.execPath, [doctor], {
        encoding: 'utf-8', env: fakeTmuxEnv(home, options)
      })
      return result.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find(line => / client - /.test(line)) || ''
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  assert.ok(clientLine({ '@scout-pane-model': 'shadow' }).includes('[WARN] client'))
  assert.ok(clientLine({ '@scout-state-source': 'jev' }).includes('[FAIL] client'))
})

test('a one-off watcher tick honours the observations the running watcher persisted', () => {
  // `watcher.js once` has no observer, so it ran the idle sweep with no record
  // of what was being watched and completed a session frozen on a long command.
  const once = observedAt => {
    const home = tempDir()
    try {
      const scout = path.join(home, '.tmux-scout')
      fs.mkdirSync(scout, { recursive: true })
      const now = Date.now()
      fs.writeFileSync(path.join(scout, 'status.json'), JSON.stringify({ version: 1, lastUpdated: now, sessions: {
        s1: { sessionId: 's1', agentType: 'claude', phase: 'running', status: 'working',
          startedAt: now - 600000, lastUpdated: now - 300000, stateEvidence: [] }
      } }))
      if (observedAt) fs.writeFileSync(path.join(scout, 'pane-observed.json'), JSON.stringify({ s1: now - observedAt }))
      execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'watcher.js'), 'once'], {
        env: fakeTmuxEnv(home, { '@scout-state-source': 'jev' }), stdio: 'ignore'
      })
      return JSON.parse(fs.readFileSync(path.join(scout, 'status.json'), 'utf-8')).sessions.s1.phase
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  assert.strictEqual(once(1000), 'running')
  assert.strictEqual(once(null), 'completed', 'without an observation the fallback still applies')
})

test('a cache write that fails leaves no temp file behind', () => {
  const { writeCache } = require('../scripts/lib/pane-store')
  const dir = tempDir()
  try {
    // A directory where the file should be: the temp write succeeds and the
    // rename over it fails.
    const target = path.join(dir, 'pane-cache.json')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'occupied'), '')
    assert.strictEqual(writeCache({ k: { at: 1 } }, target), false)
    assert.deepStrictEqual(fs.readdirSync(dir), ['pane-cache.json'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- review round 7 ---

test('a child session never takes its parent\'s screen', async () => {
  // Child records share the parent's pane and fire hooks of their own, so the
  // child is usually the most recently active record there. An approval read
  // off the parent's screen landed on the hidden child, and the row the user
  // sees never moved.
  const h = observerHarness({ answers: [confidently('awaiting_approval')] })
  const status = { sessions: {
    parent: { sessionId: 'parent', agentType: 'claude', tmuxPane: '%1', phase: 'running', status: 'working',
      startedAt: 1000, lastHookAt: 1000, stateEvidence: [] },
    child: { sessionId: 'child', parentSessionId: 'parent', agentType: 'claude', tmuxPane: '%1', phase: 'running',
      status: 'working', startedAt: 2000, lastHookAt: 3000, stateEvidence: [] }
  } }
  await h.tick(status)
  const events = await h.tick(status)
  assert.ok(events.length > 0)
  assert.deepStrictEqual([...new Set(events.map(entry => entry.sessionId))], ['parent'])
  h.cleanup()
})

test('a cancel marker left on screen does not interrupt a session never prompted', () => {
  // idle_ready plus a visible marker is upgraded to interrupted, which slipped
  // past the guard written only for completed.
  const session = { sessionId: 's1', agentType: 'claude', phase: 'idle', status: 'idle', stateEvidence: [] }
  const marked = confidently('idle_ready', { interrupt_marker_visible: { noul: 0.9 } })
  assert.deepStrictEqual(paneEvents(marked, session), [])
  const prompted = Object.assign({}, session, { lastUserPrompt: 'do the thing' })
  assert.deepStrictEqual(paneEvents(marked, prompted).map(event => event.type), [AGENT_EVENTS.INTERRUPTED])
})

test('a prompt left on screen by the pane\'s previous process is not the new session\'s', async () => {
  // Codex draws inline, so a restart lands below the previous run's prompt.
  // Read as this session's, it titled the new session with it and showed DONE
  // for a turn that never happened.
  const screen = prompt => [
    `› ${prompt}`,
    '  some output from that turn',
    '─ Worked for 1m 02s ──────────────────────',
    '› Ask Codex to do anything',
    '  gpt · repo · main · Ready'
  ].join('\n')
  const h = observerHarness({ answers: [confidently('idle_ready')] })
  // The previous run, read while it was alive.
  const previous = paneStatus({ agentType: 'codex', phase: 'completed', status: 'completed', startedAt: 1000,
    lastUserPrompt: 'the previous run\'s prompt' })
  h.screens.set('%1', screen('the previous run\'s prompt'))
  await h.tick(previous)
  await h.tick(previous)

  // Restarted in the pane: a new instance under the same discovery id.
  const status = paneStatus({ agentType: 'codex', phase: 'idle', status: 'idle', startedAt: 5000 })
  h.screens.set('%1', screen('the previous run\'s prompt') + '\n')
  h.advance(7000)
  await h.tick(status)
  assert.deepStrictEqual(await h.tick(status), [])

  h.screens.set('%1', screen('a prompt sent to this session'))
  h.advance(7000)
  await h.tick(status)
  const events = await h.tick(status)
  assert.deepStrictEqual(events.map(entry => entry.event.type), [AGENT_EVENTS.TURN_COMPLETE])
  assert.strictEqual(events[0].event.updates.lastUserPrompt, 'a prompt sent to this session')
  h.cleanup()
})

test('a pid flip while the old process lives keeps the session where it was', () => {
  // The process-tree walk can settle on a wrapper one tick and its child the
  // next. That was sent as DISCOVERED, which resets to idle and hands the row
  // back to pane-discovery — hidden in the picker, flickering with every flip.
  const opts = { writeSession: false, writeStatus: false }
  const first = discoveryFixture('agent')
  const status = { version: 1, lastUpdated: first.now, sessions: {} }
  sync.discoverPaneSessions(status, first.panes, first.table, sync.createStats(), Object.assign({ now: first.now }, opts))
  const id = sync.discoverySessionId('claude', '%88')
  const session = status.sessions[id]
  applySessionEvent(session, {
    type: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE, source: 'pane-model', stateSource: 'pane-model', timestamp: first.now + 1
  })
  const startedAt = session.startedAt

  // The walk now settles on the binary the wrapper started.
  const flipped = processTableOf([
    { pid: 556050, ppid: 1, command: '/bin/zsh' },
    { pid: 556051, ppid: 556050, command: 'node' },
    // Started a moment after the wrapper, as a child is.
    { pid: 556052, ppid: 556051, command: '/opt/homebrew/bin/claude', startedAtMs: first.now - 100000 }
  ])
  sync.discoverPaneSessions(status, first.panes, flipped, sync.createStats(), Object.assign({ now: first.now + 2000 }, opts))
  const after = status.sessions[id]
  assert.strictEqual(after.pid, 556052, 'the new pid is still recorded')
  assert.strictEqual(currentPhase(after), 'running')
  assert.strictEqual(after.stateSource, 'pane-model')
  // Kept too: anything keyed on the instance would otherwise see a new one.
  assert.strictEqual(after.startedAt, startedAt)
})

test('dialog details are extracted in the form the reducer stores them', () => {
  // Cut at 200 characters, a detail ending in a space never equalled the
  // trimmed stored value, so every tick re-sent the wait and rewrote the file.
  const args = 'a'.repeat(193) + ' and the rest of a long command'
  const raw = [`⏺ Bash(${args})`, '  ⎿  Waiting…', '', '│ Do you want to proceed?'].join('\n')
  const { details } = extractToolLine(raw, 'claude')
  assert.strictEqual(details, details.trim())

  const session = { sessionId: 's1', agentType: 'claude', phase: 'running', status: 'working', stateEvidence: [] }
  const extracted = { pendingDetails: details }
  for (const event of paneEvents(confidently('awaiting_approval'), session, { options: { extracted } })) {
    applySessionEvent(session, event)
  }
  assert.strictEqual(currentPhase(session), 'waitingForApproval')
  assert.deepStrictEqual(paneEvents(confidently('awaiting_approval'), session, { options: { extracted, now: 3000 } }), [])
})

test('an approval is not described by a tool call that already finished', () => {
  // Scanning up for the nearest tool line found the one before the prose, so
  // a Bash approval was shown as the Read that completed a minute earlier.
  const dialog = ['╭──────────────────────╮', '│ Bash command         │', '│ Do you want to proceed?', '╰──────────────────────╯']
  const finished = ['⏺ Read(src/a.ts)', '  ⎿  Read 40 lines', '', '⏺ I need to run the migration script.', '', ...dialog].join('\n')
  assert.deepStrictEqual(extractToolLine(finished, 'claude'), {})
  const pending = ['⏺ Read(src/a.ts)', '  ⎿  Read 40 lines', '', '⏺ Bash(./migrate.sh --apply)', '  ⎿  Waiting…', '', ...dialog].join('\n')
  assert.strictEqual(extractToolLine(pending, 'claude').details, 'Bash: ./migrate.sh --apply')
})

test('a throwing response handler releases its request slot once', async () => {
  // .then(handler).catch(handler) ran the rejection handler too when the
  // success handler threw, releasing the slot twice: inFlight went negative
  // and the concurrency cap stopped holding.
  const metrics = {
    configure() {},
    recordCall() { throw new Error('metrics broke') },
    snapshot() { return {} }
  }
  const h = observerHarness({ observer: { metrics } })
  await h.tick(paneStatus())
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(h.observer.handoff().schedule.inFlight, 0)
  h.cleanup()
})

test('a settings poll that cannot read tmux keeps the running observer', () => {
  // An unreadable option read as unset, which means off: one tmux hiccup tore
  // the observer down with its spend report, cooldown and token bucket.
  const { pollPaneSettings } = require('../scripts/watcher')
  const running = fakePaneObserver(true, 'running')
  const pane = { settings: { mode: 'on' }, signature: JSON.stringify({ mode: 'on' }), observer: running }
  const logs = []
  const after = pollPaneSettings(pane, {
    read: () => { throw new Error('no server running') },
    log: line => logs.push(line),
    start: () => { throw new Error('must not rebuild') }
  })
  assert.strictEqual(after, pane)
  assert.strictEqual(running.closed, false)
  assert.strictEqual(logs.length, 1)

  // And the reader the watcher polls with does throw, where the lenient one
  // reports an unset option.
  const home = tempDir()
  try {
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const out = execFileSync(process.execPath, ['-e', `
      const s = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib', 'state-source'))})
      let strict = 'returned'
      try { s.readTmuxOptionStrict('@scout-state-source') } catch (_) { strict = 'threw' }
      console.log(JSON.stringify({ lenient: s.readTmuxOption('@scout-state-source'), strict }))
    `], { encoding: 'utf-8', env: Object.assign({}, process.env, { PATH: `${bin}:${process.env.PATH}` }) })
    assert.deepStrictEqual(JSON.parse(out), { lenient: '', strict: 'threw' })
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a key the watcher cannot see fails the doctor in jev mode', () => {
  // Exported only in a login shell: doctor sees it, the watcher — started by
  // tmux run-shell — does not, and in jev mode nothing updates phase.
  const doctor = path.join(__dirname, '..', 'scripts', 'doctor.js')
  const keyLine = options => {
    const home = tempDir()
    try {
      const env = fakeTmuxEnv(home, options)
      env.TYPESAFE_API_KEY = 'not-a-real-key'
      const result = require('child_process').spawnSync(process.execPath, [doctor], { encoding: 'utf-8', env })
      return result.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find(line => / API key - /.test(line)) || ''
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  assert.ok(keyLine({ '@scout-state-source': 'jev' }).includes('[FAIL] API key'))
  assert.ok(keyLine({ '@scout-pane-model': 'shadow' }).includes('[WARN] API key'))
})

test('jev-metrics leaves failed calls out of latency and projects no rate from seconds', () => {
  const home = tempDir()
  try {
    const now = Date.now()
    fs.mkdirSync(path.join(home, '.tmux-scout'), { recursive: true })
    fs.writeFileSync(path.join(home, '.tmux-scout', 'pane-metrics.jsonl'), [
      { at: now - 3000, ok: false, error: 'threw', ms: null },
      { at: now - 2000, ok: false, error: 'threw', ms: null },
      { at: now - 1000, ok: true, ms: 640, inputTokens: 2000 }
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'debug.js'), 'jev-metrics'], {
      encoding: 'utf-8', env: Object.assign({}, process.env, { HOME: home })
    })
    assert.ok(/p50 640ms/.test(out), out)
    assert.ok(!/\/month/.test(out), out)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('setup status in jev mode checks only the agents the pane model does not read', () => {
  const home = tempDir()
  const status = (...args) => require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'setup.js'), 'status', ...args],
    { encoding: 'utf-8', env: fakeTmuxEnv(home, { '@scout-state-source': 'jev' }) })
  try {
    // Read from the pane: no hooks on purpose, so nothing is missing.
    const covered = status('--claude', '--codex')
    assert.strictEqual(covered.status, 0, covered.stdout + covered.stderr)
    // Not read from the pane: its hooks are its only source of state.
    const kimi = status('--kimi')
    assert.strictEqual(kimi.status, 1, kimi.stdout)
    assert.ok(/Kimi/.test(kimi.stdout))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// --- review round 8 ---

test('a prompt on screen the first time a pane is read is taken as the session\'s', async () => {
  // With no earlier process seen in the pane there is nothing to have inherited
  // it from. Set aside anyway, a session whose first turn finished before it was
  // read stayed an idle, hidden placeholder for good.
  const screen = [
    '› summarize the repo',
    '  here is the summary',
    '─ Worked for 12s ──────────────────────',
    '› Ask Codex to do anything',
    '  gpt · repo · main · Ready'
  ].join('\n')
  const h = observerHarness({ answers: [confidently('idle_ready')] })
  const status = paneStatus({ agentType: 'codex', phase: 'idle', status: 'idle', startedAt: 5000 })
  h.screens.set('%1', screen)
  await h.tick(status)
  const events = await h.tick(status)
  assert.deepStrictEqual(events.map(entry => entry.event.type), [AGENT_EVENTS.TURN_COMPLETE])
  assert.strictEqual(events[0].event.updates.lastUserPrompt, 'summarize the repo')
})

test('an answer landing after a rebuild is still written to disk', async () => {
  // The dirty flag lived in the observer that sent the request. The answer went
  // into the shared cache, but only the closed observer knew it was unsaved.
  let resolve
  const client = {
    available: true,
    reason: null,
    classify: () => new Promise(done => { resolve = done })
  }
  const h = observerHarness({ observer: { client } })
  await h.tick(paneStatus())
  const rebuilt = observerHarness({ store: h.storeDir, observer: h.observer.handoff() })
  h.observer.close()
  resolve({ ok: true, answers: sampleAnswers('working'), usage: { input_tokens: 10 }, model: 'jev-1' })
  await new Promise(done => setImmediate(done))
  rebuilt.observer.close()
  const written = JSON.parse(fs.readFileSync(path.join(h.storeDir, 'pane-cache.json'), 'utf-8'))
  assert.strictEqual(Object.keys(written).length, 1)
})

test('a replacement that fails to build leaves the running observer running', () => {
  const { pollPaneSettings } = require('../scripts/watcher')
  const running = fakePaneObserver(true, 'running')
  const pane = { settings: { mode: 'shadow' }, signature: JSON.stringify({ mode: 'shadow' }), observer: running }
  const after = pollPaneSettings(pane, {
    read: name => (name === '@scout-state-source' ? 'jev' : ''),
    log: () => {},
    start: () => { throw new Error('bad options') }
  })
  assert.strictEqual(after.observer, running)
  assert.strictEqual(running.closed, false, 'closed, it reported ready while dispatching nothing')
})

test('in jev mode an agent the pane model does not read keeps its hooks', () => {
  // Skipping every hook left kimi, opencode and the rest with no state at all.
  const home = tempDir()
  const setup = (...args) => require('child_process').spawnSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'setup.js'), ...args],
    { encoding: 'utf-8', env: fakeTmuxEnv(home, { '@scout-state-source': 'jev' }) })
  try {
    const claude = setup('install', '--claude')
    assert.ok(/read from the pane, so they get no hooks/.test(claude.stdout), claude.stdout)
    assert.strictEqual(fs.existsSync(path.join(home, '.claude', 'settings.json')), false)

    const kimi = setup('install', '--kimi')
    assert.ok(!/get no hooks/.test(kimi.stdout), kimi.stdout)
    assert.strictEqual(setup('status', '--kimi').status, 0, 'installed like in hook mode')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a startup screen does not start a turn in a session never prompted', () => {
  // A spinner while MCP servers boot reads as working. Once that moved the
  // session to running, the never-prompted guard no longer applied, and the
  // composer that followed completed a turn nobody sent.
  const session = { sessionId: 's1', agentType: 'codex', phase: 'idle', status: 'idle', stateEvidence: [] }
  const booting = { confidence: 'none', composer: true }
  assert.deepStrictEqual(paneEvents(confidently('working'), session, { options: { extracted: booting } }), [])
  // Where the composer was not found, a missing prompt proves nothing.
  const unknown = { confidence: 'none', composer: false }
  assert.deepStrictEqual(paneEvents(confidently('working'), session, { options: { extracted: unknown } })
    .map(event => event.type), [AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE])
  const prompted = { lastUserPrompt: 'fix the build', sessionTitle: 'fix the build', composer: true }
  assert.deepStrictEqual(paneEvents(confidently('working'), session, { options: { extracted: prompted } })
    .map(event => event.type), [AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE])
})

test('the extractor reports whether it found the composer', () => {
  const { extractPromptAndTitle: extract } = require('../scripts/lib/pane-text-extract')
  assert.strictEqual(extract(['  Booting MCP server: github', '› Ask Codex to do anything', '  gpt · repo'].join('\n'), 'codex').composer, true)
  assert.strictEqual(extract('  only output here\n  and more\n  and more', 'codex').composer, false)
})

test('a reading built for a replaced record is not applied to its successor', () => {
  // Discovery ids are per pane. A restart between capture and apply left the
  // old instance's events — its guards, its prompt — landing on the new one.
  const session = { sessionId: 'd1', agentType: 'codex', phase: 'idle', status: 'idle', startedAt: 9000, stateEvidence: [] }
  const stats = sync.createStats()
  sync.applyPaneEvents({ version: 1, sessions: { d1: session } }, [{
    sessionId: 'd1',
    startedAt: 1000,
    event: { type: AGENT_EVENTS.TURN_COMPLETE, source: 'pane-model', stateSource: 'pane-model', timestamp: 9500,
      updates: { lastUserPrompt: 'the old run\'s prompt' } }
  }], stats)
  assert.strictEqual(currentPhase(session), 'idle')
  assert.strictEqual(session.lastUserPrompt, undefined)
  assert.strictEqual(stats.paneModel.superseded, 1)
})

test('a wait whose tool fixes it as a plan is not re-sent over its subtype', () => {
  // The reducer derives the subtype from a recorded ExitPlanMode before any
  // reason an event carries, so a reading of `approval` could never take —
  // and was re-sent every tick, rewriting the session file each time.
  const session = {
    sessionId: 's1', agentType: 'claude', phase: 'waitingForApproval', status: 'working',
    pendingToolUse: { tool: 'ExitPlanMode', details: 'ExitPlanMode' },
    pendingInteraction: { type: 'plan', phase: 'waitingForApproval', details: 'ExitPlanMode', startedAt: 500 },
    stateEvidence: []
  }
  assert.deepStrictEqual(paneEvents(confidently('awaiting_approval'), session), [])
  // With no tool recorded, the screen's subtype is the only one there is.
  const unpinned = Object.assign({}, session, { pendingToolUse: null })
  assert.strictEqual(paneEvents(confidently('awaiting_approval'), unpinned).length, 1)
})

test('a rejected key is replaced once a different one can be found', () => {
  // tmux set-environment does not reach a client already built, so a rotated
  // key left every call a 401 until the watcher was restarted by hand.
  const { refreshPaneObserver } = require('../scripts/watcher')
  const failing = Object.assign(fakePaneObserver(true, 'failing'), {
    stats: () => ({ available: true, authFailing: true, keyId: 'old' })
  })
  const current = { settings: { mode: 'on' }, signature: JSON.stringify({ mode: 'on' }), observer: failing }
  const starts = []
  const deps = key => ({
    log: () => {},
    probe: () => ({ available: true, keyId: key, model: 'jev-1' }),
    start: (settings, carry) => { starts.push(carry.client.keyId); return fakePaneObserver(true, 'new') }
  })
  assert.strictEqual(refreshPaneObserver(current, { mode: 'on' }, deps('old')), current, 'the same key would fail again')
  assert.strictEqual(starts.length, 0)
  const next = refreshPaneObserver(current, { mode: 'on' }, deps('new'))
  assert.notStrictEqual(next, current)
  assert.deepStrictEqual(starts, ['new'])
  assert.strictEqual(failing.closed, true)
})

test('an authentication failure is reported until a call succeeds again', async () => {
  const h = observerHarness({ answers: [new Error('auth')] })
  await h.tick(paneStatus())
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(h.observer.stats().authFailing, true)
})

test('a rotated key in the tmux environment wins over the one this process started with', () => {
  const home = tempDir()
  try {
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho "TYPESAFE_API_KEY=rotated-key"\n', { mode: 0o755 })
    const out = execFileSync(process.execPath, ['-e', `
      const { resolveApiKey } = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib', 'jev-client'))})
      console.log(resolveApiKey(null))
    `], { encoding: 'utf-8', env: Object.assign({}, process.env, {
      HOME: home, PATH: `${bin}:${process.env.PATH}`, TYPESAFE_API_KEY: 'startup-key'
    }) })
    assert.strictEqual(out.trim(), 'rotated-key')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a Node too old for the SDK is not probed again every poll', () => {
  const { refreshPaneObserver } = require('../scripts/watcher')
  const stuck = Object.assign(fakePaneObserver(false, 'stuck'), {
    stats: () => ({ available: false, reason: 'node-too-old' })
  })
  const current = { settings: { mode: 'on' }, signature: JSON.stringify({ mode: 'on' }), observer: stuck }
  assert.strictEqual(refreshPaneObserver(current, { mode: 'on' }, {
    log: () => {},
    probe: () => { throw new Error('probed, forking tmux for nothing') }
  }), current)
})

test('the SDK is an optional dependency', () => {
  // It needs Node 20; the plugin supports 16. As a hard dependency, npm with
  // engine-strict refused to install the plugin at all on 16 and 18.
  const pkg = require('../package.json')
  assert.ok(!pkg.dependencies || !pkg.dependencies['@typesafe-ai/sdk'])
  assert.ok(pkg.optionalDependencies['@typesafe-ai/sdk'])
})

test('shadow mode never parses the screen', async () => {
  let reads = 0
  const capture = paneId => {
    const text = 'agent line one\nagent line two\nagent line three'
    return { paneId, text, fingerprint: `fp:${text}`, get raw() { reads++; return text } }
  }
  const h = observerHarness({ observer: { mode: 'shadow', capture } })
  await h.tick(paneStatus())
  await h.tick(paneStatus())
  assert.strictEqual(reads, 0)
})

test('fixtures are scored through the same capture pipeline as live panes', () => {
  // jev-eval normalized the whole fixture, so anything past the last 40 lines
  // was sent to the model in evaluation and never in production.
  const { captureFromText, DEFAULT_TAIL_LINES } = require('../scripts/lib/pane-capture')
  const long = Array.from({ length: DEFAULT_TAIL_LINES + 20 }, (_, i) => `line ${i}`).join('\n') + '\n\n'
  const captured = captureFromText('%1', long)
  assert.strictEqual(captured.text.split('\n').length, DEFAULT_TAIL_LINES)
  assert.ok(captured.text.endsWith(`line ${DEFAULT_TAIL_LINES + 19}`))
  const evalSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dev', 'jev-eval.js'), 'utf-8')
  assert.ok(/captureFromText\(/.test(evalSource))
})

// --- live test round ---

test('a 403 for one screen is not reported as a bad key', async () => {
  // Every other pane was answered with the same key. Counted as `auth`, it read
  // as a broken key and flagged the whole client for a rebuild.
  const failing = status => createJevClient({
    apiKey: 'test-key',
    sdk: { TypeSafeClient: class { async systemOne() { throw Object.assign(new Error('refused'), { status }) } } }
  })
  const refused = await failing(403).classify({}, {})
  assert.strictEqual(refused.errorKind, 'forbidden')
  assert.strictEqual(refused.status, 403)
  assert.strictEqual((await failing(401).classify({}, {})).errorKind, 'auth')
})

test('a screen the API refused is not re-sent until it changes', async () => {
  // Retried on the error backoff, one pane showing key material was re-sent
  // every minute for as long as it stayed on screen.
  const h = observerHarness({ answers: [new Error('forbidden'), sampleAnswers('working')] })
  await h.tick(paneStatus())
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(h.observer.stats().authFailing, false, 'the key is fine')
  h.advance(120000)
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1)
  h.screens.set('%1', 'a different screen\nline two\nline three')
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 2)
})

test('the watcher logs why it stopped', async () => {
  // Run under tmux run-shell -b, its stderr goes nowhere: a signal or an
  // uncaught error used to leave a clean exit and no trace in the log.
  const home = tempDir()
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'watcher.js'), 'run'], {
    env: fakeTmuxEnv(home, {}), stdio: 'ignore'
  })
  const logFile = path.join(home, '.tmux-scout', 'watcher.log')
  const started = Date.now()
  while (Date.now() - started < 10000) {
    if (fs.existsSync(logFile) && /started pid=/.test(fs.readFileSync(logFile, 'utf-8'))) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  child.kill('SIGTERM')
  await new Promise(resolve => child.on('exit', resolve))
  assert.ok(/stopped by SIGTERM/.test(fs.readFileSync(logFile, 'utf-8')))
})

test('an empty call log is not reported as the pane model being off', () => {
  // "no jev calls logged" read as "jev is not running" while it was making
  // calls: the per-call log is opt-in, the live totals are always kept.
  const home = tempDir()
  try {
    fs.mkdirSync(path.join(home, '.tmux-scout'), { recursive: true })
    fs.writeFileSync(path.join(home, '.tmux-scout', 'watcher-state.json'),
      JSON.stringify({ paneModel: { jev: { calls: 34 } } }))
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'debug.js'), 'jev-metrics'], {
      encoding: 'utf-8', env: fakeTmuxEnv(home, {})
    })
    assert.ok(/pane model is running: 34 calls/.test(out), out)
    assert.ok(/per-call logging is off/.test(out), out)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a wait whose pane was closed does not wait forever', () => {
  // The exit was refused on every pass — a wait only ends on its matching
  // resolution, and nothing is left to send one. The status bar counted it as
  // WAIT for days while the picker, which asks tmux, showed nothing.
  const panes = new Map()
  panes.tmuxAvailable = true
  for (const [phase, pending] of [['waitingForAnswer', 'question'], ['waitingForApproval', 'approval']]) {
    const session = {
      sessionId: 'w1', agentType: 'codex', phase, status: 'working', tmuxPane: '%15',
      pendingInteraction: { type: pending, phase }, stateEvidence: []
    }
    sync.sweepVanishedPanes({ version: 1, sessions: { w1: session } }, panes, sync.createStats())
    assert.strictEqual(currentPhase(session), 'stale', phase)
  }
})

test('a wait whose process died does not wait forever', () => {
  const panes = new Map([['%15', { paneId: '%15', panePid: 4194303, paneDead: false }]])
  panes.tmuxAvailable = true
  const session = {
    sessionId: 'w1', agentType: 'claude', phase: 'waitingForApproval', status: 'working', tmuxPane: '%15',
    pid: 4194305, pendingInteraction: { type: 'approval', phase: 'waitingForApproval' }, stateEvidence: []
  }
  sync.sweepDeadProcesses({ version: 1, sessions: { w1: session } }, panes, processTableOf([]), sync.createStats())
  assert.strictEqual(currentPhase(session), 'interrupted')
})

test('the state source is either hooks or the pane model, never both', () => {
  const { STATE_SOURCES, stateSource } = require('../scripts/lib/state-source')
  // Unset means hooks: that is what every install predating this option had.
  assert.strictEqual(stateSource(() => ''), STATE_SOURCES.HOOK)
  assert.strictEqual(stateSource(() => 'JEV'), STATE_SOURCES.JEV)
  assert.strictEqual(stateSource(() => ' jev '), STATE_SOURCES.JEV)
  // A typo falls back to the safe side rather than leaving a system with the
  // hooks uninstalled and nothing reading the screen either.
  assert.strictEqual(stateSource(() => 'typo'), STATE_SOURCES.HOOK)
})

test('jev turns the pane model on without needing @scout-pane-model', () => {
  const { paneModelSettings } = require('../scripts/watcher')
  const reader = options => name => options[name] || ''
  assert.strictEqual(paneModelSettings(reader({ '@scout-state-source': 'jev' })).mode, 'on')
  // shadow stays reachable through the old option, which is how the agreement
  // report gets its data before anyone flips the switch.
  assert.strictEqual(paneModelSettings(reader({ '@scout-pane-model': 'shadow' })).mode, 'shadow')
  assert.strictEqual(paneModelSettings(reader({})).mode, 'off')
})

test('the settings watcher builds are ones the observer can actually use', async () => {
  // Nothing exercised watcher.js's own settings path, which is why an allowlist
  // that survived direct construction but not the real wiring went unnoticed.
  const { paneModelSettings } = require('../scripts/watcher')
  const settings = paneModelSettings()
  assert.ok(['off', 'shadow', 'on'].includes(settings.mode))

  // Simulate what paneModelSettings produces when the option is enabled, then
  // feed it through createPaneObserver exactly as startPaneObserver does.
  const { toAgentSet, DEFAULTS } = require('../scripts/lib/pane-observer')
  const enabled = {
    mode: 'on',
    intervalMs: DEFAULTS.intervalMs,
    tailLines: DEFAULTS.tailLines,
    agents: toAgentSet(DEFAULTS.agents),
    thresholds: undefined
  }
  const h = observerHarness({ observer: enabled })
  await h.tick(paneStatus())
  assert.strictEqual(h.calls.length, 1, 'watcher-built settings must classify a default-agent session')
})

test('watcher status stays quiet about the pane model until it is switched on', () => {
  const { formatPaneModelStats } = require('../scripts/watcher')
  assert.strictEqual(formatPaneModelStats(undefined), '')
  assert.strictEqual(formatPaneModelStats({ mode: 'off' }), '')

  const line = formatPaneModelStats({
    mode: 'on',
    available: true,
    calls: 4,
    cacheHits: 96,
    emitted: 3,
    errors: 0,
    throttled: 1,
    queued: 0,
    hitRate: 0.96
  })
  assert.ok(line.includes('hitRate=96%'), line)
  assert.ok(line.includes('calls=4'), line)
})

test('the agreement report reads its window the way the docs describe', () => {
  const { parseDuration } = require('../scripts/debug')
  assert.strictEqual(parseDuration('24h', 0), 24 * 3600 * 1000)
  assert.strictEqual(parseDuration('30m', 0), 30 * 60 * 1000)
  assert.strictEqual(parseDuration('7d', 0), 7 * 86400 * 1000)
  assert.strictEqual(parseDuration('12', 0), 12 * 3600 * 1000, 'a bare number means hours')
  assert.strictEqual(parseDuration('nonsense', 99), 99)
})

test('answer cache reports a hit rate for the watcher status line', () => {
  const cache = createAnswerCache()
  const key = answerCacheKey('claude', 1, 'abc123')
  assert.strictEqual(cache.stats().hitRate, 0)

  cache.get(key)                                 // miss
  cache.set(key, { answers: sampleAnswers() })
  cache.get(key)                                 // hit
  cache.get(key)                                 // hit
  assert.ok(Math.abs(cache.stats().hitRate - 2 / 3) < 1e-9)
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

// %166: the turn ended on a screen whose readings the gate rejected, so the
// session kept the tool its last accepted reading saw — and a tool switched
// the 120s fallback off, leaving it BUSY with nothing running.
test('idle fallback is not switched off by a tool the pane model read off the screen', () => {
  const dir = tempDir()
  try {
    const statusFile = path.join(dir, '.tmux-scout', 'status.json')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.mkdirSync(path.join(dir, '.tmux-scout', 'sessions'), { recursive: true })
    const now = Date.now()
    const running = (sessionId, stateSource) => ({
      sessionId,
      agentType: 'claude',
      status: 'working',
      phase: 'running',
      stateSource,
      startedAt: now - 600000,
      lastUpdated: now - 300000,
      activeTool: 'shell'
    })
    fs.writeFileSync(statusFile, JSON.stringify({
      version: 1,
      lastUpdated: now,
      sessions: {
        staleScreenTool: running('staleScreenTool', 'pane-model'),
        watchedScreenTool: running('watchedScreenTool', 'pane-model'),
        hookTool: running('hookTool', 'claude-hooks')
      }
    }, null, 2))

    const result = sync.run(statusFile, {
      reconcile: false,
      codexMode: 'none',
      claudeTranscript: false,
      idleCompleteMs: 60000,
      paneObservedAt: new Map([['watchedScreenTool', now - 1000]])
    })

    assert.strictEqual(currentPhase(result.status.sessions.staleScreenTool), 'completed')
    // Still being read and accepted: a long command on a frozen screen.
    assert.strictEqual(currentPhase(result.status.sessions.watchedScreenTool), 'running')
    // A hook-announced tool is running until a hook says otherwise.
    assert.strictEqual(currentPhase(result.status.sessions.hookTool), 'running')
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
  // TEST_FILTER=<substring> runs only the tests whose name contains it; the
  // full suite takes minutes, which is too slow for checking one change.
  const filter = process.env.TEST_FILTER
  const selected = filter ? tests.filter(item => item.name.includes(filter)) : tests

  for (const { name, fn } of selected) {
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
  console.log(`${selected.length - failed}/${selected.length} tests passed.`)
  if (failed > 0) process.exit(1)
}

main()
