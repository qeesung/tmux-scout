// Best-effort runtime and terminal metadata captured by hook processes.

const os = require('os')
const { execFileSync } = require('child_process')
const { readProcessTable, findAgentProcessFromPane, isScoutHookProcess } = require('./process-tree')
const { scoreAgentProcess } = require('./agents')

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

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10)
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

function processSummary(proc) {
  if (!proc) return null
  return String(proc.commandLine || proc.args || proc.command || proc.basename || '').trim() || null
}

function processFromTable(table, pid) {
  if (!table || !table.byPid || !Number.isInteger(pid) || pid <= 0) return null
  return table.byPid.get(pid) || null
}

function parentFromTable(table, pid) {
  const proc = processFromTable(table, pid)
  if (proc && Number.isInteger(proc.ppid) && proc.ppid > 0) return proc.ppid
  return parentPid(pid)
}

function findAgentAncestor(startPid, agentType, table) {
  let pid = positiveInt(startPid)
  if (!pid) return null
  const seen = new Set()
  // Return the NEAREST scoring ancestor, not the highest-scoring one. Walking past a
  // real agent to an outer ancestor with a higher score would mis-bind nested
  // same-type sessions (e.g. an inner claude under a parent claude). Shell processes
  // already score 0 via SHELL_BASENAMES in scoreAgentProcess, so transient zsh
  // wrappers can't win this loop.
  for (let depth = 0; depth < 16 && pid && !seen.has(pid); depth++) {
    seen.add(pid)
    const proc = processFromTable(table, pid)
    if (proc && !isScoutHookProcess(proc) && scoreAgentProcess(proc, agentType) > 0) {
      return proc
    }
    pid = parentFromTable(table, pid)
  }
  return null
}

function tmuxPanePid(paneId) {
  if (!paneId) return null
  const output = safeExec('tmux', ['display-message', '-p', '-t', String(paneId), '#{pane_pid}'])
  return positiveInt(output)
}

function resolveAgentProcess(options = {}) {
  const agentType = options.agentType || 'unknown'
  const table = options.processTable || readProcessTable()
  const payloadPid = positiveInt(options.payloadPid)
  const hookPid = positiveInt(options.hookPid) || process.pid
  const parent = positiveInt(options.parentPid) || parentPid(hookPid)

  const payloadProc = processFromTable(table, payloadPid)
  if (payloadProc && !isScoutHookProcess(payloadProc) && scoreAgentProcess(payloadProc, agentType) > 0) {
    return {
      pid: payloadProc.pid,
      pidSource: 'payload',
      pidCommand: processSummary(payloadProc)
    }
  }

  for (const startPid of [hookPid, parent, payloadPid]) {
    const proc = findAgentAncestor(startPid, agentType, table)
    if (proc) {
      return {
        pid: proc.pid,
        pidSource: 'parent-chain',
        pidCommand: processSummary(proc)
      }
    }
  }

  const panePidResolver = options.panePidResolver || tmuxPanePid
  const panePid = positiveInt(options.panePid) || panePidResolver(options.tmuxPane)
  const paneAgent = findAgentProcessFromPane(panePid, agentType, table)
  if (paneAgent) {
    return {
      pid: paneAgent.pid,
      pidSource: 'process-tree',
      pidCommand: processSummary(paneAgent)
    }
  }

  if (payloadPid) {
    return {
      pid: payloadPid,
      pidSource: 'payload',
      pidCommand: processSummary(payloadProc)
    }
  }

  const parentProc = processFromTable(table, parent)
  if (parent) {
    return {
      pid: parent,
      pidSource: 'parent',
      pidCommand: processSummary(parentProc)
    }
  }

  return {
    pid: hookPid,
    pidSource: 'hook',
    pidCommand: processSummary(processFromTable(table, hookPid))
  }
}

function userName() {
  try {
    return os.userInfo().username || process.env.USER || null
  } catch (_) {
    return process.env.USER || null
  }
}

function hostIpAddresses() {
  const result = []
  try {
    const interfaces = os.networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (!entry || entry.internal || !entry.address) continue
        result.push(entry.address)
      }
    }
  } catch (_) {}
  return result
}

function hookRuntimeContext(payload = {}, options = {}) {
  const tmuxPane = options.tmuxPane || process.env.TMUX_PANE || null
  const resolved = resolveAgentProcess({
    agentType: options.agentType,
    payloadPid: payload.pid,
    hookPid: options.hookPid || process.pid,
    parentPid: options.parentPid || process.ppid,
    tmuxPane,
    panePid: options.panePid,
    processTable: options.processTable,
    panePidResolver: options.panePidResolver
  })
  const pid = positiveInt(resolved.pid)
  const context = Object.assign({
    hookPid: positiveInt(options.hookPid || process.pid),
    pid,
    pidSource: resolved.pidSource,
    pidCommand: resolved.pidCommand,
    hostName: os.hostname() || null,
    userName: userName(),
    sshClient: firstEnv(['SSH_CLIENT', 'SSH_CONNECTION'], pid || process.pid, { lines: new Map(), parents: new Map() })
  }, terminalContext(pid || process.pid))
  const ips = hostIpAddresses()
  if (ips.length > 0) context.hostIpAddresses = ips

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
  resolveAgentProcess,
  hookRuntimeContext,
  terminalContext
}
