#!/usr/bin/env node
// tmux-scout Codex hook management
// Installs modern Codex event hooks in ~/.codex/hooks.json and keeps the
// legacy notify hook as a fallback for older Codex builds.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const CODEX_DIR = path.join(os.homedir(), '.codex')
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml')
const CODEX_HOOKS_CONFIG = path.join(CODEX_DIR, 'hooks.json')
const SCOUT_DIR = path.join(os.homedir(), '.tmux-scout')
const ORIGINAL_NOTIFY_FILE = path.join(SCOUT_DIR, 'codex-original-notify.json')
const MODERN_MANIFEST_FILE = path.join(SCOUT_DIR, 'codex-hooks-manifest.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'codex.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/codex.js'

const NOTIFY_REGEX = /^notify\s*=\s*\[([^\]]*)\]/m

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

function writeJson(filePath, data) {
  writeAtomic(filePath, JSON.stringify(data, null, 2) + '\n')
}

function buildHookCommand() {
  return buildNodeHookCommand(HOOK_PATH)
}

function parseNotifyArray(content) {
  const match = content.match(NOTIFY_REGEX)
  if (!match) return null
  const strings = []
  const strRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g
  let strMatch
  while ((strMatch = strRegex.exec(match[1])) !== null) {
    strings.push(strMatch[1].replace(/\\"/g, '"'))
  }
  return strings.length > 0 ? strings : null
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function buildNotifyLine(hookPath) {
  const values = [
    'sh',
    '-c',
    'test -e "$1" || exit 0; exec node "$1" "$2"',
    'tmux-scout',
    hookPath
  ]
  return `notify = [\n${values.map(value => `  ${tomlString(value)}`).join(',\n')}\n]`
}

function notifyArrayMatchesExpected(content, hookPath) {
  const current = parseNotifyArray(content)
  const expected = parseNotifyArray(buildNotifyLine(hookPath))
  return Boolean(current && expected && JSON.stringify(current) === JSON.stringify(expected))
}

function installLegacyNotify() {
  const content = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf-8') : ''

  if (content.includes(HOOK_PATH)) {
    if (notifyArrayMatchesExpected(content, HOOK_PATH)) {
      return { action: 'ok', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
    }
    if (!NOTIFY_REGEX.test(content)) {
      return { action: 'ok', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
    }
    const newNotify = buildNotifyLine(HOOK_PATH)
    const newContent = content.replace(NOTIFY_REGEX, () => newNotify)
    writeAtomic(CODEX_CONFIG, newContent)
    return { action: 'updated', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
  }

  if (content.includes(HOOK_IDENTIFIER)) {
    const newNotify = buildNotifyLine(HOOK_PATH)
    const newContent = content.replace(NOTIFY_REGEX, () => newNotify)
    writeAtomic(CODEX_CONFIG, newContent)
    return { action: 'updated', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
  }

  const originalNotify = parseNotifyArray(content)
  fs.mkdirSync(SCOUT_DIR, { recursive: true })
  if (!fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    writeJson(ORIGINAL_NOTIFY_FILE, { notify: originalNotify })
  }

  const newNotify = buildNotifyLine(HOOK_PATH)
  const match = content.match(NOTIFY_REGEX)
  let newContent
  if (match) {
    newContent = content.replace(NOTIFY_REGEX, () => newNotify)
  } else if (content.trim()) {
    const lines = content.split('\n')
    let insertIdx = 0
    while (insertIdx < lines.length && lines[insertIdx].startsWith('#')) {
      insertIdx++
    }
    lines.splice(insertIdx, 0, newNotify)
    newContent = lines.join('\n')
  } else {
    newContent = newNotify + '\n'
  }

  writeAtomic(CODEX_CONFIG, newContent)
  return { action: 'installed', hasOriginalNotify: originalNotify !== null }
}

function uninstallLegacyNotify() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    return { action: 'not_found' }
  }

  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  if (!content.includes(HOOK_IDENTIFIER) && !content.includes(HOOK_PATH)) {
    return { action: 'not_found' }
  }

  let newContent
  if (fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ORIGINAL_NOTIFY_FILE, 'utf-8'))
      if (saved && Array.isArray(saved.notify) && saved.notify.length > 0) {
        const restored = `notify = [\n${saved.notify.map(s => `  "${String(s).replace(/"/g, '\\"')}"`).join(',\n')}\n]`
        newContent = content.replace(NOTIFY_REGEX, () => restored)
      } else {
        newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
      }
      fs.unlinkSync(ORIGINAL_NOTIFY_FILE)
    } catch (_) {
      newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
    }
  } else {
    newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
  }

  writeAtomic(CODEX_CONFIG, newContent)
  return { action: 'removed' }
}

function statusLegacyNotify() {
  if (!fs.existsSync(CODEX_CONFIG)) return { installed: false, path: null }
  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  if (!content.includes(HOOK_IDENTIFIER) && !content.includes(HOOK_PATH)) {
    return { installed: false, path: null }
  }

  const match = content.match(NOTIFY_REGEX)
  let currentPath = null
  if (match) {
    const strings = parseNotifyArray(content) || []
    currentPath = strings.find(value => path.basename(value) === 'codex.js') || null
    if (!currentPath) {
      currentPath = extractHookPathFromCommand(strings.join(' '), 'codex.js')
    }
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

function tomlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function removeTrustTables(content, keys) {
  if (!keys || keys.length === 0 || !content.trim()) return content
  const headers = new Set(keys.map(key => `[hooks.state.${tomlQuote(key)}]`))
  const lines = content.split('\n')
  const kept = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[[^\]]+\]\s*$/.test(trimmed)) {
      skipping = headers.has(trimmed)
      if (skipping) continue
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

function findTableBody(content, header) {
  const lines = content.split('\n')
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      start = i + 1
      continue
    }
    if (start >= 0 && i >= start && /^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i
      break
    }
  }
  return start >= 0 ? lines.slice(start, end) : null
}

function hasHooksFeature(content) {
  const body = findTableBody(content, '[features]')
  if (!body) return false
  return body.some(line => /^\s*hooks\s*=\s*true\s*(?:#.*)?$/.test(line))
}

function readTrustHash(content, key) {
  const body = findTableBody(content, `[hooks.state.${tomlQuote(key)}]`)
  if (!body) return null
  for (const line of body) {
    const match = line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"/)
    if (match) return match[1]
  }
  return null
}

function upsertFeatures(content) {
  const lines = content.split('\n')
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[features]') {
      start = i
      continue
    }
    if (start >= 0 && i > start && /^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i
      break
    }
  }

  if (start < 0) {
    const prefix = content.trim() ? content.replace(/\s*$/, '\n\n') : ''
    return prefix + '[features]\nhooks = true\n'
  }

  const body = lines.slice(start + 1, end)
    .filter(line => !/^\s*(hooks|codex_hooks)\s*=/.test(line))
  const replacement = ['[features]', 'hooks = true', ...body]
  lines.splice(start, end - start, ...replacement)
  return lines.join('\n')
}

function applyConfigToml(content, trustEntries, staleKeys) {
  const managedKeys = new Set(staleKeys || [])
  for (const entry of trustEntries) managedKeys.add(entry.key)

  let updated = removeTrustTables(content, Array.from(managedKeys))
  updated = upsertFeatures(updated)
  updated = updated.replace(/\s*$/, '\n')

  if (trustEntries.length > 0) {
    updated += '\n'
    for (const entry of trustEntries) {
      updated += `[hooks.state.${tomlQuote(entry.key)}]\n`
      updated += `trusted_hash = ${tomlQuote(entry.trustedHash)}\n\n`
    }
  }

  return updated.replace(/\n{3,}/g, '\n\n')
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
  const newToml = applyConfigToml(oldToml, trustEntries, previousManifest && previousManifest.trustKeys)
  writeAtomic(CODEX_CONFIG, newToml)

  writeJson(MODERN_MANIFEST_FILE, {
    hooksConfigPath: CODEX_HOOKS_CONFIG,
    tomlConfigPath: CODEX_CONFIG,
    events: CODEX_EVENTS.map(e => e.event),
    trustKeys: trustEntries.map(e => e.key),
    installedAt: new Date().toISOString()
  })

  const allHadScout = actions.every(a => a.action === 'ok')
  return { action: allHadScout ? 'ok' : 'installed', results: actions, trustEntries }
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

module.exports = { install, uninstall, status }

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
