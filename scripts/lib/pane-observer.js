// Scheduling for the pane classifier: the only place in this feature that is
// asynchronous, and the only place that spends money.
//
// The watcher tick must stay synchronous — the pane and PID liveness sweeps are
// the safety net under everything else, and they cannot be made to wait on a
// network round trip. So this module is split across two synchronous calls:
//
//   dispatch(status, panes)   capture screens, answer from cache where possible,
//                             start (but never await) requests for the rest
//   drain()                   hand back whatever finished since the last tick
//
// A response that lands mid-tick is simply picked up by the next drain. Nothing
// here ever throws into the tick, and nothing here ever awaits inside it.
//
// Four independent gates decide whether a screen costs anything, and they cover
// different things — dropping any one of them re-opens a hole:
//
//   content cache   the same screen, already answered            -> free, instant
//   interval        a session whose screen keeps genuinely changing
//   verdict backoff a screen that keeps changing to the same conclusion
//   token bucket    a blunt global ceiling if the others have a bug
//
// Cache hits deliberately bypass the interval. They are free, so throttling them
// would buy nothing and cost responsiveness: when a dialog closes and the screen
// returns to a shape already seen, the session updates on the very next tick.

const { capturePanes, DEFAULT_TAIL_LINES } = require('./pane-capture')
const { answerCacheKey, createAnswerCache } = require('./pane-answer-cache')
const { extractPromptAndTitle, extractToolLine } = require('./pane-text-extract')
const {
  PANE_QUESTION_SET_VERSION,
  buildPaneState,
  paneQuestions
} = require('./pane-questions')
const {
  CACHE_FILE,
  OBSERVED_FILE,
  SHADOW_FILE,
  SHADOW_HEARTBEAT_MS,
  appendShadow,
  readCache,
  readObserved,
  writeCache,
  writeObserved
} = require('./pane-store')
const { createPaneMetrics } = require('./pane-metrics')
const { interpretPaneAnswers, paneEventsFromInterpretation, waitExitReached } = require('./pane-classifier')
const { PENDING_INTERACTION_PHASES, TERMINAL_SESSION_PHASES } = require('./session-contract')
const { currentPhase, isRecordedProcessExit } = require('./session-state')
const { DEFAULT_PANE_AGENTS } = require('./state-source')

const MODES = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ON: 'on' })
const CACHE_PERSIST_MS = 60000

const DEFAULTS = Object.freeze({
  intervalMs: 6000,
  minIntervalMs: 2000,
  // Where the adaptive backoff stops. Well under the 120s idle sweep it defers,
  // so a backed-off session still refreshes its observation in time.
  maxIntervalMs: 30000,
  tailLines: DEFAULT_TAIL_LINES,
  agents: DEFAULT_PANE_AGENTS,
  concurrency: 4,
  requestsPerMinute: 30,
  errorBackoffMs: 60000,
  globalCooldownMs: 60000,
  // A ceiling on panes read per tick. They are read in one tmux call, which
  // costs a few milliseconds per pane rather than a process each, so this only
  // bites on a wall of agents far past the usual; when it does, sessions are
  // taken round-robin, so a capped tick delays a reading rather than starving
  // one.
  maxCapturesPerTick: 64,
  // How many more times a screen whose answer the gate rejected is sent again.
  // See dispatch().
  maxReasks: 2
})

// Normalizes here rather than at each call site: this is the one place that
// decides what a tmux option string means, and three callers were each doing
// their own trim/lowercase first.
function normalizeMode(value) {
  const mode = String(value == null ? '' : value).trim().toLowerCase()
  return mode === MODES.ON || mode === MODES.SHADOW ? mode : MODES.OFF
}

// Idempotent on purpose: watcher.js normalizes the tmux option before handing
// it over, and createPaneObserver normalizes whatever it is given. Stringifying
// a Set yields "[object Set]", so a non-idempotent version silently empties the
// allowlist and nothing is ever classified.
function toAgentSet(agents) {
  const list = typeof agents === 'string'
    ? agents.split(',')
    : agents && typeof agents[Symbol.iterator] === 'function' ? [...agents] : []
  const set = new Set()
  for (const item of list) {
    const name = String(item || '').trim().toLowerCase()
    if (name) set.add(name)
  }
  return set.size > 0 ? set : new Set(DEFAULTS.agents)
}

// A screen with almost nothing on it carries no decision, and asking about it
// still costs the full question set.
function hasEnoughContent(capture) {
  if (!capture || !capture.text) return false
  let lines = 0
  for (const line of capture.text.split('\n')) {
    if (line.trim()) lines++
    if (lines >= 3) return true
  }
  return false
}

// When the agent in a session last did something, as opposed to when anything
// last wrote to the record. Sweeps move lastUpdated; they do not start sessions
// and they do not fire hooks.
function agentActivityAt(session) {
  const started = Number(session && session.startedAt)
  const hooked = Number(session && session.lastHookAt)
  return Math.max(Number.isFinite(started) ? started : 0, Number.isFinite(hooked) ? hooked : 0)
}

function createPaneObserver(options = {}) {
  const mode = normalizeMode(options.mode)
  const client = options.client || null
  const cache = options.cache || createAnswerCache()
  // `capture` reads one pane, for tests that script screens pane by pane.
  const captureMany = typeof options.captureMany === 'function'
    ? options.captureMany
    : typeof options.capture === 'function'
      ? (paneIds, lines) => new Map(paneIds.map(paneId => [paneId, options.capture(paneId, lines)]))
      : capturePanes
  const now = typeof options.now === 'function' ? options.now : Date.now
  const log = typeof options.log === 'function' ? options.log : null
  // Told when a paid answer lands. Otherwise it waited for the watcher's next
  // tick, which on average added a whole second on top of the request itself.
  const onReading = typeof options.onReading === 'function' ? options.onReading : null
  const thresholds = options.thresholds
  // Overridable so tests never touch the real ~/.tmux-scout.
  const shadowFile = options.shadowFile || SHADOW_FILE
  const cacheFile = options.cacheFile || CACHE_FILE
  const observedFile = options.observedFile || OBSERVED_FILE
  // Inherited across a settings-change rebuild so the spend report is not reset
  // by a config edit — but the logging switch is itself a setting, so it is
  // applied afterwards rather than left behind in the old closure.
  const metrics = options.metrics || createPaneMetrics({ now, file: options.metricsFile })
  metrics.configure({ logCalls: options.logCalls === true, file: options.metricsFile })
  const agents = toAgentSet(options.agents)
  const tailLines = Number.isFinite(options.tailLines) ? options.tailLines : DEFAULTS.tailLines
  const intervalMs = Math.max(
    DEFAULTS.minIntervalMs,
    Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULTS.intervalMs
  )
  const maxIntervalMs = Math.max(intervalMs, DEFAULTS.maxIntervalMs)
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : DEFAULTS.concurrency
  const requestsPerMinute = Number.isFinite(options.requestsPerMinute)
    ? options.requestsPerMinute
    : DEFAULTS.requestsPerMinute
  const maxCapturesPerTick = Number.isFinite(options.maxCapturesPerTick)
    ? options.maxCapturesPerTick
    : DEFAULTS.maxCapturesPerTick
  const maxReasks = Number.isFinite(options.maxReasks) ? options.maxReasks : DEFAULTS.maxReasks

  // Everything request pacing depends on, in one object so a rebuild after a
  // settings change can inherit it whole. Rebuilt without it, the new observer
  // forgot a 429 cooldown it was still inside and a full token bucket's worth of
  // budget it had already spent, and fired straight back into the rate limit;
  // it also forgot every session's streak and in-flight fingerprint. Scalars
  // live on the object, not in closure variables, because the old observer's
  // in-flight callbacks decrement `inFlight` after the handover.
  const sched = options.schedule || {
    sessions: new Map(),
    owners: new Map(),
    cursor: 0,
    inFlight: 0,
    globalCooldownUntil: 0,
    tokens: requestsPerMinute,
    tokensAt: now(),
    model: null,
    // Whoever persists next writes the cache. A flag in this closure was lost
    // on a rebuild: a response landing after the handover set it on the closed
    // observer, and the replacement, answering from that cache, never wrote it.
    cacheDirty: false,
    // Pane -> the session instance last read there; see ownPrompt().
    paneIdentity: new Map(),
    // Whether the newest response was an authentication failure; see stats().
    authFailing: false
  }
  // Per-session scheduling state. Keyed by sessionId, pruned with the registry.
  const sessions = sched.sessions
  // sessionId -> capture time of the newest trusted reading. Read by the idle
  // sweeps so they stand down for a session the model is actively watching.
  // Not derived from the session record: the classifier only emits on a
  // disagreement, so a frozen screen writes nothing, and anything read off the
  // record would go stale exactly when the sweeps most need to know the session
  // is still being watched.
  //
  // Handed over on a settings rebuild and persisted for a restart. Starting
  // empty re-opens the exact window this map exists to close: the first tick
  // after a rebuild runs the idle sweeps before the new observer has read a
  // single pane, and a session frozen on a long command gets completed. The
  // timestamps are real capture times, so after a long outage they simply read
  // as stale and the sweeps behave as they would have.
  //
  // Kept in every mode but exposed only in `on`: shadow must not stand the
  // sweeps down, but what it read is real, and an `on` observer built from a
  // shadow one would otherwise start empty — the first tick after switching to
  // jev then ran the idle sweeps against nothing and completed sessions frozen
  // on a long command.
  const observed = options.observed instanceof Map ? options.observed : new Map()
  const EMPTY_OBSERVED = new Map()
  // pane -> sessionId it was last read for; ties in ownership stay put.
  const owners = sched.owners
  let observedPersistedAt = 0
  // Each reading carries the session it was taken against. Holding them in a
  // long-lived Map instead would pin a whole generation of session objects —
  // sync.run re-parses status.json every tick, so those are re-created each
  // time — for as long as the session stayed in the registry.
  //
  // Handed over on a rebuild, like the pacing state: readings already paid for
  // but not yet drained would otherwise be dropped with the old observer.
  const readings = Array.isArray(options.readings) ? options.readings : []

  let closed = false
  let cachePersistedAt = 0

  // Handed over too: the spend metrics are, and a hit rate or paid share mixing
  // inherited calls with freshly zeroed cache hits reports nonsense.
  const counters = options.counters || {
    eligible: 0,
    stale: 0,
    captured: 0,
    cacheHits: 0,
    calls: 0,
    errors: 0,
    emitted: 0,
    throttled: 0,
    budgetBlocked: 0,
    captureCapped: 0,
    reasks: 0
  }

  function sessionState(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        lastCallAt: 0,
        retryAfter: 0,
        // Wait-exit evidence; see waitExitReached().
        exitStreak: 0,
        exitSince: null,
        // Backoff: consecutive PAID answers with the same verdict.
        lastPaidVerdict: null,
        paidRepeat: 0,
        pendingFingerprint: null,
        // The newest screen the gate rejected, and how many times it has been
        // sent again since; see dispatch().
        rejectedFingerprint: null,
        reasks: 0,
        shadowSignature: null
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function takeToken(at) {
    const elapsed = Math.max(0, at - sched.tokensAt)
    sched.tokens = Math.min(requestsPerMinute, sched.tokens + (elapsed * requestsPerMinute) / 60000)
    sched.tokensAt = at
    if (sched.tokens < 1) return false
    sched.tokens -= 1
    return true
  }

  // Same conclusion over and over on a screen that keeps changing is the one
  // expensive case the content cache cannot help with — that is what this backs
  // off. Any change in the verdict resets it immediately.
  //
  // Counted over PAID answers only. Counting cache hits too meant a long stretch
  // of a frozen `working` screen — which costs nothing — ratcheted the interval
  // to its 30s ceiling, so the approval dialog that finally replaced it waited
  // up to 30s to be read at all.
  function effectiveInterval(state) {
    const steps = Math.max(0, state.paidRepeat - 2)
    return Math.min(maxIntervalMs, intervalMs * Math.pow(2, Math.min(steps, 8)))
  }

  // `jev-latest` is an alias, and an answer is only as good as the model that
  // gave it. Every paid response says which model answered; a cached answer
  // from any other model is treated as a miss. Checked per entry rather than by
  // wiping the cache on a change: a wipe keyed on process memory never fired
  // for answers seeded from disk after a restart (nothing to compare against
  // yet), and during a staged rollout that alternates models it would have
  // thrown the whole cache away on every alternation.
  function noteModel(model) {
    if (model) sched.model = model
  }

  function fromCurrentModel(entry) {
    return !sched.model || !entry.model || entry.model === sched.model
  }

  function eligible(session, panes, at) {
    if (!session || !session.tmuxPane) return false
    if (session.isRemote) return false
    if (session.endedAt) return false
    if (TERMINAL_SESSION_PHASES.has(currentPhase(session))) return false
    // A session whose process was seen to exit is finished, whatever is still
    // drawn in the pane. Process liveness outranks the screen: what is left
    // there is scrollback from a program that is gone, and reading it would
    // revive dead sessions from their own leftovers.
    if (isRecordedProcessExit(session)) return false
    // A child record (a subagent, a spawned thread) shares its parent's pane
    // and fires hooks of its own, so it is usually the most recently active
    // record there — and would take the parent's screen. What the screen shows
    // is the parent's state; readings applied to a hidden child leave the row
    // the user actually sees unchanged.
    if (session.parentSessionId) return false
    if (!agents.has(String(session.agentType || '').toLowerCase())) return false
    const pane = panes && typeof panes.get === 'function' ? panes.get(session.tmuxPane) : null
    // tmux being unreachable is not evidence that a pane vanished; only treat a
    // pane as gone when the snapshot itself is trustworthy.
    if (panes && panes.tmuxAvailable && !pane) return false
    if (pane && pane.paneDead) return false
    return true
  }

  // `at` is always capture time, never response time. The reading describes the
  // screen as it was when it was read, and both the staleness check in
  // applyPaneEvents and the sweep stand-down depend on saying so honestly.
  function record(sessionId, session, answers, capturedPane, extracted, at, paid) {
    if (closed) return
    readings.push({ sessionId, session, answers, capture: capturedPane, extracted, at, paid: paid === true })
  }

  function request(sessionId, session, state, capturedPane, extracted, agentType, at) {
    state.lastCallAt = at
    state.lastPaidBottom = capturedPane.bottom
    state.pendingFingerprint = capturedPane.fingerprint
    sched.inFlight++
    counters.calls++

    const key = answerCacheKey(agentType, PANE_QUESTION_SET_VERSION, capturedPane.fingerprint)

    client.classify(buildPaneState(capturedPane, agentType), paneQuestions())
      .then(result => {
        sched.inFlight--
        if (state.pendingFingerprint === capturedPane.fingerprint) state.pendingFingerprint = null
        // Recorded before the closed check: a response that lands during
        // shutdown was still paid for, and a cost report that quietly drops the
        // last few calls of every watcher generation is a cost report that
        // undercounts by design.
        metrics.recordCall(result, { sessionId, agentType })
        if (!result || !result.ok) {
          // Pacing state is shared with any replacement observer, so a 429 that
          // lands after a rebuild still pauses the one now running.
          const kind = result && result.errorKind
          sched.authFailing = kind === 'auth'
          // A rate limit is a property of the account, not of this session, so
          // it pauses everything; anything else backs off just this session.
          if (kind === 'rate-limited') sched.globalCooldownUntil = now() + DEFAULTS.globalCooldownMs
          else state.retryAfter = now() + DEFAULTS.errorBackoffMs
          // Refused for what is on the screen, so the same screen is refused
          // again: it is not re-sent until the screen changes. Retried on the
          // error backoff instead, one pane showing key material was re-sent
          // every minute for as long as it stayed on screen.
          if (kind === 'forbidden') state.refusedFingerprint = capturedPane.fingerprint
          if (closed) return
          counters.errors++
          if (log) {
            const detail = [result && result.status, result && result.error && String(result.error).slice(0, 120)]
              .filter(Boolean).join(' ')
            log(`pane classify failed (${kind || 'unknown'}${detail ? `: ${detail}` : ''}) for ${sessionId}`)
          }
          return
        }
        sched.authFailing = false
        noteModel(result.model)
        // Successes are cached even when the answer is weak: the same screen
        // would produce the same weak answer, so re-asking only spends money.
        // Failures are never cached — those should be retried. Cached before the
        // closed check: the cache is handed to a replacement observer, so an
        // answer paid for across a rebuild is still used rather than re-bought.
        if (key && cache.set(key, result)) sched.cacheDirty = true
        if (closed) return
        record(sessionId, session, result.answers, capturedPane, extracted, at, true)
        if (onReading) onReading()
      }, error => {
        sched.inFlight--
        if (state.pendingFingerprint === capturedPane.fingerprint) state.pendingFingerprint = null
        metrics.recordCall({ ok: false, errorKind: 'threw' }, { sessionId, agentType })
        counters.errors++
        state.retryAfter = now() + DEFAULTS.errorBackoffMs
        if (log) log(`pane classify threw for ${sessionId}: ${error && error.message}`)
      })
      // Both handlers above release the slot first thing, so a throw later in
      // one of them is only logged. As a .catch after .then it ran the rejection
      // handler too, releasing the slot a second time — inFlight drifted
      // negative and the concurrency cap stopped holding.
      .catch(error => {
        if (log) log(`pane classify handler failed for ${sessionId}: ${error && error.message}`)
      })
  }

  // A pane shows one screen, so it can only be evidence about one session. The
  // registry routinely keeps several live records per pane — resumed turns,
  // re-runs in the same window — and classifying all of them would apply the
  // same verdict several times over, multiplying both disk writes and picker
  // rows. The newest record is the one the screen belongs to.
  //
  // "Newest" is judged by when the agent itself last did something — the
  // record was started, or a hook fired — never by lastUpdated/endedAt. Those
  // are written by the fallback sweeps too: completing an old record on its
  // 120s timeout makes it the most recently touched on the pane, and ranking by
  // that would hand the screen to the obsolete record, reopening it with
  // readings that belong to the live one. On a tie the pane stays with the
  // session it was already read for.
  function claimantsByPane(status, panes, at) {
    const claims = new Map()
    for (const sessionId of Object.keys(status.sessions)) {
      const session = status.sessions[sessionId]
      if (!eligible(session, panes, at)) continue
      counters.eligible++
      const held = claims.get(session.tmuxPane)
      if (!held || outranks(sessionId, session, held, session.tmuxPane)) {
        claims.set(session.tmuxPane, { sessionId, session })
      }
    }
    for (const [pane, claim] of claims) owners.set(pane, claim.sessionId)
    return [...claims.values()]
  }

  function outranks(sessionId, session, held, pane) {
    const mine = agentActivityAt(session)
    const theirs = agentActivityAt(held.session)
    if (mine !== theirs) return mine > theirs
    return owners.get(pane) === sessionId
  }

  function dispatch(status, panes) {
    if (closed || mode === MODES.OFF || !status || !status.sessions) return
    // An unavailable client never becomes available within a process, and every
    // reading below depends on one. Checking it here rather than after the
    // capture is the difference between idling and forking a capture-pane per
    // pane every tick forever, on the same thread as the liveness sweeps.
    if (!client || !client.available) return
    const at = now()
    const claims = claimantsByPane(status, panes, at)
    if (claims.length === 0) return

    // Start where the previous tick stopped, so the capture cap delays readings
    // evenly instead of always serving the same panes. The cursor advances by
    // the batch that was actually captured, not by one: stepping by one reuses
    // all but one pane of the previous batch, and with 80 panes at a cap of 12
    // the last pane then waits ~68 ticks — past the 120s window the idle sweeps
    // stand down for, which is exactly when a false completion becomes possible.
    const start = sched.cursor % claims.length
    const ordered = claims.slice(start).concat(claims.slice(0, start))
    const batch = ordered.slice(0, maxCapturesPerTick)
    counters.captureCapped += ordered.length - batch.length
    const screens = captureMany(batch.map(claim => claim.session.tmuxPane), tailLines)
    const wanting = []

    for (const { sessionId, session } of batch) {
      const capturedPane = screens.get(session.tmuxPane)
      if (!capturedPane || !hasEnoughContent(capturedPane)) continue
      counters.captured++

      const agentType = String(session.agentType || '').toLowerCase()
      const state = sessionState(sessionId)
      const key = answerCacheKey(agentType, PANE_QUESTION_SET_VERSION, capturedPane.fingerprint)

      // Free and instant: no interval, no budget, no concurrency slot.
      const cached = key ? cache.get(key) : null
      let reask = false
      if (cached && fromCurrentModel(cached)) {
        counters.cacheHits++
        record(sessionId, session, cached.answers, capturedPane, extractFor(capturedPane, agentType), at)
        // A weak answer is cached like any other, and on a screen that then
        // stays put it is the only answer that screen ever gets. When the gate
        // rejected it, that froze the session in whatever it showed before: a
        // Claude turn that finished on a 0.46 idle_ready stayed BUSY for as
        // long as the screen did. The model does not answer the same screen
        // identically every time, so it is asked again — a bounded number of
        // times, and never for an unreadable screen, which will not improve.
        reask = state.rejectedFingerprint === capturedPane.fingerprint && state.reasks < maxReasks
        if (!reask) continue
      }

      if (at < sched.globalCooldownUntil || at < state.retryAfter) continue
      if (state.pendingFingerprint === capturedPane.fingerprint) continue
      if (state.refusedFingerprint === capturedPane.fingerprint) continue
      // The backoff is for a body that keeps scrolling to the same conclusion.
      // When the bottom of the screen moved — a dialog replaced the composer, the
      // turn ended — that is a different screen, read as soon as the minimum
      // interval allows. Streaming output had pushed a newly shown approval
      // dialog up to 30s back; the base interval still held a finished turn
      // for up to 6s.
      const bottomMoved = state.lastPaidBottom !== capturedPane.bottom
      const wait = bottomMoved ? DEFAULTS.minIntervalMs : effectiveInterval(state)
      if (at - state.lastCallAt < wait) {
        counters.throttled++
        continue
      }
      wanting.push({ sessionId, session, state, capturedPane, agentType, reask })
    }

    // Paid calls go to whoever has waited longest, not to whoever comes first in
    // capture order. With the budget or the concurrency cap binding, capture
    // order had handed every slot to the same few panes each tick, and the rest
    // went unclassified for minutes — long enough for the idle sweeps to
    // complete sessions that were still working.
    wanting.sort((a, b) => a.state.lastCallAt - b.state.lastCallAt)
    for (const { sessionId, session, state, capturedPane, agentType, reask } of wanting) {
      if (sched.inFlight >= concurrency || !takeToken(at)) {
        counters.budgetBlocked++
        continue
      }
      if (reask) {
        state.reasks++
        counters.reasks++
      }
      request(sessionId, session, state, capturedPane, extractFor(capturedPane, agentType), agentType, at)
    }

    sched.cursor = (start + Math.max(1, batch.length)) % claims.length
  }

  function extractFor(capturedPane, agentType) {
    // Shadow compares phases only; the prompt, title and tool are never used.
    if (mode === MODES.SHADOW) return undefined
    const extracted = extractPromptAndTitle(capturedPane.raw, agentType) || {}
    const tool = extractToolLine(capturedPane.raw, agentType)
    if (tool && tool.details) extracted.pendingDetails = tool.details
    return extracted
  }

  // Shadow mode records what the model concluded without letting it act, and
  // does so in its OWN file rather than through the reducer. Everything shadow
  // needs is one line per reading for the agreement report; routing it through
  // a session record would mean either moving a phase (not shadow) or adding a
  // "record but change nothing" flag to the reducer — and the reducer's
  // no-phase branch still refreshes lastUpdated, which is exactly the timestamp
  // the 120s/180s idle sweeps measure. A separate file is behaviour-neutral by
  // construction rather than by careful argument.
  function recordShadow(state, reading, interp) {
    // Deduplicated on the whole comparison, not on the verdict alone. The rows
    // exist to answer "did the model and the hooks agree", so when the hooks
    // move and the verdict does not — running/working then completed/working —
    // the second row is the disagreement, which is the only interesting kind.
    const hookPhase = currentPhase(reading.session || {})
    const signature = `${hookPhase}|${interp.verdict}|${interp.gate}`
    if (state.shadowSignature === signature && reading.at - state.shadowAt < SHADOW_HEARTBEAT_MS) return
    state.shadowSignature = signature
    state.shadowAt = reading.at
    appendShadow({
      at: reading.at,
      sessionId: reading.sessionId,
      agentType: reading.session && reading.session.agentType,
      tmuxPane: reading.capture && reading.capture.paneId,
      hookPhase,
      // What the classifier concluded, after the cancel-marker upgrade from
      // completed to interrupted — not the verdict's default mapping, which
      // would score every correct `interrupted` as a disagreement.
      modelPhase: interp.phase,
      verdict: interp.verdict,
      gate: interp.gate,
      confidence: interp.confidence,
      signals: interp.signals
    }, shadowFile)
  }

  // Interpretation happens here rather than when the response lands, so a
  // reading is judged as late as possible against the session it was taken
  // from. paneEventsFromInterpretation compares against the session's real
  // phase, so a snapshot one tick old costs at most a redundant event, never a
  // wrong one.
  function drain() {
    if (readings.length === 0) return []
    const pending = readings.splice(0, readings.length)
    const events = []

    for (const reading of pending) {
      const session = reading.session
      const state = sessionState(reading.sessionId)

      // Readings arrive in the order they were produced, which is not the order
      // they were captured in: a cache hit is recorded during dispatch, while a
      // request started one or more ticks earlier lands whenever it lands. A
      // response that predates a reading already processed for this session
      // describes a screen that is gone — applying it would send the session
      // back to a wait it has already left and move observedAt backwards. The
      // hook timestamp check in isSupersededPaneEvent cannot catch this: in jev
      // mode there are no hooks.
      // Strictly older, not "not newer": two readings captured in the same
      // millisecond are both current, and rejecting the second would drop a
      // tick from the streak that leaving a WAIT is counted in.
      if (Number.isFinite(state.lastReadingAt) && reading.at < state.lastReadingAt) {
        counters.stale++
        continue
      }
      state.lastReadingAt = Math.max(state.lastReadingAt || 0, reading.at)

      const phaseNow = currentPhase(session)
      const interp = interpretPaneAnswers(reading.answers, {
        agentType: session.agentType,
        currentPhase: phaseNow,
        thresholds
      })

      const fingerprint = reading.capture && reading.capture.fingerprint
      if (fingerprint && interp.gate === 'reject' && interp.verdict !== 'unknown') {
        if (state.rejectedFingerprint !== fingerprint) {
          state.rejectedFingerprint = fingerprint
          state.reasks = 0
        }
      } else if (state.rejectedFingerprint === fingerprint) {
        state.rejectedFingerprint = null
      }

      if (reading.paid) {
        state.paidRepeat = state.lastPaidVerdict === interp.verdict ? state.paidRepeat + 1 : 1
        state.lastPaidVerdict = interp.verdict
      } else if (state.lastPaidVerdict !== null && interp.verdict !== state.lastPaidVerdict) {
        // A cached answer that disagrees is still a change: the screen went back
        // to something seen before. Left counting, the backoff built on the old
        // verdict would hold the next paid read of the new one at the ceiling.
        state.paidRepeat = 0
        state.lastPaidVerdict = null
      }

      // Wait-exit evidence counts readings, not API calls: a frozen screen
      // answered from cache still has to be able to accumulate it, or it would
      // never leave a WAIT. What it no longer does is count a reading that did
      // not itself pass — a rejected 0.1 followed by a 0.99 was a "streak of
      // two" before, and cleared a WAIT on one trusted reading. Only readings
      // taken while the session is in the wait count toward leaving it.
      if (PENDING_INTERACTION_PHASES.has(phaseNow) && interp.exitGrade !== null) {
        state.exitStreak = interp.exitGrade === 'strict' ? state.exitStreak + 1 : 0
        if (state.exitSince === null) state.exitSince = reading.at
      } else {
        state.exitStreak = 0
        state.exitSince = null
      }
      // Never earlier than the wait itself: evidence from before the dialog
      // appeared says nothing about whether it has been answered.
      const waitStartedAt = Number(session.pendingInteraction && session.pendingInteraction.startedAt) || 0
      interp.resolvesWait = waitExitReached(phaseNow, interp.exitGrade, {
        exitStreak: state.exitStreak,
        exitSustainedMs: state.exitSince === null ? 0 : reading.at - Math.max(state.exitSince, waitStartedAt)
      }, thresholds)

      // Only a reading that actually replaces the fallbacks stands them down,
      // and only in `on` mode. Two kinds of reading do not: one the gate
      // rejected, and one the gate accepted that carries no phase. `shell_prompt`
      // is the second kind — it defers to process liveness rather than deciding
      // anything — so refreshing this for it would suppress the idle fallback
      // indefinitely for a session with no usable pid, leaving it BUSY while the
      // model is saying the agent is gone. An accepted reading that merely agrees
      // with the session does count: that is the frozen-screen case the
      // fallbacks exist to not misjudge.
      if (interp.gate === 'accept' && interp.phase !== null) {
        observed.set(reading.sessionId, reading.at)
      }

      if (mode === MODES.SHADOW) {
        recordShadow(state, reading, interp)
        continue
      }

      for (const event of paneEventsFromInterpretation(interp, {
        session,
        capture: reading.capture,
        extracted: ownPrompt(state, reading.sessionId, session, reading.extracted, reading.capture && reading.capture.paneId),
        now: reading.at
      })) {
        counters.emitted++
        // The instance the event was built against. A discovery record keeps
        // its per-pane id across a restart, so the id alone cannot tell
        // applyPaneEvents that the record has been replaced since.
        events.push({ sessionId: reading.sessionId, startedAt: session.startedAt, event })
      }
    }

    return events
  }

  // A CLI that does not use the alternate screen restarts below its previous
  // run's output, so the prompt echo nearest the composer can belong to a
  // process that is gone. Read into a session that has never been prompted, it
  // titled the new session with the old prompt and satisfied the never-prompted
  // guard, so the session showed DONE for a turn that never happened.
  //
  // Only with evidence that there WAS an earlier process: this pane was last
  // read for a different session instance. Then the prompt visible when the new
  // one is first read is set aside as inherited, and only a prompt that appears
  // after it is the session's own. Without that evidence — the pane was never
  // read before, as right after switching to jev — the prompt on screen is
  // taken as the session's; suppressing it there hid a session whose first turn
  // finished before it was read, and nothing ever repaired that. An instance is
  // the id and startedAt together: a discovery record replaced after a restart
  // keeps its per-pane id.
  function ownPrompt(state, sessionId, session, extracted, paneId) {
    const identity = `${sessionId}@${session.startedAt}`
    const previous = paneId ? sched.paneIdentity.get(paneId) : undefined
    if (paneId) sched.paneIdentity.set(paneId, identity)
    if (state.inheritedFor !== identity) {
      state.inheritedFor = identity
      state.inheritedPrompt = previous && previous !== identity && extracted && !session.lastUserPrompt
        ? extracted.lastUserPrompt || null
        : null
    }
    if (!extracted || session.lastUserPrompt || !state.inheritedPrompt) return extracted
    if (extracted.lastUserPrompt !== state.inheritedPrompt) return extracted
    return Object.assign({}, extracted, { lastUserPrompt: undefined, sessionTitle: undefined, confidence: 'none' })
  }

  // Only exposed in `on` mode: shadow must not change behaviour at all, and
  // standing the idle sweeps down is a behaviour change.
  function observedAt() {
    return mode === MODES.ON ? observed : EMPTY_OBSERVED
  }

  function prune(status) {
    const live = new Set(Object.keys((status && status.sessions) || {}))
    for (const id of sessions.keys()) if (!live.has(id)) sessions.delete(id)
    for (const id of observed.keys()) if (!live.has(id)) observed.delete(id)
    for (const [pane, id] of owners) if (!live.has(id)) owners.delete(pane)
  }

  function stats() {
    return Object.assign({
      mode,
      available: Boolean(client && client.available),
      reason: client ? client.reason : 'no-client',
      // A rotated key does not reach a running client; the watcher compares
      // keyId against a fresh lookup to decide whether rebuilding would help.
      authFailing: Boolean(sched.authFailing),
      keyId: (client && client.keyId) || null,
      inFlight: sched.inFlight,
      queued: readings.length,
      tracked: sessions.size,
      cache: typeof cache.stats === 'function' ? cache.stats() : null,
      // Readings served from cache as a share of readings that were served at
      // all. The cache's own hit rate also counts a throttled tick as a miss,
      // which on a streaming screen reported a failure that cost nothing.
      hitRate: counters.cacheHits + counters.calls > 0
        ? counters.cacheHits / (counters.cacheHits + counters.calls)
        : null,
      jev: metrics.snapshot({ cacheHits: counters.cacheHits })
    }, counters)
  }

  // Answers survive a watcher restart (tmux reloading its config restarts this
  // process), so an unchanged screen is not re-bought.
  function seed() {
    if (mode === MODES.OFF) return 0
    if (mode === MODES.ON) {
      for (const [sessionId, at] of Object.entries(readObserved(observedFile))) {
        if (!observed.has(sessionId) && Number.isFinite(at)) observed.set(sessionId, at)
      }
    }
    if (typeof cache.seed !== 'function') return 0
    return cache.seed(readCache(cacheFile))
  }

  // Written at most once a minute, and only after something new was stored:
  // this is an optimization, not a source of truth, so it is not worth an
  // fsync per API response.
  //
  // Observation times are written on the same cadence but independently of the
  // cache: a frozen screen is answered entirely from cache, never dirties it,
  // and is precisely the session whose observation time matters most.
  function persist(at, force) {
    if (mode === MODES.OFF) return false
    if (mode === MODES.ON && (force || at - observedPersistedAt >= CACHE_PERSIST_MS)) {
      observedPersistedAt = at
      writeObserved(Object.fromEntries(observed), observedFile)
    }
    if (typeof cache.snapshot !== 'function') return false
    if (!sched.cacheDirty) return false
    if (!force && at - cachePersistedAt < CACHE_PERSIST_MS) return false
    sched.cacheDirty = false
    cachePersistedAt = at
    return writeCache(cache.snapshot(), cacheFile)
  }

  return {
    mode,
    dispatch,
    drain,
    // What a replacement observer should inherit when settings change at
    // runtime. The cache is the expensive part — rebuilding without it re-buys
    // every screen currently on the wall — and resetting the spend report on a
    // config edit would make the cost numbers impossible to trust.
    handoff() {
      return { cache, metrics, schedule: sched, readings, counters, observed }
    },
    observedAt,
    persist,
    prune,
    seed,
    stats,
    close() {
      closed = true
      persist(now(), true)
    }
  }
}

module.exports = {
  DEFAULTS,
  createPaneObserver,
  normalizeMode,
  toAgentSet
}
