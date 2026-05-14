#!/usr/bin/env node
// tmux-scout Kimi CLI hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const CONFIG_FILE = path.join(os.homedir(), '.kimi', 'config.toml')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'PreToolUse', timeout: 600 },
  { event: 'PostToolUse' },
  { event: 'PostToolUseFailure' },
  { event: 'PreCompact' },
  { event: 'PostCompact' },
  { event: 'Notification' }
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
  return buildNodeHookCommand(HOOK_PATH, ['--agent', 'kimi'])
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function containsScoutHook(block) {
  return block.includes(HOOK_IDENTIFIER) || block.includes(HOOK_PATH)
}

function isTomlHeader(line) {
  return /^\s*\[[^\]]+\]\s*$/.test(line) || /^\s*\[\[[^\]]+\]\]\s*$/.test(line)
}

function isHookHeader(line) {
  return /^\s*\[\[hooks\]\]\s*$/.test(line)
}

function removeScoutHookBlocks(content) {
  const lines = String(content || '').split('\n')
  const kept = []
  let block = []
  let inHook = false
  let removed = false

  function flush() {
    if (block.length === 0) return
    if (inHook && containsScoutHook(block.join('\n'))) {
      removed = true
    } else {
      kept.push(...block)
    }
    block = []
  }

  for (const line of lines) {
    if (isHookHeader(line)) {
      flush()
      inHook = true
      block = [line]
      continue
    }
    if (inHook && isTomlHeader(line)) {
      flush()
      inHook = false
      kept.push(line)
      continue
    }
    if (inHook) block.push(line)
    else kept.push(line)
  }
  flush()

  return { content: kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'), removed }
}

function hookBlock(eventConfig, hookCommand) {
  const lines = [
    '[[hooks]]',
    `event = ${tomlString(eventConfig.event)}`,
    `command = ${tomlString(hookCommand)}`
  ]
  if (eventConfig.timeout) lines.push(`timeout = ${eventConfig.timeout}`)
  return lines.join('\n')
}

function install() {
  const original = readConfig()
  const cleaned = removeScoutHookBlocks(original)
  const hookCommand = command()
  const blocks = HOOK_EVENTS.map(eventConfig => hookBlock(eventConfig, hookCommand))
  const prefix = cleaned.content.trim() ? cleaned.content.replace(/\s*$/, '\n\n') : ''
  writeAtomic(CONFIG_FILE, prefix + blocks.join('\n\n') + '\n')
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: cleaned.removed ? 'updated' : 'installed'
    })),
    path: HOOK_PATH
  }
}

function uninstall() {
  const original = readConfig()
  if (!original.trim()) return { skipped: true, reason: 'config.toml not found' }
  const cleaned = removeScoutHookBlocks(original)
  if (cleaned.removed) writeAtomic(CONFIG_FILE, cleaned.content)
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: cleaned.removed ? 'removed' : 'not_found'
    }))
  }
}

function parseHookBlocks(content) {
  const blocks = []
  const parts = String(content || '').split(/^\s*\[\[hooks\]\]\s*$/m)
  for (const part of parts.slice(1)) {
    const event = part.match(/^\s*event\s*=\s*"([^"]+)"/m)
    const cmd = part.match(/^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m)
    if (!event || !cmd) continue
    blocks.push({
      event: event[1],
      command: cmd[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
      raw: part
    })
  }
  return blocks
}

function status() {
  const content = readConfig()
  const blocks = parseHookBlocks(content).filter(block => containsScoutHook(block.raw))
  const installed = []
  const missing = []
  let currentPath = null
  const expected = command()
  for (const eventConfig of HOOK_EVENTS) {
    const found = blocks.find(block => block.event === eventConfig.event)
    if (found) {
      if (!currentPath) currentPath = extractHookPathFromCommand(found.command, 'generic.js')
      if (found.command === expected) installed.push(eventConfig.event)
      else missing.push(eventConfig.event)
    } else {
      missing.push(eventConfig.event)
    }
  }
  return { installed: installed.length, total: HOOK_EVENTS.length, missing, path: currentPath }
}

module.exports = { install, uninstall, status, HOOK_EVENTS }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Kimi: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Kimi: ${r.skipped ? r.reason : 'ok'}`)
  }
}
