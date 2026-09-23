// Content-addressed cache for pane classification answers.
//
// The premise of level-triggered state detection is that the state is a pure
// function of what the screen shows. The direct consequence is that the same
// screen must never be paid for twice — so the question this cache answers is
// "have these exact contents been classified before", not "did the contents
// change since last time". Those differ whenever a screen is revisited: a
// character typed into the composer and deleted again, a transient message that
// appears over a dialog and clears, a redraw. Normalization turns elapsed times
// and token counters into placeholders, which makes exact repeats far more
// common than they look.
//
// What is cached is the model's raw `answers`, never a finished verdict.
// Answers are a pure function of (screen, question set). A verdict is not: it
// also depends on the session's current phase and on the previous reading,
// because leaving a WAIT requires consecutive agreeing observations. Caching a
// verdict would therefore deadlock — a frozen screen would keep handing back
// "not enough evidence yet" and the session would never leave WAIT. Callers get
// answers back and re-run the (free, pure) interpretation with fresh context.
//
// Failures are deliberately not cached: a timeout or a 429 says nothing about
// the screen. Low-confidence successes ARE cached, because asking the same
// question about the same pixels a second time buys nothing.

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

function answerCacheKey(agentType, questionSetVersion, fingerprint) {
  if (!agentType || !fingerprint) return null
  return `${agentType}|${questionSetVersion}|${fingerprint}`
}

// The TTL is not a correctness mechanism — content addressing already
// guarantees that, and the observer refuses an entry whose recorded model is
// not the one currently answering behind the `jev-latest` alias. It is only a
// backstop for an entry that outlives every model check, so it is a day:
// shorter, and an idle screen is re-bought several times a day for nothing.
function createAnswerCache(options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : DEFAULT_MAX_ENTRIES
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const now = typeof options.now === 'function' ? options.now : Date.now

  // Map preserves insertion order, so delete + re-set is a move-to-newest and
  // the first key is always the least recently used.
  const cacheEntries = new Map()
  const counters = { hits: 0, misses: 0, expired: 0, evicted: 0, seeded: 0, stored: 0 }

  function isExpired(entry, at) {
    return ttlMs > 0 && at - entry.at >= ttlMs
  }

  function get(key) {
    if (!key) return null
    const entry = cacheEntries.get(key)
    if (!entry) {
      counters.misses++
      return null
    }
    const at = now()
    if (isExpired(entry, at)) {
      cacheEntries.delete(key)
      counters.expired++
      counters.misses++
      return null
    }
    cacheEntries.delete(key)
    cacheEntries.set(key, entry)
    counters.hits++
    return entry
  }

  function store(key, value, at) {
    if (!key || !value || !value.answers) return false
    if (cacheEntries.has(key)) cacheEntries.delete(key)
    cacheEntries.set(key, {
      answers: value.answers,
      usage: value.usage,
      model: value.model,
      at: Number.isFinite(at) ? at : now()
    })
    while (cacheEntries.size > maxEntries) {
      const oldest = cacheEntries.keys().next()
      if (oldest.done) break
      cacheEntries.delete(oldest.value)
      counters.evicted++
    }
    return true
  }

  function set(key, value) {
    if (!store(key, value)) return false
    counters.stored++
    return true
  }

  // Warm start across a watcher restart. tmux reloading its config restarts the
  // watcher, and without this every session would be reclassified from scratch
  // even though no screen changed. Entries come from pane-store, keyed by screen
  // content exactly as in memory — the cache is a property of what was on the
  // screen, not of any session, so it is stored that way.
  function seed(entries) {
    if (!entries || typeof entries !== 'object') return 0
    let added = 0
    for (const [key, entry] of Object.entries(entries)) {
      if (!key || !entry || !entry.answers) continue
      const at = Number.isFinite(entry.at) ? entry.at : 0
      if (ttlMs > 0 && now() - at >= ttlMs) continue
      if (cacheEntries.has(key)) continue
      if (!store(key, entry, at)) continue
      counters.seeded++
      added++
    }
    return added
  }

  // Everything currently held, for pane-store to persist.
  function snapshot() {
    const out = {}
    for (const [key, entry] of cacheEntries) out[key] = entry
    return out
  }

  return {
    get,
    set,
    seed,
    snapshot,
    clear() {
      cacheEntries.clear()
    },
    get size() {
      return cacheEntries.size
    },
    stats() {
      const lookups = counters.hits + counters.misses
      return Object.assign({}, counters, {
        size: cacheEntries.size,
        hitRate: lookups > 0 ? counters.hits / lookups : 0
      })
    }
  }
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  answerCacheKey,
  createAnswerCache
}
