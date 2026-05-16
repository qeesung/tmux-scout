#!/usr/bin/env node
// tmux-scout Hermes hook management.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildNodeHookCommand, extractHookPathFromCommand } = require('../lib/hook-command')

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/generic.js'
const HOOK_EVENTS = [
  { event: 'on_session_start' },
  { event: 'on_session_reset' },
  { event: 'pre_llm_call' },
  { event: 'post_llm_call' },
  { event: 'pre_tool_call', timeout: 600 },
  { event: 'post_tool_call' },
  { event: 'pre_approval_request' },
  { event: 'post_approval_response' },
  { event: 'on_session_finalize' },
  { event: 'on_session_end' },
  { event: 'subagent_start' },
  { event: 'subagent_stop' }
]

function configCandidates() {
  const home = os.homedir()
  return [
    path.join(home, '.hermes', 'cli-config.yaml'),
    path.join(home, '.hermes', 'config.yaml')
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
  return buildNodeHookCommand(HOOK_PATH, ['--agent', 'hermes'])
}

function containsScoutHook(text) {
  const value = String(text || '')
  return (value.includes(HOOK_IDENTIFIER) || value.includes(HOOK_PATH)) && value.includes('--agent') && value.includes('hermes')
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

function removeScoutHookEntries(hookLines) {
  if (!hookLines) return { hookLines: ['hooks:'], removed: false }
  const kept = [hookLines[0] || 'hooks:']
  let eventBlock = []
  let removed = false

  function flush() {
    if (eventBlock.length === 0) return
    const header = eventBlock[0]
    const body = []
    let entry = []

    function flushEntry() {
      if (entry.length === 0) return
      if (containsScoutHook(entry.join('\n'))) removed = true
      else body.push(...entry)
      entry = []
    }

    for (const line of eventBlock.slice(1)) {
      if (/^\s{4}-\s+/.test(line)) {
        flushEntry()
        entry = [line]
      } else if (entry.length > 0) {
        entry.push(line)
      } else {
        body.push(line)
      }
    }
    flushEntry()
    if (body.some(line => line.trim())) kept.push(header, ...body)
    eventBlock = []
  }

  for (const line of hookLines.slice(1)) {
    if (/^\s{2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(line)) {
      flush()
      eventBlock = [line]
    } else if (eventBlock.length > 0) {
      eventBlock.push(line)
    } else if (line.trim()) {
      kept.push(line)
    }
  }
  flush()
  return { hookLines: kept, removed }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function eventHeaderPattern(event) {
  return new RegExp(`^\\s{2}${escapeRegExp(event)}:\\s*(?:#.*)?$`)
}

function isEventHeader(line, event) {
  return eventHeaderPattern(event).test(line)
}

function eventExists(hookLines, event) {
  return hookLines.some(line => isEventHeader(line, event))
}

function appendEntry(hookLines, eventConfig, hookCommand) {
  const header = `  ${eventConfig.event}:`
  const entry = [`    - command: ${yamlString(hookCommand)}`]
  if (eventConfig.timeout) entry.push(`      timeout: ${eventConfig.timeout}`)
  if (!eventExists(hookLines, eventConfig.event)) {
    hookLines.push(header, ...entry)
    return
  }

  let insertAt = hookLines.length
  const headerIndex = hookLines.findIndex(line => isEventHeader(line, eventConfig.event))
  if (headerIndex < 0) {
    hookLines.push(header, ...entry)
    return
  }
  for (let i = headerIndex + 1; i < hookLines.length; i++) {
    if (/^\s{2}[A-Za-z0-9_-]+:\s*(?:#.*)?$/.test(hookLines[i])) {
      insertAt = i
      break
    }
  }
  hookLines.splice(insertAt, 0, ...entry)
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
  const nextHooks = cleaned.hookLines.slice()
  const hookCommand = command()
  for (const eventConfig of HOOK_EVENTS) appendEntry(nextHooks, eventConfig, hookCommand)
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
  if (targets.length === 0) return { skipped: true, reason: 'Hermes config not found' }
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
  const section = splitHooksSection(content)
  const text = section.hookLines ? section.hookLines.join('\n') : ''
  const installed = []
  const missing = []
  let currentPath = null
  if (containsScoutHook(text)) currentPath = extractHookPathFromCommand(text, 'generic.js')
  for (const eventConfig of HOOK_EVENTS) {
    const hasEvent = containsScoutHook(text) && new RegExp(`^\\s{2}${eventConfig.event}:`, 'm').test(text)
    if (hasEvent && text.includes(command())) installed.push(eventConfig.event)
    else missing.push(eventConfig.event)
  }
  return { installed: installed.length, total: HOOK_EVENTS.length, missing, path: currentPath }
}

module.exports = { install, uninstall, status, HOOK_EVENTS, configCandidates, configPath }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`Hermes: ${r.installed === r.total ? 'hook installed' : 'hook not installed'}`)
  } else {
    console.log(`Hermes: ${r.skipped ? r.reason : 'ok'}`)
  }
}
