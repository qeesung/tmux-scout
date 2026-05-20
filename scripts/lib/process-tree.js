// Process tree helpers used to bind tmux panes to real agent CLI PIDs.

const path = require('path')
const { execFileSync } = require('child_process')
const { scoreAgentProcess } = require('./agents')

// ps etime format: "[[dd-]hh:]mm:ss" — convert to milliseconds.
function parseEtimeMs(etime) {
  if (typeof etime !== 'string') return null
  const match = etime.match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/)
  if (!match) return null
  const dd = Number.parseInt(match[1] || '0', 10)
  const hh = Number.parseInt(match[2] || '0', 10)
  const mm = Number.parseInt(match[3], 10)
  const ss = Number.parseInt(match[4], 10)
  return (((dd * 24 + hh) * 60) + mm) * 60_000 + ss * 1000
}

function readProcessTable() {
  try {
    const tableBuiltAt = Date.now()
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,comm=,args='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const byPid = new Map()
    const childrenByPpid = new Map()

    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/)
      if (!match) continue
      const pid = Number.parseInt(match[1], 10)
      const ppid = Number.parseInt(match[2], 10)
      const etimeMs = parseEtimeMs(match[3])
      const command = match[4].trim()
      const args = (match[5] || command).trim()
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
      const startedAtMs = etimeMs !== null ? tableBuiltAt - etimeMs : null
      const proc = { pid, ppid, command, args, commandLine: args, basename: path.basename(command), startedAtMs }
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
  // Boundary-free match so the wrapper sh -c "... '.../scripts/hooks/claude.js' ..."
  // is still recognized as a hook process despite the surrounding quotes.
  return /scripts\/hooks\/[^\s/'"]+\.js/.test(command)
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
  isScoutHookProcess,
  parseEtimeMs,
  scoreAgentProcess
}
