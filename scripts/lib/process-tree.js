// Process tree helpers used to bind tmux panes to real agent CLI PIDs.

const path = require('path')
const { execFileSync } = require('child_process')
const { scoreAgentProcess } = require('./agents')

function readProcessTable() {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const byPid = new Map()
    const childrenByPpid = new Map()

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.+))?$/)
      if (!match) continue
      const pid = Number.parseInt(match[1], 10)
      const ppid = Number.parseInt(match[2], 10)
      const command = match[3].trim()
      const args = (match[4] || command).trim()
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
      const proc = { pid, ppid, command, args, commandLine: args, basename: path.basename(command) }
      byPid.set(pid, proc)
      if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
      childrenByPpid.get(ppid).push(proc)
    }

    return { byPid, childrenByPpid }
  } catch (_) {
    return { byPid: new Map(), childrenByPpid: new Map() }
  }
}

function descendantsOf(rootPid, table) {
  const result = []
  const queue = Array.from((table.childrenByPpid && table.childrenByPpid.get(rootPid)) || [])
  const seen = new Set()

  while (queue.length > 0) {
    const proc = queue.shift()
    if (!proc || seen.has(proc.pid)) continue
    seen.add(proc.pid)
    result.push(proc)
    for (const child of (table.childrenByPpid.get(proc.pid) || [])) {
      queue.push(child)
    }
  }

  return result
}

function isScoutHookProcess(proc) {
  const command = String(proc && (proc.commandLine || proc.args || proc.command) || '')
  return /(?:^|\s|\/)scripts\/hooks\/[^/\s]+\.js(?:\s|$)/.test(command)
    || /tmux-scout[^\s]*\/scripts\/hooks\/[^/\s]+\.js(?:\s|$)/.test(command)
}

function findAgentProcessFromPane(panePid, agentType, table) {
  if (!Number.isInteger(panePid) || panePid <= 0) return null
  const processTable = table || readProcessTable()
  const candidates = descendantsOf(panePid, processTable)
    .filter(proc => !isScoutHookProcess(proc))
    .map(proc => Object.assign({}, proc, { score: scoreAgentProcess(proc, agentType) }))
    .filter(proc => proc.score > 0)
    .sort((left, right) => right.score - left.score)

  return candidates[0] || null
}

module.exports = {
  readProcessTable,
  findAgentProcessFromPane,
  scoreAgentProcess
}
