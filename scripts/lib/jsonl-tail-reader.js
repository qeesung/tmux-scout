// Generic JSONL readers with tail-only incremental support.

const fs = require('fs')

const DEFAULT_TAIL_BYTES = 128 * 1024

function parseJsonlLines(lines) {
  const objects = []
  let parsed = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      objects.push(JSON.parse(line))
      parsed++
    } catch (_) {}
  }
  return { objects, parsed }
}

function readJsonlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())
    if (lines.length === 0) return { objects: [], parsed: 0 }
    return parseJsonlLines(lines)
  } catch (_) {
    return null
  }
}

function readFileRange(filePath, start, endExclusive) {
  const length = Math.max(0, endExclusive - start)
  if (length === 0) return ''
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = fs.readSync(fd, buffer, 0, length, start)
    return buffer.toString('utf-8', 0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
}

function readJsonlIncremental(filePath, fileState, options = {}) {
  const state = fileState || {}
  const maxInitialBytes = options.maxInitialBytes || DEFAULT_TAIL_BYTES

  try {
    const stat = fs.statSync(filePath)
    const currentSize = stat.size
    const priorOffset = Number.isFinite(state.offset) ? state.offset : null
    const reset = !Number.isInteger(priorOffset) || priorOffset < 0 || currentSize < priorOffset

    if (!reset && currentSize === priorOffset) {
      state.size = currentSize
      state.mtimeMs = stat.mtimeMs
      return { changed: false, objects: [], parsed: 0, state }
    }

    if (reset) state.partialLine = ''

    let start = reset ? Math.max(0, currentSize - maxInitialBytes) : priorOffset
    let chunk = readFileRange(filePath, start, currentSize)

    if (reset && start > 0) {
      const firstNewline = chunk.indexOf('\n')
      chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : ''
    } else if (!reset && state.partialLine) {
      chunk = state.partialLine + chunk
    }

    const lines = chunk.split('\n')
    state.partialLine = lines.pop() || ''
    const { objects, parsed } = parseJsonlLines(lines)

    state.offset = currentSize
    state.size = currentSize
    state.mtimeMs = stat.mtimeMs
    state.lastReadAt = Date.now()

    return { changed: reset || parsed > 0, objects, parsed, state, reset }
  } catch (_) {
    return null
  }
}

module.exports = {
  DEFAULT_TAIL_BYTES,
  readJsonlFile,
  readJsonlIncremental
}
