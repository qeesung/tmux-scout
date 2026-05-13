// Generic JSONL readers with tail-only incremental support.

const fs = require('fs')

const DEFAULT_TAIL_BYTES = 128 * 1024

function splitJsonlLines(text) {
  return String(text || '').split('\n').filter(line => line.trim())
}

function parseJsonlLines(lines) {
  const objects = []
  let parsed = 0
  let parseErrors = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      objects.push(JSON.parse(line))
      parsed++
    } catch (_) {
      parseErrors++
    }
  }
  return { objects, parsed, parseErrors }
}

function readJsonlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = splitJsonlLines(content)
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

function readFileTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  try {
    const stat = fs.statSync(filePath)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    if (length <= 0) return { text: '', mtimeMs: stat.mtimeMs }

    let text = readFileRange(filePath, start, stat.size)
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return { text, mtimeMs: stat.mtimeMs }
  } catch (_) {
    return null
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
    const { objects, parsed, parseErrors } = parseJsonlLines(lines)

    state.offset = currentSize
    state.size = currentSize
    state.mtimeMs = stat.mtimeMs
    state.lastReadAt = Date.now()

    return { changed: reset || parsed > 0, objects, parsed, parseErrors, state, reset }
  } catch (_) {
    return null
  }
}

module.exports = {
  DEFAULT_TAIL_BYTES,
  splitJsonlLines,
  readFileTail,
  readJsonlFile,
  readJsonlIncremental
}
