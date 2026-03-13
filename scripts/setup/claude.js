#!/usr/bin/env node
// tmux-scout Claude Code hook management
// Manages hooks in ~/.claude/settings.json

const fs = require('fs')
const path = require('path')
const os = require('os')

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'claude.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/claude.js'
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
]

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

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return null
  return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
}

function writeSettings(settings) {
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
}

function makeHookEntry() {
  return {
    type: 'command',
    command: `node "${HOOK_PATH}"`,
    timeout: 5
  }
}

function isScoutHook(hook) {
  return hook.command && hook.command.includes(HOOK_IDENTIFIER)
}

function install() {
  const settings = readSettings()
  if (!settings) {
    return { skipped: true, reason: 'settings.json not found' }
  }

  if (!settings.hooks) settings.hooks = {}

  const results = []
  let changed = false

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = []

    const groups = settings.hooks[event]
    // Find catch-all matcher group (matcher: "")
    let catchAll = groups.find(g => g.matcher === '')
    if (!catchAll) {
      catchAll = { matcher: '', hooks: [] }
      // Prepend so catch-all runs before specific matchers
      groups.unshift(catchAll)
    }

    const existing = catchAll.hooks.findIndex(h => isScoutHook(h))
    if (existing >= 0) {
      const current = catchAll.hooks[existing]
      const expected = makeHookEntry()
      if (current.command === expected.command) {
        results.push({ event, action: 'ok' })
      } else {
        // Path changed — update
        catchAll.hooks[existing] = expected
        changed = true
        results.push({ event, action: 'updated' })
      }
    } else {
      catchAll.hooks.push(makeHookEntry())
      changed = true
      results.push({ event, action: 'installed' })
    }
  }

  if (changed) writeSettings(settings)
  return { results, path: HOOK_PATH }
}

function uninstall() {
  const settings = readSettings()
  if (!settings || !settings.hooks) {
    return { skipped: true, reason: 'no hooks configured' }
  }

  let changed = false
  const results = []

  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks[event]
    if (!groups) {
      results.push({ event, action: 'not_found' })
      continue
    }

    let removed = false
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const group = groups[gi]
      const before = group.hooks.length
      group.hooks = group.hooks.filter(h => !isScoutHook(h))
      if (group.hooks.length < before) {
        removed = true
        changed = true
      }
      // Remove empty matcher groups
      if (group.hooks.length === 0) {
        groups.splice(gi, 1)
      }
    }

    // Remove empty event key
    if (groups.length === 0) {
      delete settings.hooks[event]
    }

    results.push({ event, action: removed ? 'removed' : 'not_found' })
  }

  // Remove empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks
  }

  if (changed) writeSettings(settings)
  return { results }
}

function status() {
  const settings = readSettings()
  if (!settings || !settings.hooks) {
    return { installed: 0, total: HOOK_EVENTS.length, missing: [...HOOK_EVENTS] }
  }

  const installed = []
  const missing = []
  let currentPath = null

  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks[event]
    if (!groups) { missing.push(event); continue }

    const catchAll = groups.find(g => g.matcher === '')
    if (!catchAll) { missing.push(event); continue }

    const hook = catchAll.hooks.find(h => isScoutHook(h))
    if (hook) {
      installed.push(event)
      if (!currentPath) {
        // Extract path from command
        const m = hook.command.match(/"([^"]*)"/)
        if (m) currentPath = m[1]
      }
    } else {
      missing.push(event)
    }
  }

  return {
    installed: installed.length,
    total: HOOK_EVENTS.length,
    missing,
    path: currentPath
  }
}

module.exports = { install, uninstall, status, HOOK_EVENTS }

// Standalone execution
if (require.main === module) {
  const cmd = process.argv[2]
  if (cmd === 'install') {
    const r = install()
    if (r.skipped) {
      console.log('Claude Code: ' + r.reason)
    } else {
      for (const { event, action } of r.results) {
        console.log(`  ${action === 'ok' ? '=' : '+'} ${event}: ${action}`)
      }
    }
  } else if (cmd === 'uninstall') {
    const r = uninstall()
    if (r.skipped) {
      console.log('Claude Code: ' + r.reason)
    } else {
      for (const { event, action } of r.results) {
        console.log(`  ${action === 'removed' ? '-' : '='} ${event}: ${action}`)
      }
    }
  } else if (cmd === 'status') {
    const r = status()
    console.log(`Claude Code: ${r.installed}/${r.total} hooks installed`)
    if (r.missing.length > 0) console.log('  Missing: ' + r.missing.join(', '))
  } else {
    console.log('Usage: claude.js <install|uninstall|status>')
  }
}
