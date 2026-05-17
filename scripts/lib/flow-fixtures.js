// Flow fixture runner for agent hook integration tests and debug replay.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { defaultPaths, readJson } = require('./hook-adapter')
const { validateSessionSnapshot } = require('./session-contract')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const DEFAULT_FIXTURE_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'flow')

function readFixture(filePath) {
  const fixture = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  if (!fixture || typeof fixture !== 'object') {
    throw new Error(`Invalid fixture: ${filePath}`)
  }
  fixture.filePath = filePath
  fixture.name = fixture.name || path.basename(filePath, '.json')
  return fixture
}

function collectFixtureFiles(rootDir = DEFAULT_FIXTURE_DIR) {
  const files = []
  function walk(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(fullPath)
    }
  }
  walk(rootDir)
  return files.sort()
}

function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function mergePayload(defaults, payload) {
  return Object.assign({}, cloneJson(defaults || {}), cloneJson(payload || {}))
}

function scriptForStep(fixture, step) {
  if (step.script) return path.resolve(PROJECT_ROOT, step.script)
  const agent = step.agent || fixture.agent
  if (agent === 'claude') return path.join(PROJECT_ROOT, 'scripts', 'hooks', 'claude.js')
  if (agent === 'codex') return path.join(PROJECT_ROOT, 'scripts', 'hooks', 'codex.js')
  return path.join(PROJECT_ROOT, 'scripts', 'hooks', 'generic.js')
}

function argsForStep(fixture, step) {
  if (Array.isArray(step.args)) return step.args.map(String)
  const agent = step.agent || fixture.agent
  const script = scriptForStep(fixture, step)
  const args = []
  if (script.endsWith(path.join('scripts', 'hooks', 'generic.js'))) {
    args.push('--agent', agent)
    if (step.event) args.push('--event', step.event)
  }
  if (step.argv !== undefined) {
    args.push(typeof step.argv === 'string' ? step.argv : JSON.stringify(step.argv))
  }
  return args
}

function runHookStep(fixture, step, homeDir, index) {
  const script = scriptForStep(fixture, step)
  const payload = mergePayload(fixture.payloadDefaults, step.payload)
  const input = step.stdin !== undefined
    ? String(step.stdin)
    : step.argv !== undefined ? '' : JSON.stringify(payload)
  const env = Object.assign({}, process.env, {
    HOME: homeDir,
    TMUX_PANE: step.tmuxPane || fixture.tmuxPane || '%1',
    TMUX_SCOUT_BRIDGE: '0'
  })

  try {
    execFileSync(process.execPath, [script, ...argsForStep(fixture, step)], {
      input,
      env,
      stdio: ['pipe', 'ignore', 'pipe']
    })
  } catch (error) {
    const label = `${fixture.name} step ${index + 1}`
    const detail = error && error.stderr ? String(error.stderr).trim() : error.message
    throw new Error(`${label} failed: ${detail}`)
  }
}

function getByPath(root, keyPath) {
  if (!keyPath) return root
  const parts = String(keyPath).replace(/\[(\d+)\]/g, '.$1').split('.')
  let current = root
  for (const part of parts) {
    if (!part) continue
    if (current === undefined || current === null) return undefined
    current = current[part]
  }
  return current
}

function validateFixtureExpectations(fixture, status, session) {
  const errors = []
  const warnings = []
  if (!session) {
    errors.push(`missing session ${fixture.sessionId || '(fixture.sessionId not set)'}`)
    return { errors, warnings }
  }

  const validation = validateSessionSnapshot(session)
  errors.push(...validation.errors.map(error => `contract: ${error}`))
  warnings.push(...validation.warnings.map(warning => `contract: ${warning}`))

  for (const [keyPath, expected] of Object.entries(fixture.expect || {})) {
    const statusPath = keyPath.startsWith('status.')
    const root = statusPath ? status : session
    const normalizedPath = statusPath ? keyPath.slice('status.'.length) : keyPath
    const actual = getByPath(root, normalizedPath)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${keyPath}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }

  const evidence = Array.isArray(session.stateEvidence) ? session.stateEvidence : []
  for (const type of fixture.expectEvidenceTypes || []) {
    if (!evidence.some(entry => entry && entry.type === type)) {
      errors.push(`stateEvidence missing type ${type}`)
    }
  }
  for (const rawEventName of fixture.expectRawEvents || []) {
    if (!evidence.some(entry => entry && entry.rawEventName === rawEventName)) {
      errors.push(`stateEvidence missing rawEventName ${rawEventName}`)
    }
  }

  return { errors, warnings }
}

function runFlowFixture(filePath, options = {}) {
  const fixture = readFixture(filePath)
  const homeDir = options.homeDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-scout-flow-'))
  const paths = defaultPaths(homeDir)
  for (const [index, step] of (fixture.steps || []).entries()) {
    runHookStep(fixture, step, homeDir, index)
  }

  const status = readJson(paths.statusFile, { version: 1, sessions: {} })
  const sessionId = fixture.sessionId
  const session = sessionId && status.sessions ? status.sessions[sessionId] : null
  const validation = validateFixtureExpectations(fixture, status, session)
  return {
    fixture,
    homeDir,
    paths,
    status,
    session,
    errors: validation.errors,
    warnings: validation.warnings,
    cleanup() {
      if (!options.homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
    }
  }
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_FIXTURE_DIR,
  collectFixtureFiles,
  readFixture,
  runFlowFixture,
  validateFixtureExpectations,
  getByPath
}
