#!/usr/bin/env node
// tmux-scout Antigravity CLI (agy) hook management.
//
// agy loads user hooks from ~/.gemini/config/hooks.json, whose top-level keys
// are hook names, each holding its own events. tmux-scout owns one name,
// "tmux-scout", and touches nothing else in the file: the desktop app and the
// IDE read it too.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildAgyHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const CLI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli')
const HOOKS_FILE = path.join(os.homedir(), '.gemini', 'config', 'hooks.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_NAME = 'tmux-scout'
const HOOK_TIMEOUT_SECONDS = 5
// PostInvocation is left out: it says nothing PreInvocation and Stop do not,
// and every hook blocks the agent loop while it runs.
const HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']
// Tool events take {matcher, hooks: [...]} groups; the others take handlers.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

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

function readHooks() {
  let text
  try {
    text = fs.readFileSync(HOOKS_FILE, 'utf-8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`Failed to read ${HOOKS_FILE}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`Failed to read ${HOOKS_FILE}: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Failed to read ${HOOKS_FILE}: expected a JSON object`)
  }
  return parsed
}

function writeHooks(hooks) {
  writeAtomic(HOOKS_FILE, JSON.stringify(hooks, null, 2) + '\n')
}

function command(event) {
  return buildAgyHookCommand(HOOK_PATH, event)
}

function handler(event) {
  return { type: 'command', command: command(event), timeout: HOOK_TIMEOUT_SECONDS }
}

function hookSpec() {
  const spec = { enabled: true }
  for (const event of HOOK_EVENTS) {
    spec[event] = TOOL_EVENTS.has(event)
      ? [{ matcher: '*', hooks: [handler(event)] }]
      : [handler(event)]
  }
  return spec
}

// The commands a spec runs for one event, whichever shape it was written in.
function commandsFor(spec, event) {
  const entries = spec && Array.isArray(spec[event]) ? spec[event] : []
  return entries.flatMap(entry => {
    if (entry && Array.isArray(entry.hooks)) return entry.hooks.map(item => item && item.command)
    return [entry && entry.command]
  }).filter(value => typeof value === 'string')
}

function install() {
  if (!fs.existsSync(CLI_DIR)) {
    return { skipped: true, reason: 'Antigravity CLI not found (~/.gemini/antigravity-cli)' }
  }
  const hooks = readHooks() || {}
  const previous = hooks[HOOK_NAME]
  const results = HOOK_EVENTS.map(event => {
    const commands = commandsFor(previous, event)
    const current = previous && previous.enabled !== false && commands.length === 1 && commands[0] === command(event)
    return { event, action: current ? 'ok' : commands.length > 0 ? 'updated' : 'installed' }
  })
  hooks[HOOK_NAME] = hookSpec()
  writeHooks(hooks)
  return { results, path: HOOK_PATH }
}

function uninstall() {
  const hooks = readHooks()
  if (!hooks || !hooks[HOOK_NAME]) return { skipped: true, reason: 'no hooks configured' }
  const previous = hooks[HOOK_NAME]
  const results = HOOK_EVENTS.map(event => ({
    event,
    action: commandsFor(previous, event).length > 0 ? 'removed' : 'not_found'
  }))
  delete hooks[HOOK_NAME]
  writeHooks(hooks)
  return { results }
}

function status() {
  const hooks = readHooks()
  const spec = hooks && hooks[HOOK_NAME]
  const installed = []
  const missing = []
  let currentPath = null
  for (const event of HOOK_EVENTS) {
    const commands = commandsFor(spec, event)
    if (!currentPath && commands.length > 0) currentPath = extractHookPathFromCommand(commands[0], 'generic.js')
    if (spec && spec.enabled !== false && commands.length === 1 && commands[0] === command(event)) installed.push(event)
    else missing.push(event)
  }
  return { installed: installed.length, total: HOOK_EVENTS.length, missing, path: currentPath }
}

module.exports = { install, uninstall, status, HOOK_EVENTS }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Antigravity CLI: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Antigravity CLI: ${r.skipped ? r.reason : 'ok'}`)
  }
}
