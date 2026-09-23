// What every Jev call cost and how long it took.
//
// The counters the observer already keeps answer "how often did this run".
// They do not answer the two questions you actually ask when deciding whether
// to leave this switched on: how much am I spending, and is it fast enough to
// keep up with a 2-second tick. Latency was being computed by the client and
// thrown away, and token usage only ever reached the answer cache.
//
// Two outputs, because they answer different questions:
//
//   * live aggregates, in `watcher status` — the current process, cheap, always on
//   * an append-only JSONL log — history across restarts, which is the only way
//     to see a slow drift in latency or a hit rate that decayed after a change
//
// Latency percentiles come from a bounded ring of the most recent samples
// rather than a full history: a watcher runs for weeks, and what you want from
// p95 is "is it slow now", not an average over a fortnight.

const os = require('os')
const path = require('path')
const { appendJsonl, readJsonl } = require('./pane-store')

const METRICS_FILE = path.join(os.homedir(), '.tmux-scout', 'pane-metrics.jsonl')

// Input only. TypeSafe bills nothing for output on System One, which is the
// single largest reason this feature is affordable at all.
const USD_PER_INPUT_MTOK = 0.042
const LATENCY_SAMPLES = 100
// Below this, a per-hour rate extrapolated from the sample is arithmetically
// correct and practically nonsense — three calls in the first ten seconds
// project to a number that would talk someone out of the feature. Reported as
// null until there is enough uptime to mean anything.
const MIN_RATE_UPTIME_MS = 5 * 60 * 1000
const MAX_METRICS_BYTES = 2 * 1024 * 1024

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}

function createPaneMetrics(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  // Writing a line per call is the point — a sampled log cannot show you the
  // one 8-second timeout that mattered — but it is still off unless asked for,
  // because most of the time the live aggregates are enough.
  //
  // Mutable because the watcher reconfigures a running observer rather than
  // restarting: this object is carried across a rebuild to keep the totals, so
  // a logging switch held in the original closure would never take effect.
  let file = options.file || METRICS_FILE
  let logCalls = options.logCalls === true

  const totals = { calls: 0, ok: 0, failed: 0, inputTokens: 0, latencyMs: 0, maxLatencyMs: 0 }
  const errorsByKind = {}
  const latencies = []
  let cursor = 0
  let startedAt = now()

  function recordLatency(ms) {
    if (!Number.isFinite(ms) || ms < 0) return
    totals.latencyMs += ms
    if (ms > totals.maxLatencyMs) totals.maxLatencyMs = ms
    if (latencies.length < LATENCY_SAMPLES) latencies.push(ms)
    else {
      latencies[cursor] = ms
      cursor = (cursor + 1) % LATENCY_SAMPLES
    }
  }

  function append(row) {
    if (logCalls) appendJsonl(file, row, MAX_METRICS_BYTES)
  }

  // `result` is exactly what jev-client.classify() resolved with, so nothing
  // here has to know how the SDK reports anything.
  function recordCall(result, context = {}) {
    totals.calls++
    recordLatency(result && result.latencyMs)

    const row = {
      at: now(),
      sessionId: context.sessionId,
      agent: context.agentType,
      ms: result && Number.isFinite(result.latencyMs) ? result.latencyMs : null
    }

    if (result && result.ok) {
      totals.ok++
      const input = result.usage && Number(result.usage.input_tokens)
      if (Number.isFinite(input)) {
        totals.inputTokens += input
        row.inputTokens = input
      }
      row.ok = true
    } else {
      totals.failed++
      const kind = (result && result.errorKind) || 'unknown'
      errorsByKind[kind] = (errorsByKind[kind] || 0) + 1
      row.ok = false
      row.error = kind
    }

    append(row)
  }

  function snapshot(extra = {}) {
    const sorted = [...latencies].sort((a, b) => a - b)
    const elapsedMs = Math.max(1, now() - startedAt)
    const cacheHits = Number(extra.cacheHits) || 0
    const lookups = totals.calls + cacheHits
    return {
      calls: totals.calls,
      ok: totals.ok,
      failed: totals.failed,
      errorsByKind: Object.assign({}, errorsByKind),
      latency: {
        meanMs: totals.calls > 0 ? Math.round(totals.latencyMs / totals.calls) : 0,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: totals.maxLatencyMs
      },
      inputTokens: totals.inputTokens,
      costUsd: Number(((totals.inputTokens / 1e6) * USD_PER_INPUT_MTOK).toFixed(6)),
      // What this would cost left running as it is now. The number people
      // actually want is a monthly bill, and a per-hour rate is the honest way
      // to get there before a month has passed.
      costUsdPerHour: elapsedMs < MIN_RATE_UPTIME_MS
        ? null
        : Number((((totals.inputTokens / 1e6) * USD_PER_INPUT_MTOK) / (elapsedMs / 3600000)).toFixed(4)),
      // Paid calls as a share of every screen that needed an answer. This is the
      // one number that says whether normalization is still working: it should
      // stay low, and it climbing means animation is leaking through and being
      // billed for.
      paidShare: lookups > 0 ? Number((totals.calls / lookups).toFixed(3)) : 0,
      uptimeMs: elapsedMs
    }
  }

  return {
    configure(next = {}) {
      if (typeof next.logCalls === 'boolean') logCalls = next.logCalls
      if (next.file) file = next.file
    },
    recordCall,
    snapshot,
    reset() {
      totals.calls = 0
      totals.ok = 0
      totals.failed = 0
      totals.inputTokens = 0
      totals.latencyMs = 0
      totals.maxLatencyMs = 0
      latencies.length = 0
      cursor = 0
      startedAt = now()
      for (const key of Object.keys(errorsByKind)) delete errorsByKind[key]
    }
  }
}

function readMetrics({ sinceMs = 0, file = METRICS_FILE } = {}) {
  return readJsonl(file, sinceMs)
}

module.exports = {
  METRICS_FILE,
  MIN_RATE_UPTIME_MS,
  USD_PER_INPUT_MTOK,
  percentile,
  createPaneMetrics,
  readMetrics
}
