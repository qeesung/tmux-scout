#!/usr/bin/env node
// tmux-scout Gemini CLI hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const SETTINGS_FILE = path.join(os.homedir(), '.gemini', 'settings.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const AGENT_ARG = ['--agent', 'gemini']
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const HOOK_TIMEOUT_MS = 5000
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'PreCompress',
  'Notification'
]

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

function readSettings() {
  try {
    fs.statSync(SETTINGS_FILE)
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw new Error(`Failed to read ${SETTINGS_FILE}: ${error.message}`)
  }
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to read ${SETTINGS_FILE}: ${error.message}`)
  }
}

function writeSettings(settings) {
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
}

function command() {
  return buildNodeHookCommand(HOOK_PATH, AGENT_ARG)
}

function isScoutHook(entry) {
  return Boolean(entry && typeof entry.command === 'string'
    && (entry.command.includes(HOOK_IDENTIFIER) || entry.command.includes(HOOK_PATH))
    && entry.command.includes('--agent') && entry.command.includes('gemini'))
}

function removeScoutHookEntries(groups) {
  const keptGroups = []
  let removed = false

  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      keptGroups.push(group)
      continue
    }

    const hooks = group.hooks.filter(entry => !isScoutHook(entry))
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

function install() {
  const settings = readSettings()
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  const results = []
  const expectedCommand = command()

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const filtered = removeScoutHookEntries(current)
    const already = filtered.removed &&
      current.some(group => group && Array.isArray(group.hooks) && group.hooks.some(entry => isScoutHook(entry) && entry.command === expectedCommand))
    filtered.groups.push({ matcher: '*', hooks: [{ type: 'command', command: expectedCommand, timeout: HOOK_TIMEOUT_MS }] })
    settings.hooks[event] = filtered.groups
    results.push({ event, action: already ? 'ok' : filtered.removed ? 'updated' : 'installed' })
  }

  writeSettings(settings)
  return { results, path: HOOK_PATH }
}

function uninstall() {
  const settings = readSettings()
  const results = []
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { skipped: true, reason: 'no hooks configured' }
  }

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const filtered = removeScoutHookEntries(current)
    if (filtered.groups.length === 0) delete settings.hooks[event]
    else settings.hooks[event] = filtered.groups
    results.push({ event, action: filtered.removed ? 'removed' : 'not_found' })
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(settings)
  return { results }
}

function status() {
  const settings = readSettings()
  const installed = []
  const missing = []
  let currentPath = null
  const expectedCommand = command()

  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const found = groups.flatMap(group => Array.isArray(group.hooks) ? group.hooks : []).find(isScoutHook)
    if (found) {
      if (!currentPath) currentPath = extractHookPathFromCommand(found.command, 'generic.js')
      if (found.command === expectedCommand) installed.push(event)
      else missing.push(event)
    } else {
      missing.push(event)
    }
  }

  return { installed: installed.length, total: HOOK_EVENTS.length, missing, path: currentPath }
}

module.exports = { install, uninstall, status, HOOK_EVENTS }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Gemini: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Gemini: ${r.skipped ? r.reason : 'ok'}`)
  }
}
