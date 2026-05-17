#!/usr/bin/env node
// tmux-scout Trae CLI hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const MANAGED_AGENT_NAMES = ['trae', 'coco']
const HOOK_EVENTS = [
  { event: 'user_prompt_submit' },
  { event: 'pre_tool_use' },
  { event: 'post_tool_use' },
  { event: 'post_tool_use_failure' },
  { event: 'permission_request', timeout: 86400 },
  { event: 'stop' },
  { event: 'session_start' },
  { event: 'session_end' },
  { event: 'subagent_start' },
  { event: 'subagent_stop' },
  { event: 'notification' }
]

function configCandidates() {
  const home = os.homedir()
  return [
    path.join(home, '.trae', 'traecli.yaml'),
    path.join(home, '.trae', 'coco.yaml'),
    path.join(home, 'Library', 'Application Support', 'coco', 'coco.yaml')
  ]
}

function configPath() {
  for (const candidate of configCandidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return configCandidates()[0]
}

function readConfig(filePath = configPath()) {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8')
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
  return buildNodeHookCommand(HOOK_PATH, ['--agent', 'trae'])
}

function containsScoutHook(text) {
  const value = String(text || '')
  return (value.includes(HOOK_IDENTIFIER) || value.includes(HOOK_PATH)) &&
    value.includes('--agent') &&
    MANAGED_AGENT_NAMES.some(agent => value.includes(agent))
}

function yamlString(value) {
  return JSON.stringify(String(value))
}

function contentLines(content) {
  const lines = String(content || '').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isRootKey(line) {
  if (!line || /^\s/.test(line) || /^#/.test(line) || /^-/.test(line)) return false
  return /:(?:\s|$)/.test(line)
}

function splitHooksSection(content) {
  const lines = contentLines(content)
  const start = lines.findIndex(line => /^hooks:\s*(?:#.*)?$/.test(line))
  if (start < 0) return { before: lines, hookLines: null, after: [] }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (isRootKey(lines[i])) {
      end = i
      break
    }
  }
  return {
    before: lines.slice(0, start),
    hookLines: lines.slice(start, end),
    after: lines.slice(end)
  }
}

function isHookEntryStart(line) {
  return /^ {4}-\s+/.test(line)
}

function removeScoutHookEntries(hookLines) {
  if (!hookLines) return { hookLines: ['hooks:'], removed: false }
  const kept = [hookLines[0] || 'hooks:']
  let block = []
  let removed = false

  function flush() {
    if (block.length === 0) return
    if (containsScoutHook(block.join('\n'))) removed = true
    else kept.push(...block)
    block = []
  }

  for (const line of hookLines.slice(1)) {
    if (isHookEntryStart(line)) {
      flush()
      block = [line]
    } else if (block.length > 0) {
      block.push(line)
    } else if (line.trim()) {
      kept.push(line)
    }
  }
  flush()
  return { hookLines: kept, removed }
}

function hookBlock(hookCommand) {
  const lines = [
    '    - type: command',
    `      command: ${yamlString(hookCommand)}`,
    '      matchers:'
  ]
  for (const eventConfig of HOOK_EVENTS) {
    lines.push(`        - event: ${eventConfig.event}`)
    if (eventConfig.timeout) lines.push(`          timeout: ${eventConfig.timeout}`)
  }
  return lines
}

function buildContent(before, hookLines, after) {
  const lines = []
  lines.push(...before.filter((line, index, arr) => line !== '' || index < arr.length - 1))
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push(...hookLines)
  if (after.length > 0) {
    if (lines[lines.length - 1] !== '') lines.push('')
    lines.push(...after)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
}

function install() {
  const target = configPath()
  const original = readConfig(target)
  const section = splitHooksSection(original)
  const cleaned = removeScoutHookEntries(section.hookLines)
  const nextHooks = cleaned.hookLines.concat(hookBlock(command()))
  writeAtomic(target, buildContent(section.before, nextHooks, section.after))
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: cleaned.removed ? 'updated' : 'installed'
    })),
    path: HOOK_PATH
  }
}

function uninstall() {
  const targets = configCandidates().filter(candidate => fs.existsSync(candidate))
  if (targets.length === 0) return { skipped: true, reason: 'Trae config not found' }
  let removed = false
  for (const target of targets) {
    const original = readConfig(target)
    const section = splitHooksSection(original)
    if (!section.hookLines) continue
    const cleaned = removeScoutHookEntries(section.hookLines)
    if (!cleaned.removed) continue
    removed = true
    writeAtomic(target, buildContent(section.before, cleaned.hookLines, section.after))
  }
  return {
    results: HOOK_EVENTS.map(eventConfig => ({
      event: eventConfig.event,
      action: removed ? 'removed' : 'not_found'
    }))
  }
}

function status() {
  const target = configPath()
  const content = readConfig(target)
  const installed = []
  const missing = []
  let currentPath = null
  const section = splitHooksSection(content)
  const hasScout = section.hookLines && containsScoutHook(section.hookLines.join('\n'))
  if (hasScout) currentPath = extractHookPathFromCommand(section.hookLines.join('\n'), 'generic.js')
  for (const eventConfig of HOOK_EVENTS) {
    const hasEvent = hasScout && new RegExp(`event:\\s*["']?${eventConfig.event}["']?`).test(section.hookLines.join('\n'))
    if (hasEvent && section.hookLines.join('\n').includes(command())) installed.push(eventConfig.event)
    else missing.push(eventConfig.event)
  }
  return { installed: installed.length, total: HOOK_EVENTS.length, missing, path: currentPath }
}

module.exports = { install, uninstall, status, HOOK_EVENTS, configCandidates, configPath }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Trae: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Trae: ${r.skipped ? r.reason : 'ok'}`)
  }
}
