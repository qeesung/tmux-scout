#!/usr/bin/env node
// tmux-scout Codex hook management
// Manages notify hook in ~/.codex/config.toml

const fs = require('fs')
const path = require('path')
const os = require('os')

const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml')
const SCOUT_DIR = path.join(os.homedir(), '.tmux-scout')
const ORIGINAL_NOTIFY_FILE = path.join(SCOUT_DIR, 'codex-original-notify.json')
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'codex.js')
const HOOK_IDENTIFIER = 'tmux-scout/scripts/hooks/codex.js'

const NOTIFY_REGEX = /^notify\s*=\s*\[([^\]]*)\]/m

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

function buildNotifyLine(hookPath) {
  return `notify = [\n  "node",\n  "${hookPath}"\n]`
}

function install() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    return { skipped: true, reason: 'Codex not installed (~/.codex/config.toml not found)' }
  }

  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')

  // Check if already installed with correct path
  if (content.includes(HOOK_PATH)) {
    return { action: 'ok', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
  }

  // Check if installed with different path (repo moved)
  if (content.includes(HOOK_IDENTIFIER)) {
    // Path changed — update in place
    const newNotify = buildNotifyLine(HOOK_PATH)
    const newContent = content.replace(NOTIFY_REGEX, newNotify)
    writeAtomic(CODEX_CONFIG, newContent)
    return { action: 'updated', hasOriginalNotify: fs.existsSync(ORIGINAL_NOTIFY_FILE) }
  }

  // Fresh install — backup original notify
  const originalNotify = parseNotifyArray(content)
  if (!fs.existsSync(SCOUT_DIR)) {
    fs.mkdirSync(SCOUT_DIR, { recursive: true })
  }
  if (!fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    writeAtomic(ORIGINAL_NOTIFY_FILE, JSON.stringify({ notify: originalNotify }, null, 2))
  }

  const newNotify = buildNotifyLine(HOOK_PATH)
  const match = content.match(NOTIFY_REGEX)
  let newContent
  if (match) {
    newContent = content.replace(NOTIFY_REGEX, newNotify)
  } else {
    const lines = content.split('\n')
    let insertIdx = 0
    while (insertIdx < lines.length && lines[insertIdx].startsWith('#')) {
      insertIdx++
    }
    lines.splice(insertIdx, 0, newNotify)
    newContent = lines.join('\n')
  }

  writeAtomic(CODEX_CONFIG, newContent)
  return { action: 'installed', hasOriginalNotify: originalNotify !== null }
}

function uninstall() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    return { skipped: true, reason: 'Codex not installed' }
  }

  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  if (!content.includes(HOOK_IDENTIFIER)) {
    return { action: 'not_found' }
  }

  // Restore original notify if we have a backup
  let newContent
  if (fs.existsSync(ORIGINAL_NOTIFY_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ORIGINAL_NOTIFY_FILE, 'utf-8'))
      if (saved && Array.isArray(saved.notify) && saved.notify.length > 0) {
        // Restore original notify
        const restored = `notify = [\n${saved.notify.map(s => `  "${s}"`).join(',\n')}\n]`
        newContent = content.replace(NOTIFY_REGEX, restored)
      } else {
        // Original had no notify — remove the line
        newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
      }
      fs.unlinkSync(ORIGINAL_NOTIFY_FILE)
    } catch (e) {
      // Backup corrupted — just remove notify line
      newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
    }
  } else {
    // No backup — just remove the notify line
    newContent = content.replace(NOTIFY_REGEX, '').replace(/^\s*\n/gm, '\n')
  }

  writeAtomic(CODEX_CONFIG, newContent)
  return { action: 'removed' }
}

function status() {
  if (!fs.existsSync(CODEX_CONFIG)) {
    return { installed: false, available: false }
  }

  const content = fs.readFileSync(CODEX_CONFIG, 'utf-8')
  if (content.includes(HOOK_IDENTIFIER)) {
    // Extract actual path
    const match = content.match(NOTIFY_REGEX)
    let currentPath = null
    if (match) {
      const strings = []
      const strRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g
      let strMatch
      while ((strMatch = strRegex.exec(match[1])) !== null) {
        strings.push(strMatch[1])
      }
      if (strings.length >= 2) currentPath = strings[1]
    }
    return { installed: true, available: true, path: currentPath }
  }

  return { installed: false, available: true }
}

module.exports = { install, uninstall, status }

// Standalone execution
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
