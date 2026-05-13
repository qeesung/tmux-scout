// Process tree helpers used to bind tmux panes to real agent CLI PIDs.

const path = require('path')
const { execFileSync } = require('child_process')

function readProcessTable() {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const byPid = new Map()
    const childrenByPpid = new Map()

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) continue
      const pid = Number.parseInt(match[1], 10)
      const ppid = Number.parseInt(match[2], 10)
      const command = match[3].trim()
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
      const proc = { pid, ppid, command, basename: path.basename(command) }
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

function scoreAgentProcess(proc, agentType) {
  const name = String(proc.basename || '').toLowerCase()
  const command = String(proc.command || '').toLowerCase()
  const agent = String(agentType || '').toLowerCase()
  if (!agent) return 0

  if (agent === 'codex') {
    if (name === 'codex') return 100
    if (name.includes('codex')) return 80
    if (command.includes('/codex')) return 70
  }

  if (agent === 'claude') {
    if (name === 'claude') return 100
    if (name.includes('claude')) return 80
    if (command.includes('claude-code')) return 70
  }

  return 0
}

function findAgentProcessFromPane(panePid, agentType, table) {
  if (!Number.isInteger(panePid) || panePid <= 0) return null
  const processTable = table || readProcessTable()
  const candidates = descendantsOf(panePid, processTable)
    .map(proc => Object.assign({}, proc, { score: scoreAgentProcess(proc, agentType) }))
    .filter(proc => proc.score > 0)
    .sort((left, right) => right.score - left.score)

  return candidates[0] || null
}

module.exports = {
  readProcessTable,
  findAgentProcessFromPane
}
