// Local single-writer bridge for tmux-scout hook updates.

const fs = require('fs')
const net = require('net')
const { defaultPaths, ensureDirs, updateSessionDirect } = require('./hook-adapter')

function canConnect(socketPath, timeoutMs = 200) {
  return new Promise(resolve => {
    let done = false
    let socket = null
    function finish(ok) {
      if (done) return
      done = true
      try { socket.destroy() } catch (_) {}
      resolve(Boolean(ok))
    }
    try {
      socket = net.createConnection({ path: socketPath })
    } catch (_) {
      finish(false)
      return
    }
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
  })
}

async function cleanupSocket(socketPath, log) {
  if (!fs.existsSync(socketPath)) return
  const alive = await canConnect(socketPath)
  if (alive) {
    throw new Error(`bridge socket already in use: ${socketPath}`)
  }
  try {
    fs.unlinkSync(socketPath)
  } catch (error) {
    if (log) log(`bridge cleanup failed: ${error.message}`)
    throw error
  }
}

function handleMessage(message, paths) {
  if (!message || message.type !== 'update_session') {
    return { ok: false, error: 'unsupported message type' }
  }
  if (!message.sessionId || !message.updates || typeof message.updates !== 'object') {
    return { ok: false, error: 'invalid update_session message' }
  }

  updateSessionDirect({
    agentType: message.agentType || 'unknown',
    defaultStateSource: message.defaultStateSource || `${message.agentType || 'agent'}-hooks`,
    lifecycleForce: message.lifecycleForce !== false
  }, paths, String(message.sessionId), message.updates)

  return { ok: true }
}

async function startBridgeServer(options = {}) {
  const paths = options.paths || defaultPaths()
  const log = options.log || null
  ensureDirs(paths)
  await cleanupSocket(paths.bridgeSocket, log)

  const server = net.createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf-8')
    socket.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let response
        try {
          response = handleMessage(JSON.parse(line), paths)
        } catch (error) {
          response = { ok: false, error: error && error.message ? error.message : String(error) }
        }
        socket.write(JSON.stringify(response) + '\n')
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(paths.bridgeSocket, () => {
      server.off('error', reject)
      if (log) log(`bridge listening socket=${paths.bridgeSocket}`)
      resolve()
    })
  })

  function close() {
    try { server.close() } catch (_) {}
    try { fs.unlinkSync(paths.bridgeSocket) } catch (_) {}
  }

  return { server, socketPath: paths.bridgeSocket, close }
}

module.exports = {
  startBridgeServer,
  handleMessage
}
