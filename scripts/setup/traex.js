#!/usr/bin/env node
// tmux-scout Traex CLI hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const CONFIG_FILE = path.join(os.homedir(), '.trae', 'traecli.toml')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const MANAGED_START = '# >>> tmux-scout traex hooks >>>'
const MANAGED_END = '# <<< tmux-scout traex hooks <<<'
const HOOK_EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse' },
  { event: 'PostToolUse' },
  { event: 'PermissionRequest', timeout: 86400 },
  { event: 'Notification' },
  { event: 'SessionEnd' },
  { event: 'Stop' },
  { event: 'PreCompact' },
  { event: 'PostCompact' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' }
]

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return fs.readFileSync(CONFIG_FILE, 'utf-8')
  } catch (_) {}
  return ''
}

function writeAtomic(filePath, content) {
  const tempPath = filePath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, content)
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function command() {
  return buildNodeHookCommand(HOOK_PATH, ['--agent', 'traex'])
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function containsScoutHook(text) {
  const value = String(text || '')
  return (value.includes(HOOK_IDENTIFIER) || value.includes(HOOK_PATH)) &&
    value.includes('--agent') &&
    value.includes('traex')
}

function removeManagedBlock(content) {
  const lines = String(content || '').split('\n')
  const kept = []
  let removed = false
  let inManaged = false

  for (const line of lines) {
    if (line.trim() === MANAGED_START) {
      inManaged = true
      removed = true
      continue
    }
    if (inManaged && line.trim() === MANAGED_END) {
      inManaged = false
      continue
    }
    if (!inManaged) kept.push(line)
  }

  return {
    content: kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'),
    removed
  }
}

function isTomlHeader(line) {
  return /^\s*\[[^\]]+\]\s*$/.test(line) || /^\s*\[\[[^\]]+\]\]\s*$/.test(line)
}

function upsertFeaturesHooks(content) {
  const lines = String(content || '').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const start = lines.findIndex(line => /^\s*\[features\]\s*$/.test(line))
  if (start < 0) {
    const prefix = lines.length > 0 ? lines.concat(['']) : lines
    return prefix.concat(['[features]', 'hooks = true']).join('\n').replace(/\s*$/, '\n')
  }

  const next = []
  for (let i = 0; i < lines.length; i++) {
    next.push(lines[i])
    if (i !== start) continue
    next.push('hooks = true')
    i++
    while (i < lines.length) {
      if (isTomlHeader(lines[i])) {
        i--
        break
      }
      if (!/^\s*hooks\s*=/.test(lines[i])) next.push(lines[i])
      i++
    }
  }
  return next.join('\n').replace(/\s*$/, '\n')
}

function featureHooksEnabled(content) {
  const lines = String(content || '').split('\n')
  const start = lines.findIndex(line => /^\s*\[features\]\s*$/.test(line))
  if (start < 0) return false
  for (const line of lines.slice(start + 1)) {
    if (isTomlHeader(line)) break
    if (/^\s*hooks\s*=\s*true\s*(?:#.*)?$/i.test(line)) return true
  }
  return false
}

function managedBlock(hookCommand) {
  const lines = [MANAGED_START]
  for (const eventConfig of HOOK_EVENTS) {
    lines.push(`[[hooks.${eventConfig.event}]]`)
    lines.push(`[[hooks.${eventConfig.event}.hooks]]`)
    lines.push('type = "command"')
    lines.push(`command = ${tomlString(hookCommand)}`)
    if (eventConfig.timeout) lines.push(`timeout = ${eventConfig.timeout}`)
    lines.push('')
  }
  if (lines[lines.length - 1] === '') lines.pop()
  lines.push(MANAGED_END)
  return lines.join('\n')
}

function extractManagedBlock(content) {
  const start = String(content || '').indexOf(MANAGED_START)
  const end = String(content || '').indexOf(MANAGED_END)
  if (start < 0 || end < start) return ''
  return String(content || '').slice(start, end + MANAGED_END.length)
}

function install() {
  const original = readConfig()
  const cleaned = removeManagedBlock(original)
  const withFeatures = upsertFeaturesHooks(cleaned.content)
  const prefix = withFeatures.trim() ? withFeatures.replace(/\s*$/, '\n\n') : ''
  writeAtomic(CONFIG_FILE, prefix + managedBlock(command()) + '\n')
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: cleaned.removed ? 'updated' : 'installed'
    })).concat([{ event: '[features].hooks', action: 'installed' }]),
    path: HOOK_PATH
  }
}

function uninstall() {
  const original = readConfig()
  if (!original.trim()) return { skipped: true, reason: 'traecli.toml not found' }
  const cleaned = removeManagedBlock(original)
  if (cleaned.removed) writeAtomic(CONFIG_FILE, cleaned.content)
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: cleaned.removed ? 'removed' : 'not_found'
    }))
  }
}

function status() {
  const content = readConfig()
  const block = extractManagedBlock(content)
  const installed = []
  const missing = []
  let currentPath = null
  const expected = command()
  const hasFeatures = featureHooksEnabled(content)
  if (block && containsScoutHook(block)) currentPath = extractHookPathFromCommand(block, 'generic.js')

  for (const eventConfig of HOOK_EVENTS) {
    const hasEvent = block.includes(`[[hooks.${eventConfig.event}]]`) &&
      block.includes(`[[hooks.${eventConfig.event}.hooks]]`) &&
      block.includes(expected)
    if (hasEvent) installed.push(eventConfig.event)
    else missing.push(eventConfig.event)
  }
  if (!hasFeatures) missing.push('[features].hooks = true')

  return {
    installed: installed.length + (hasFeatures ? 1 : 0),
    total: HOOK_EVENTS.length + 1,
    missing,
    path: currentPath
  }
}

module.exports = { install, uninstall, status, HOOK_EVENTS, CONFIG_FILE }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Traex: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Traex: ${r.skipped ? r.reason : 'ok'}`)
  }
}
