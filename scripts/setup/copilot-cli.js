#!/usr/bin/env node
// tmux-scout GitHub Copilot CLI hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const SETTINGS_FILE = path.join(os.homedir(), '.copilot', 'settings.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'agentStop',
  'subagentStop',
  'errorOccurred'
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

function commandFor(event) {
  return buildNodeHookCommand(HOOK_PATH, ['--agent', 'copilot-cli', '--event', event])
}

function isScoutHook(entry) {
  const command = entry && (entry.bash || entry.command)
  return Boolean(typeof command === 'string'
    && (command.includes(HOOK_IDENTIFIER) || command.includes(HOOK_PATH))
    && command.includes('copilot-cli'))
}

function install() {
  const settings = readSettings()
  settings.version = settings.version || 1
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  const results = []

  for (const event of HOOK_EVENTS) {
    const expected = commandFor(event)
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const hadScout = current.some(isScoutHook)
    const already = current.some(entry => isScoutHook(entry) && entry.bash === expected)
    const filtered = current.filter(entry => !isScoutHook(entry))
    filtered.push({ type: 'command', bash: expected, timeoutSec: 5 })
    settings.hooks[event] = filtered
    results.push({ event, action: already ? 'ok' : hadScout ? 'updated' : 'installed' })
  }

  writeSettings(settings)
  return { results, path: HOOK_PATH }
}

function uninstall() {
  const settings = readSettings()
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    return { skipped: true, reason: 'no hooks configured' }
  }
  const results = []
  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const filtered = current.filter(entry => !isScoutHook(entry))
    if (filtered.length === 0) delete settings.hooks[event]
    else settings.hooks[event] = filtered
    results.push({ event, action: filtered.length === current.length ? 'not_found' : 'removed' })
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
  for (const event of HOOK_EVENTS) {
    const entries = settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    const found = entries.find(isScoutHook)
    if (found) {
      const command = found.bash || found.command
      if (!currentPath) currentPath = extractHookPathFromCommand(command, 'generic.js')
      if (command === commandFor(event)) installed.push(event)
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
    console.log(`Copilot CLI: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Copilot CLI: ${r.skipped ? r.reason : 'ok'}`)
  }
}
