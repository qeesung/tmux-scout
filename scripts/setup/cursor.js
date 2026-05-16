#!/usr/bin/env node
// tmux-scout Cursor Agent hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const HOOKS_FILE = path.join(os.homedir(), '.cursor', 'hooks.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const AGENT_ARG = ['--agent', 'cursor']
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'afterAgentResponse',
  'afterAgentThought',
  'afterFileEdit',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeReadFile',
  'beforeSubmitPrompt',
  'stop'
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

function readConfig() {
  try {
    fs.statSync(HOOKS_FILE)
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw new Error(`Failed to read ${HOOKS_FILE}: ${error.message}`)
  }
  try {
    return JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to read ${HOOKS_FILE}: ${error.message}`)
  }
}

function writeConfig(config) {
  writeAtomic(HOOKS_FILE, JSON.stringify(config, null, 2) + '\n')
}

function command() {
  return buildNodeHookCommand(HOOK_PATH, AGENT_ARG)
}

function isScoutHook(entry) {
  return Boolean(entry && typeof entry.command === 'string'
    && (entry.command.includes(HOOK_IDENTIFIER) || entry.command.includes(HOOK_PATH))
    && entry.command.includes('--agent') && entry.command.includes('cursor'))
}

function install() {
  const config = readConfig()
  config.version = config.version || 1
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {}
  const results = []
  const expectedCommand = command()

  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : []
    const hadScout = current.some(isScoutHook)
    const already = current.some(entry => isScoutHook(entry) && entry.command === expectedCommand)
    const filtered = current.filter(entry => !isScoutHook(entry))
    filtered.push({ command: expectedCommand })
    config.hooks[event] = filtered
    results.push({ event, action: already ? 'ok' : hadScout ? 'updated' : 'installed' })
  }

  writeConfig(config)
  return { results, path: HOOK_PATH }
}

function uninstall() {
  const config = readConfig()
  if (!config.hooks || typeof config.hooks !== 'object') {
    return { skipped: true, reason: 'no hooks configured' }
  }
  const results = []
  for (const event of HOOK_EVENTS) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : []
    const filtered = current.filter(entry => !isScoutHook(entry))
    if (filtered.length === 0) delete config.hooks[event]
    else config.hooks[event] = filtered
    results.push({ event, action: filtered.length === current.length ? 'not_found' : 'removed' })
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks
  writeConfig(config)
  return { results }
}

function status() {
  const config = readConfig()
  const installed = []
  const missing = []
  let currentPath = null
  const expectedCommand = command()

  for (const event of HOOK_EVENTS) {
    const entries = config.hooks && Array.isArray(config.hooks[event]) ? config.hooks[event] : []
    const found = entries.find(isScoutHook)
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
    console.log(`Cursor Agent: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Cursor Agent: ${r.skipped ? r.reason : 'ok'}`)
  }
}
