// Thin wrapper over the TypeSafe SDK: the only module here that touches the
// network, and the only one that may depend on an npm package.
//
// tmux-scout installs through TPM, `node_modules/` is gitignored, and nobody
// running the plugin has been asked to run `npm install`. So the SDK is an
// OPTIONAL dependency in practice: requiring it happens inside the factory
// behind try/catch, never at module load. A top-level require would crash
// every existing user the moment this file is pulled in, which is why there is
// a test that loads these modules with a poisoned require cache.
//
// For the same reason `engines.node` stays at >=16 even though the SDK needs
// 20: the version check belongs to the feature, not to the whole plugin.
//
// classify() never rejects. A watcher tick runs the pane and process liveness
// sweeps that everything else depends on; an optional classifier must not be
// able to take that down.

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const DEFAULT_MODEL = 'jev-latest'
const DEFAULT_TIMEOUT_MS = 8000
const MIN_NODE_MAJOR = 20
const KEY_FILE = path.join(os.homedir(), '.tmux-scout', 'typesafe.key')

function nodeMajor() {
  return Number.parseInt(String(process.versions.node).split('.')[0], 10) || 0
}

// The watcher is started by `tmux run-shell`, which inherits the environment
// the tmux server was started with — not the user's interactive shell. The
// plugin already works around this for PATH via SCOUT_PATH in tmux-scout.tmux,
// so the key follows the same route.
function keyFromTmux() {
  const name = 'TYPESAFE_API_KEY'
  try {
    const out = execFileSync('tmux', ['show-environment', '-g', name], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    // tmux prints `NAME=value` when set and `-NAME` when explicitly unset.
    return out.startsWith(`${name}=`) ? out.slice(name.length + 1) : ''
  } catch (_) {
    return ''
  }
}

function keyFromFile(log) {
  try {
    const stat = fs.statSync(KEY_FILE)
    // A credential readable by other local accounts is worth refusing loudly
    // rather than using quietly.
    if ((stat.mode & 0o077) !== 0) {
      if (log) log(`ignoring ${KEY_FILE}: file mode must be 0600`)
      return ''
    }
    return fs.readFileSync(KEY_FILE, 'utf-8').trim()
  } catch (_) {
    return ''
  }
}

// Where the watcher would find a key, for diagnosis. Kept next to the lookup it
// describes so the two cannot disagree: a doctor that only checked the file
// existed reported a 0644 key as fine while the watcher refused to read it.
function keyFileState() {
  try {
    const stat = fs.statSync(KEY_FILE)
    return (stat.mode & 0o077) !== 0 ? 'bad-mode' : 'ok'
  } catch (_) {
    return 'missing'
  }
}

// The tmux global environment before this process's own: that is where a key
// is rotated (`tmux set-environment -g`), and process.env is only a snapshot
// taken when the watcher started. Checked the other way round, a rotated key
// never reached a running watcher — the old one kept being sent, and refused.
function resolveApiKey(explicit, log) {
  return explicit || keyFromTmux() || process.env.TYPESAFE_API_KEY || keyFromFile(log) || ''
}

// Which key a client holds, without holding the key: enough to tell whether a
// fresh lookup found a different one.
function keyIdFor(apiKey) {
  return apiKey ? crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 12) : null
}

function errorKindFor(error) {
  const name = error && error.constructor && error.constructor.name
  const status = error && error.status
  if (name === 'APITimeoutError') return 'timeout'
  if (name === 'APIConnectionError') return 'offline'
  if (name === 'APIUserAbortError') return 'aborted'
  if (name === 'RateLimitError' || status === 429) return 'rate-limited'
  if (name === 'AuthenticationError' || status === 401) return 'auth'
  // Not the key: a 403 came back for one pane's screen while every other pane
  // was answered with the same key. Counted as `auth`, it read as a broken key
  // and flagged the whole client for a rebuild over one screen.
  if (name === 'PermissionDeniedError' || status === 403) return 'forbidden'
  if (Number.isFinite(status)) return 'http'
  return 'unknown'
}

function unavailable(reason, model) {
  return {
    available: false,
    reason,
    model,
    async classify() {
      return { ok: false, errorKind: reason, latencyMs: 0 }
    }
  }
}

// Takes a key, it does not go looking for one: resolveApiKey() is the caller's
// job. Keeping the search out of here is what lets a test assert the no-key path
// without a developer's own configured credentials leaking into it.
function createJevClient(options = {}) {
  const log = typeof options.log === 'function' ? options.log : null
  const model = options.model || DEFAULT_MODEL
  const apiKey = options.apiKey

  if (!apiKey) return unavailable('no-key', model)
  if (!options.sdk && nodeMajor() < MIN_NODE_MAJOR) return unavailable('node-too-old', model)

  let sdk = options.sdk
  if (!sdk) {
    try {
      sdk = require('@typesafe-ai/sdk')
    } catch (_) {
      return unavailable('no-sdk', model)
    }
  }

  let client
  try {
    client = new sdk.TypeSafeClient({
      apiKey,
      defaultModel: model,
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      // The SDK retries 408/429/5xx and timeouts twice by default, each attempt
      // with its own timeout. That hides up to three HTTP requests behind one
      // classify() — outside the observer's token bucket and concurrency cap —
      // and holds back the 429 that should start the account-wide cooldown
      // until the SDK has finished retrying, possibly a minute later under
      // Retry-After. The observer already schedules retries with backoff, and
      // for a screen that is re-read every few seconds a retry of a stale
      // capture is worth less than the next capture anyway.
      retry: { maxRetries: 0 },
      logLevel: options.logLevel || 'error'
    })
  } catch (error) {
    if (log) log(`typesafe client unavailable: ${error && error.message}`)
    return unavailable('no-sdk', model)
  }

  return {
    available: true,
    reason: null,
    model,
    keyId: keyIdFor(apiKey),
    async classify(state, questions) {
      const started = Date.now()
      try {
        const response = await client.systemOne({ state, questions, model })
        return {
          ok: true,
          answers: response.answers,
          usage: response.usage,
          model: response.model,
          latencyMs: Date.now() - started
        }
      } catch (error) {
        return {
          ok: false,
          errorKind: errorKindFor(error),
          error: error && error.message,
          status: error && Number.isFinite(error.status) ? error.status : undefined,
          latencyMs: Date.now() - started
        }
      }
    }
  }
}

module.exports = {
  KEY_FILE,
  keyFileState,
  MIN_NODE_MAJOR,
  createJevClient,
  resolveApiKey
}
