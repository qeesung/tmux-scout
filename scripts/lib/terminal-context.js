// Best-effort terminal metadata captured by hook processes.

const { execFileSync } = require('child_process')

function safeExec(file, args, timeout = 200) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout
    }).trim()
  } catch (_) {
    return ''
  }
}

function normalizeTty(value) {
  const text = String(value || '').trim()
  if (!text || text === '??' || text === '?') return null
  return text.startsWith('/dev/') ? text : `/dev/${text}`
}

function parentPid(pid) {
  const output = safeExec('/bin/ps', ['-p', String(pid), '-o', 'ppid='])
  const parsed = Number.parseInt(output, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function getTtyByPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const output = safeExec('/bin/ps', ['-p', String(pid), '-o', 'tty='])
  return normalizeTty(output.split(/\s+/)[0])
}

function processEnvLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  return safeExec('/bin/ps', ['eww', '-p', String(pid)], 300)
}

function envFromLine(line, name) {
  if (!line) return null
  const marker = `${name}=`
  const index = line.indexOf(marker)
  if (index < 0) return null
  const start = index + marker.length
  const end = line.indexOf(' ', start)
  const value = end >= 0 ? line.slice(start, end) : line.slice(start)
  return value || null
}

function getEnvFromProcessTree(name, startPid = process.pid, cache = null) {
  if (process.env[name]) return process.env[name]
  let pid = Number.isInteger(startPid) && startPid > 0 ? startPid : process.pid
  const seen = new Set()
  const lineCache = cache && cache.lines
  const parentCache = cache && cache.parents
  for (let depth = 0; depth < 12 && pid && !seen.has(pid); depth++) {
    seen.add(pid)
    let line
    if (lineCache) {
      if (!lineCache.has(pid)) lineCache.set(pid, processEnvLine(pid))
      line = lineCache.get(pid)
    } else {
      line = processEnvLine(pid)
    }
    const value = envFromLine(line, name)
    if (value) return value
    if (parentCache) {
      if (!parentCache.has(pid)) parentCache.set(pid, parentPid(pid))
      pid = parentCache.get(pid)
    } else {
      pid = parentPid(pid)
    }
  }
  return null
}

function normalizeTerminalApp(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text === 'Apple_Terminal') return 'Terminal'
  if (text === 'iTerm.app') return 'iTerm'
  if (text.toLowerCase().includes('ghostty')) return 'Ghostty'
  if (text.toLowerCase().includes('wezterm')) return 'WezTerm'
  if (text.toLowerCase().includes('vscode')) return 'VS Code'
  return text
}

function detectTerminalApp(startPid, cache) {
  const termProgram = getEnvFromProcessTree('TERM_PROGRAM', startPid, cache)
  if (termProgram) return normalizeTerminalApp(termProgram)
  if (getEnvFromProcessTree('GHOSTTY_RESOURCES_DIR', startPid, cache)) return 'Ghostty'
  if (getEnvFromProcessTree('KITTY_WINDOW_ID', startPid, cache)) return 'kitty'
  if (getEnvFromProcessTree('WEZTERM_PANE', startPid, cache)) return 'WezTerm'
  if (getEnvFromProcessTree('WT_SESSION', startPid, cache)) return 'Windows Terminal'
  if (getEnvFromProcessTree('VSCODE_IPC_HOOK_CLI', startPid, cache)) return 'VS Code'
  if (process.env.TMUX) return 'tmux'
  return null
}

function firstEnv(names, startPid, cache) {
  for (const name of names) {
    const value = getEnvFromProcessTree(name, startPid, cache)
    if (value) return value
  }
  return null
}

function terminalContext(startPid) {
  const pid = Number.isInteger(startPid) && startPid > 0 ? startPid : process.pid
  const cache = { lines: new Map(), parents: new Map() }
  const context = {
    terminalApp: detectTerminalApp(pid, cache),
    terminalTty: getTtyByPid(pid) || getTtyByPid(parentPid(pid)) || normalizeTty(process.env.SSH_TTY),
    terminalSessionId: firstEnv([
      'ITERM_SESSION_ID',
      'TERM_SESSION_ID',
      'KITTY_WINDOW_ID',
      'WEZTERM_PANE',
      'WT_SESSION',
      'VSCODE_IPC_HOOK_CLI'
    ], pid, cache),
    terminalWindowId: firstEnv(['WINDOWID', 'KITTY_WINDOW_ID', 'WEZTERM_UNIX_SOCKET'], pid, cache),
    kittyListenOn: firstEnv(['KITTY_LISTEN_ON'], pid, cache)
  }

  const compact = {}
  for (const [key, value] of Object.entries(context)) {
    if (value !== null && value !== undefined && value !== '') compact[key] = value
  }
  return compact
}

module.exports = {
  normalizeTty,
  getTtyByPid,
  getEnvFromProcessTree,
  terminalContext
}
