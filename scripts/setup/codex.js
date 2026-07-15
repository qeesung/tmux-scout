#!/usr/bin/env node
// tmux-scout Codex hook management
// Installs modern Codex event hooks in ~/.codex/hooks.json and keeps the
// legacy notify hook as a fallback for older Codex builds.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync, spawnSync } = require('child_process')
const TOML = require('../vendor/iarna-toml/toml')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const CODEX_DIR = path.join(os.homedir(), '.codex')
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml')
const CODEX_HOOKS_CONFIG = path.join(CODEX_DIR, 'hooks.json')
const SCOUT_DIR = path.join(os.homedir(), '.tmux-scout')
const ORIGINAL_NOTIFY_FILE = path.join(SCOUT_DIR, 'codex-original-notify.json')
const MODERN_MANIFEST_FILE = path.join(SCOUT_DIR, 'codex-hooks-manifest.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'codex.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/codex.js'
const MIN_CLI_HOOKS_ONLY_VERSION = '0.129.0'
const MIN_APP_HOOKS_ONLY_VERSION = '26.506.0'
const APP_BUNDLE_ID = 'com.openai.codex'
const APP_CANDIDATES = [
  {
    plist: '/Applications/ChatGPT.app/Contents/Info.plist',
    binary: '/Applications/ChatGPT.app/Contents/Resources/codex'
  },
  {
    plist: '/Applications/Codex.app/Contents/Info.plist',
    binary: '/Applications/Codex.app/Contents/Resources/codex'
  }
]

const CODEX_EVENTS = [
  { event: 'SessionStart', timeout: 5 },
  { event: 'UserPromptSubmit', timeout: 5 },
  { event: 'PreToolUse', timeout: 5 },
  { event: 'PermissionRequest', matcher: '*', timeout: 86400 },
  { event: 'PostToolUse', timeout: 5 },
  { event: 'Stop', timeout: 5 }
]

const CODEX_EVENT_KEYS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop'
}

function writeAtomic(filePath, content) {
  const tempPath = filePath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, content)
    fs.renameSync(tempPath, filePath)
  } catch (e) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw e
  }
}

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function extractVersion(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  const keywordPatterns = [
    /\bcodex(?:\.app)?(?:\s+cli)?(?:\s+version)?[^0-9\n]{0,20}v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.+-]+)?)/i,
    /\bcodex(?:\.app)?[^\n]{0,40}?v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.+-]+)?)/i,
    /v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.+-]+)?)[^\n]{0,40}?\bcodex(?:\.app)?\b/i
  ]
  for (const pattern of keywordPatterns) {
    const match = normalized.match(pattern)
    if (match && match[1]) return match[1]
  }
  const matches = Array.from(normalized.matchAll(/\bv?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.+-]+)?)\b/g))
  const unique = [...new Set(matches.map(match => match[1]).filter(Boolean))]
  return unique.length === 1 ? unique[0] : null
}

function versionGte(version, minimum) {
  const left = String(version || '').split(/[.-]/).slice(0, 4).map(part => Number.parseInt(part, 10) || 0)
  const right = String(minimum || '').split(/[.-]/).slice(0, 4).map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta > 0
  }
  return true
}

function readPlistValue(plist, key) {
  try {
    const output = execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
    })
    return String(output || '').trim() || null
  } catch (_) {
    return null
  }
}

function detectAppVersion() {
  for (const candidate of APP_CANDIDATES) {
    if (!fs.existsSync(candidate.plist) || !fs.existsSync(candidate.binary)) continue
    if (readPlistValue(candidate.plist, 'CFBundleIdentifier') !== APP_BUNDLE_ID) continue
    return {
      installed: true,
      version: extractVersion(readPlistValue(candidate.plist, 'CFBundleShortVersionString'))
    }
  }
  return { installed: false, version: null }
}

function detectCliVersion() {
  let binary
  try {
    binary = execFileSync('/usr/bin/env', ['which', 'codex'], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!binary || !fs.existsSync(binary)) return { installed: false, version: null }
    const resolved = fs.realpathSync(binary)
    const isBundled = APP_CANDIDATES.some(candidate => {
      try { return fs.existsSync(candidate.binary) && fs.realpathSync(candidate.binary) === resolved } catch (_) { return false }
    })
    if (isBundled) return { installed: false, version: null }
  } catch (_) {
    return { installed: false, version: null }
  }

  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    installed: true,
    version: extractVersion(`${result.stdout || ''}\n${result.stderr || ''}`)
  }
}

function detectCodexVersions() {
  return { app: detectAppVersion(), cli: detectCliVersion() }
}

function writeJson(filePath, data) {
  writeAtomic(filePath, JSON.stringify(data, null, 2) + '\n')
}

function buildHookCommand() {
  return buildNodeHookCommand(HOOK_PATH)
}

function parseNotifyArray(content) {
  const parsed = parseToml(content)
  if (!parsed || !Array.isArray(parsed.notify)) return null
  const values = parsed.notify.filter(value => typeof value === 'string')
  return values.length === parsed.notify.length && values.length > 0 ? values : null
}

function buildNotifyValues(hookPath) {
  return [
    'sh',
    '-c',
    'test -e "$1" || exit 0; exec node "$1" "$2"',
    'tmux-scout',
    hookPath
  ]
}

function normalizeNotifyValue(value) {
  return String(value || '').replace(/\\+\//g, '/')
}

function normalizedNotifyText(values) {
  return JSON.stringify((values || []).map(normalizeNotifyValue))
}

function notifyValuesEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => value === right[index])
}

function isStandaloneScoutHookPath(value) {
  const normalized = normalizeNotifyValue(value).trim()
  return normalized === HOOK_PATH || normalized.includes(HOOK_IDENTIFIER)
}

function isDirectScoutNotify(values) {
  if (!Array.isArray(values) || values.length < 2) return false
  const executable = path.basename(normalizeNotifyValue(values[0])).toLowerCase()
  const hasHookPathArgument = values.slice(1).some(isStandaloneScoutHookPath)
  if (!hasHookPathArgument) return false
  if (executable === 'node' || executable === 'nodejs') return true
  return (executable === 'sh' || executable === 'bash' || executable === 'zsh') && values[1] === '-c'
}

function hasWrappedScoutNotify(values) {
  if (!Array.isArray(values) || isDirectScoutNotify(values)) return false
  const normalized = normalizedNotifyText(values)
  return normalized.includes(HOOK_PATH) || normalized.includes(HOOK_IDENTIFIER)
}

function writeNotifyArray(content, values) {
  const parsed = parseToml(content)
  if (!parsed) throw new Error('Invalid ~/.codex/config.toml')
  if (values && values.length > 0) parsed.notify = values
  else delete parsed.notify
  return TOML.stringify(parsed)
}

function installLegacyNotify() {
  const content = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf-8') : ''
  const currentNotify = parseNotifyArray(content)
  const wantedNotify = buildNotifyValues(HOOK_PATH)

  if (notifyValuesEqual(currentNotify, wantedNotify) || hasWrappedScoutNotify(currentNotify)) {
    return { action: 'ok', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
  }

  const originalNotify = currentNotify
  const updatesManagedNotify = isDirectScoutNotify(currentNotify)
  fs.mkdirSync(SCOUT_DIR, { recursive: true })
  if (!updatesManagedNotify && originalNotify !== null && !fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    writeJson(ORIGINAL_NOTIFY_FILE, { notify: originalNotify })
  }

  writeAtomic(CODEX_CONFIG, writeNotifyArray(content, wantedNotify))
  return {
    action: updatesManagedNotify ? 'updated' : 'installed',
    hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE)
  }
}

function uninstallLegacyNotify() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    return { action: 'not_found' }
  }

  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  const currentNotify = parseNotifyArray(content)
  if (!isDirectScoutNotify(currentNotify)) {
    return { action: 'not_found' }
  }

  let restoredNotify = null
  if (fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ORIGINAL_NOTIFY_FILE, 'utf-8'))
      if (saved && Array.isArray(saved.notify) && saved.notify.length > 0) {
        restoredNotify = saved.notify
      }
      fs.unlinkSync(ORIGINAL_NOTIFY_FILE)
    } catch (_) {}
  }

  writeAtomic(CODEX_CONFIG, writeNotifyArray(content, restoredNotify))
  return { action: 'removed' }
}

function statusLegacyNotify() {
  if (!fs.existsSync(CODEX_CONFIG)) return { installed: false, path: null }
  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  const strings = parseNotifyArray(content) || []
  const normalized = normalizedNotifyText(strings)
  if (!normalized.includes(HOOK_IDENTIFIER) && !normalized.includes(HOOK_PATH)) {
    return { installed: false, path: null }
  }

  let currentPath = null
  currentPath = strings.find(value => path.basename(value) === 'codex.js') || null
  if (!currentPath) {
    currentPath = extractHookPathFromCommand(normalized, 'codex.js')
  }
  return { installed: true, path: currentPath }
}

function isScoutHookEntry(entry) {
  return Boolean(entry && typeof entry.command === 'string'
    && (entry.command.includes(HOOK_IDENTIFIER) || entry.command.includes(HOOK_PATH)))
}

function isCurrentScoutHookEntry(entry) {
  return Boolean(entry && typeof entry.command === 'string' && entry.command.includes(HOOK_PATH))
}

function isScoutHookGroup(group) {
  return Boolean(group && Array.isArray(group.hooks) && group.hooks.some(isScoutHookEntry))
}

function isCurrentScoutHookGroup(group) {
  return Boolean(group && Array.isArray(group.hooks) && group.hooks.some(isCurrentScoutHookEntry))
}

function removeScoutHookEntries(groups) {
  const keptGroups = []
  let removed = false

  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      keptGroups.push(group)
      continue
    }

    const hooks = group.hooks.filter(handler => !isScoutHookEntry(handler))
    if (hooks.length === group.hooks.length) {
      keptGroups.push(group)
      continue
    }

    removed = true
    if (hooks.length > 0) {
      keptGroups.push(Object.assign({}, group, { hooks }))
    }
  }

  return { groups: keptGroups, removed }
}

function makeHookGroup(eventConfig, command) {
  const entry = { command, type: 'command', timeout: eventConfig.timeout || 5 }
  const group = { hooks: [entry] }
  if (eventConfig.matcher !== undefined) group.matcher = eventConfig.matcher
  return group
}

function canonicalize(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key])
    }
    return sorted
  }
  return value
}

function commandHookHash({ snakeEvent, matcher, command, timeoutSec }) {
  const handler = {
    type: 'command',
    command,
    timeout: timeoutSec,
    async: false
  }
  const identity = {
    event_name: snakeEvent,
    hooks: [handler]
  }
  if (matcher !== undefined) identity.matcher = matcher
  const canonical = JSON.stringify(canonicalize(identity))
  const hex = crypto.createHash('sha256').update(canonical).digest('hex')
  return `sha256:${hex}`
}

function computeTrustEntries(hooksConfigPath, hooksConfig) {
  const entries = []
  for (const [eventName, groups] of Object.entries(hooksConfig || {})) {
    const snakeEvent = CODEX_EVENT_KEYS[eventName]
    if (!snakeEvent || !Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      if (!isScoutHookGroup(group)) return
      const hooks = Array.isArray(group.hooks) ? group.hooks : []
      hooks.forEach((handler, handlerIndex) => {
        if (!isScoutHookEntry(handler)) return
        if (handler.type !== undefined && handler.type !== 'command') return
        const command = handler.command || ''
        if (!command.trim()) return
        if (handler.async === true) return
        const timeoutSec = Math.max(1, handler.timeout || 600)
        const key = `${hooksConfigPath}:${snakeEvent}:${groupIndex}:${handlerIndex}`
        entries.push({
          key,
          trustedHash: commandHookHash({
            snakeEvent,
            matcher: group.matcher,
            command,
            timeoutSec
          })
        })
      })
    })
  }
  return entries
}

function parseToml(content) {
  if (!String(content || '').trim()) return {}
  try { return TOML.parse(content) } catch (_) { return null }
}

function asTable(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function featureConfig(content) {
  const parsed = parseToml(content)
  const features = parsed ? asTable(parsed.features) : {}
  return {
    hooks: {
      present: Object.prototype.hasOwnProperty.call(features, 'hooks'),
      value: features.hooks
    },
    legacy: {
      present: Object.prototype.hasOwnProperty.call(features, 'codex_hooks'),
      value: features.codex_hooks
    }
  }
}

function hasHooksFeature(content) {
  return featureConfig(content).hooks.value === true
}

function hooksOnlyCapable(probe, minimum) {
  return Boolean(probe && probe.installed && probe.version && versionGte(probe.version, minimum))
}

function resolveFeatureFlags(content, detectedVersions) {
  const versions = detectedVersions || { app: { installed: false, version: null }, cli: { installed: false, version: null } }
  if (versions.app.installed && versions.app.version && !versionGte(versions.app.version, MIN_APP_HOOKS_ONLY_VERSION)) {
    return ['hooks', 'codex_hooks']
  }
  if (versions.cli.installed && versions.cli.version && !versionGte(versions.cli.version, MIN_CLI_HOOKS_ONLY_VERSION)) {
    return ['hooks', 'codex_hooks']
  }
  if (versions.app.installed || versions.cli.installed) return ['hooks']

  const current = featureConfig(content)
  return current.hooks.value === true && current.legacy.value !== true
    ? ['hooks']
    : ['hooks', 'codex_hooks']
}

function selectFeatureFlags(content, detectedVersions) {
  const current = featureConfig(content)
  if (!current.hooks.present) return resolveFeatureFlags(content, detectedVersions)

  if (current.hooks.value === true && current.legacy.value === true) {
    const bothModern = hooksOnlyCapable(detectedVersions && detectedVersions.app, MIN_APP_HOOKS_ONLY_VERSION) &&
      hooksOnlyCapable(detectedVersions && detectedVersions.cli, MIN_CLI_HOOKS_ONLY_VERSION)
    return bothModern ? ['hooks'] : ['hooks', 'codex_hooks']
  }

  return current.legacy.value === true ? ['hooks', 'codex_hooks'] : ['hooks']
}

function upsertFeatures(content, featureFlags = ['hooks']) {
  const parsed = parseToml(content) || {}
  const existing = asTable(parsed.features)
  const wanted = new Set(featureFlags)
  const features = {}
  if (wanted.has('hooks')) features.hooks = true
  if (wanted.has('codex_hooks')) features.codex_hooks = true
  for (const [key, value] of Object.entries(existing)) {
    if (key === 'hooks' || key === 'codex_hooks') continue
    features[key] = value
  }
  parsed.features = features
  return TOML.stringify(parsed)
}

function applyConfigToml(content, trustEntries, staleKeys, featureFlags) {
  const parsed = parseToml(content) || {}
  const withFeatures = TOML.parse(upsertFeatures(TOML.stringify(parsed), featureFlags))
  const managedKeys = new Set(staleKeys || [])
  for (const entry of trustEntries) managedKeys.add(entry.key)

  const hooks = asTable(withFeatures.hooks)
  const existingState = asTable(hooks.state)
  const merged = {}
  for (const [key, value] of Object.entries(existingState)) {
    if (!managedKeys.has(key)) merged[key] = value
  }
  for (const entry of trustEntries) {
    merged[entry.key] = { trusted_hash: entry.trustedHash }
  }
  const ordered = {}
  for (const key of Object.keys(merged).sort()) ordered[key] = merged[key]
  if (Object.keys(ordered).length > 0) hooks.state = ordered
  else delete hooks.state
  if (Object.keys(hooks).length > 0) withFeatures.hooks = hooks
  else delete withFeatures.hooks
  return TOML.stringify(withFeatures)
}

function removeTrustTables(content, keys) {
  if (!keys || keys.length === 0 || !content.trim()) return content
  const parsed = parseToml(content)
  if (!parsed) return content
  const hooks = asTable(parsed.hooks)
  const state = asTable(hooks.state)
  for (const key of keys) delete state[key]
  if (Object.keys(state).length > 0) hooks.state = state
  else delete hooks.state
  if (Object.keys(hooks).length > 0) parsed.hooks = hooks
  else delete parsed.hooks
  return TOML.stringify(parsed)
}

function readTrustHash(content, key) {
  const parsed = parseToml(content)
  if (!parsed) return null
  const entry = asTable(asTable(asTable(parsed.hooks).state)[key])
  return typeof entry.trusted_hash === 'string' ? entry.trusted_hash : null
}

function installModernHooks() {
  const command = buildHookCommand()
  const hooksFile = readJson(CODEX_HOOKS_CONFIG, { hooks: {} })
  if (!hooksFile || typeof hooksFile !== 'object') {
    throw new Error('Invalid ~/.codex/hooks.json')
  }
  if (!hooksFile.hooks || typeof hooksFile.hooks !== 'object') hooksFile.hooks = {}

  const actions = []
  for (const eventConfig of CODEX_EVENTS) {
    const current = Array.isArray(hooksFile.hooks[eventConfig.event])
      ? hooksFile.hooks[eventConfig.event]
      : []
    const group = makeHookGroup(eventConfig, command)
    const filtered = removeScoutHookEntries(current)
    const nextGroups = [...filtered.groups, group]
    const already = JSON.stringify(current) === JSON.stringify(nextGroups)
    hooksFile.hooks[eventConfig.event] = nextGroups
    actions.push({ event: eventConfig.event, action: already ? 'ok' : filtered.removed ? 'updated' : 'installed' })
  }

  const previousManifest = readJson(MODERN_MANIFEST_FILE, null)
  writeJson(CODEX_HOOKS_CONFIG, hooksFile)

  const trustEntries = computeTrustEntries(CODEX_HOOKS_CONFIG, hooksFile.hooks)
  const oldToml = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf-8') : ''
  const detectedVersions = detectCodexVersions()
  const featureFlags = selectFeatureFlags(oldToml, detectedVersions)
  const newToml = applyConfigToml(
    oldToml,
    trustEntries,
    previousManifest && previousManifest.trustKeys,
    featureFlags
  )
  writeAtomic(CODEX_CONFIG, newToml)

  writeJson(MODERN_MANIFEST_FILE, {
    hooksConfigPath: CODEX_HOOKS_CONFIG,
    tomlConfigPath: CODEX_CONFIG,
    events: CODEX_EVENTS.map(e => e.event),
    trustKeys: trustEntries.map(e => e.key),
    featureFlags,
    detectedVersions,
    installedAt: new Date().toISOString()
  })

  const allHadScout = actions.every(a => a.action === 'ok')
  return { action: allHadScout ? 'ok' : 'installed', results: actions, trustEntries, featureFlags, detectedVersions }
}

function uninstallModernHooks() {
  const manifest = readJson(MODERN_MANIFEST_FILE, null)
  let removed = false

  if (fs.existsSync(CODEX_HOOKS_CONFIG)) {
    const hooksFile = readJson(CODEX_HOOKS_CONFIG, { hooks: {} })
    if (hooksFile && hooksFile.hooks && typeof hooksFile.hooks === 'object') {
      const events = new Set([
        ...CODEX_EVENTS.map(e => e.event),
        ...((manifest && Array.isArray(manifest.events)) ? manifest.events : [])
      ])
      for (const event of events) {
        const groups = hooksFile.hooks[event]
        if (!Array.isArray(groups)) continue
        const filtered = removeScoutHookEntries(groups)
        if (filtered.removed) removed = true
        if (filtered.groups.length > 0) hooksFile.hooks[event] = filtered.groups
        else delete hooksFile.hooks[event]
      }
      writeJson(CODEX_HOOKS_CONFIG, hooksFile)
    }
  }

  if (fs.existsSync(CODEX_CONFIG)) {
    const keys = manifest && Array.isArray(manifest.trustKeys) ? manifest.trustKeys : []
    if (keys.length > 0) {
      const toml = fs.readFileSync(CODEX_CONFIG, 'utf-8')
      writeAtomic(CODEX_CONFIG, removeTrustTables(toml, keys).replace(/\n{3,}/g, '\n\n'))
    }
  }

  try { fs.unlinkSync(MODERN_MANIFEST_FILE) } catch (_) {}
  return { action: removed ? 'removed' : 'not_found' }
}

function statusModernHooks() {
  if (!fs.existsSync(CODEX_HOOKS_CONFIG)) {
    return {
      installed: false,
      installedEvents: 0,
      totalEvents: CODEX_EVENTS.length,
      missing: CODEX_EVENTS.map(e => e.event),
      featuresEnabled: false,
      missingTrust: []
    }
  }

  const hooksFile = readJson(CODEX_HOOKS_CONFIG, { hooks: {} })
  const missing = []
  for (const { event } of CODEX_EVENTS) {
    const groups = hooksFile && hooksFile.hooks && Array.isArray(hooksFile.hooks[event])
      ? hooksFile.hooks[event]
      : []
    if (!groups.some(isCurrentScoutHookGroup)) missing.push(event)
  }

  const installedEvents = CODEX_EVENTS.length - missing.length
  const toml = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf-8') : ''
  const featuresEnabled = hasHooksFeature(toml)
  const missingTrust = []
  if (missing.length === 0) {
    for (const entry of computeTrustEntries(CODEX_HOOKS_CONFIG, hooksFile.hooks)) {
      if (readTrustHash(toml, entry.key) !== entry.trustedHash) {
        missingTrust.push(entry.key)
      }
    }
  }

  return {
    installed: missing.length === 0 && featuresEnabled && missingTrust.length === 0,
    installedEvents,
    totalEvents: CODEX_EVENTS.length,
    missing,
    featuresEnabled,
    missingTrust
  }
}

function install() {
  if (!fs.existsSync(CODEX_DIR) && !fs.existsSync(CODEX_CONFIG)) {
    return { skipped: true, reason: 'Codex not installed (~/.codex not found)' }
  }

  fs.mkdirSync(CODEX_DIR, { recursive: true })
  fs.mkdirSync(SCOUT_DIR, { recursive: true })

  const modern = installModernHooks()
  const legacy = installLegacyNotify()
  return { action: modern.action, modern, legacy, hasOriginalNotify: legacy.hasOriginalNotify }
}

function uninstall() {
  if (!fs.existsSync(CODEX_DIR) && !fs.existsSync(CODEX_CONFIG)) {
    return { skipped: true, reason: 'Codex not installed' }
  }

  const modern = uninstallModernHooks()
  const legacy = uninstallLegacyNotify()
  const removed = modern.action === 'removed' || legacy.action === 'removed'
  return { action: removed ? 'removed' : 'not_found', modern, legacy }
}

function status() {
  const available = fs.existsSync(CODEX_DIR) || fs.existsSync(CODEX_CONFIG)
  if (!available) return { installed: false, available: false }

  const modern = statusModernHooks()
  const legacy = statusLegacyNotify()
  return {
    installed: modern.installed || legacy.installed,
    available: true,
    modern,
    legacy,
    path: legacy.path
  }
}

module.exports = {
  install,
  uninstall,
  status,
  extractVersion,
  versionGte,
  detectAppVersion,
  detectCliVersion,
  detectCodexVersions,
  resolveFeatureFlags,
  selectFeatureFlags,
  upsertFeatures
}

if (require.main === module) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'install') {
      const r = install()
      if (r.skipped) console.log('Codex: ' + r.reason)
      else console.log('Codex: ' + r.action)
    } else if (cmd === 'uninstall') {
      const r = uninstall()
      if (r.skipped) console.log('Codex: ' + r.reason)
      else console.log('Codex: ' + r.action)
    } else if (cmd === 'status') {
      const r = status()
      if (!r.available) console.log('Codex: not installed')
      else console.log('Codex: ' + (r.installed ? 'hook installed' : 'hook not installed'))
    } else {
      console.log('Usage: codex.js <install|uninstall|status>')
    }
  } catch (e) {
    console.error('Codex: ' + e.message)
    process.exit(0)
  }
}
