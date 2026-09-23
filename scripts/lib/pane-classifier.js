// Turn model answers about a pane into a session event.
//
// Everything here is a pure function of (answers, context). The model is asked
// only what the screen shows; every threshold, every piece of hysteresis and
// every decision about whether to write anything at all lives in this file,
// where it can be exhausted by a table-driven test instead of re-sampled from a
// probabilistic system.
//
// Two rules shape the design and are easy to get wrong:
//
//   * Leaving a WAIT is the one conclusion that cannot be undone cheaply. A
//     session wrongly pulled out of WAIT stops asking for attention the user
//     actually owes it. So it takes a higher confidence bar, agreement from an
//     independent cross-check, and the same reading twice in a row.
//   * An event is emitted only when the reading disagrees with the session as
//     it stands. Re-sending a phase the session already holds still counts as a
//     change in the reducer (it refreshes lastUpdated), so a quiet screen would
//     otherwise rewrite every session file on every tick and keep resetting the
//     very timestamps the idle sweeps measure.

const { AGENT_EVENTS } = require('./agent-events')
const { SESSION_PHASES, PENDING_INTERACTION_PHASES, ACTIVE_TOOL_PHASES } = require('./session-contract')
const { currentPhase } = require('./session-state')

const STATE_SOURCE = 'pane-model'

const DEFAULT_THRESHOLDS = Object.freeze({
  accept: 0.55,
  // Asymmetric on purpose: harder to leave a WAIT than to enter one.
  waitExit: 0.75,
  toolAccept: 0.5,
  userBlockedLow: 0.4,
  toolRunningLow: 0.3,
  interruptHigh: 0.6,
  // Consecutive readings, each clearing the waitExit bar on its own, required
  // before concluding the user acted.
  waitExitStreak: 2,
  // The other way out: readings that are accepted but below waitExit, every one
  // of them saying "not a wait" with the cross-check agreeing, for this long. A
  // mid-redraw frame cannot last ten seconds and a dialog does not close by
  // itself, so duration stands in for the confidence. Without it a frozen
  // spinner read at 0.7 kept a session in WAIT for the whole command it was
  // approved to run.
  waitExitSustainMs: 10000
})

// Screen verdicts the model may return, and what each means for the session.
// `phase: null` is a deliberate silence, not a failure: a shell prompt says the
// agent is gone, but process liveness owns that call with better evidence.
const VERDICTS = Object.freeze({
  awaiting_approval: { phase: SESSION_PHASES.WAITING_FOR_APPROVAL, interactionType: 'approval' },
  awaiting_plan_approval: { phase: SESSION_PHASES.WAITING_FOR_APPROVAL, interactionType: 'plan' },
  awaiting_answer: { phase: SESSION_PHASES.WAITING_FOR_ANSWER, interactionType: 'question' },
  working: { phase: SESSION_PHASES.RUNNING, interactionType: null },
  idle_ready: { phase: SESSION_PHASES.COMPLETED, interactionType: null },
  shell_prompt: { phase: null, interactionType: null },
  unknown: { phase: null, interactionType: null }
})

// The reducer infers a plan approval from the wait reason, so phrase it in the
// words isPlanApprovalReason() looks for rather than setting the type directly.
// Only `plan` needs saying: attentionForPhase() already supplies the wording for
// a plain approval and for a question, and restating those here would give the
// contract's phrasing a second, drifting home.
const PLAN_ATTENTION_REASON = 'waiting for plan approval'

function thresholdsFrom(overrides) {
  return Object.assign({}, DEFAULT_THRESHOLDS, overrides || {})
}

function choiceOf(answers, name) {
  const answer = answers && answers[name]
  if (!answer || typeof answer.choice !== 'string') return null
  return answer.choice
}

function confidenceOf(answers, name) {
  const answer = answers && answers[name]
  return answer && Number.isFinite(answer.confidence) ? answer.confidence : 0
}

// Missing nouls read as 0.5 — "no opinion" — so an incomplete response neither
// confirms nor contradicts the main choice.
function noulOf(answers, name) {
  const answer = answers && answers[name]
  return answer && Number.isFinite(answer.noul) ? answer.noul : 0.5
}

function rejected(verdict, blockedReason, signals, confidence) {
  return {
    verdict,
    phase: null,
    interactionType: null,
    activeTool: null,
    confidence,
    gate: 'reject',
    exitGrade: null,
    resolvesWait: false,
    blockedReason,
    signals
  }
}

function interpretPaneAnswers(answers, context = {}) {
  const thresholds = thresholdsFrom(context.thresholds)
  const verdict = choiceOf(answers, 'screen_state')
  const confidence = confidenceOf(answers, 'screen_state')
  const signals = {
    userBlocked: noulOf(answers, 'blocked_on_user'),
    running: noulOf(answers, 'is_running'),
    interrupted: noulOf(answers, 'interrupt_marker_visible')
  }

  if (!verdict || !Object.prototype.hasOwnProperty.call(VERDICTS, verdict)) {
    return rejected(verdict || 'unknown', 'screen_state is missing or unrecognized', signals, confidence)
  }
  if (verdict === 'unknown') {
    return rejected(verdict, 'model could not read the screen', signals, confidence)
  }
  if (confidence < thresholds.accept) {
    return rejected(verdict, `confidence ${confidence.toFixed(2)} below ${thresholds.accept}`, signals, confidence)
  }

  const mapping = VERDICTS[verdict]
  let phase = mapping.phase
  let interactionType = mapping.interactionType

  // A wait that an independent question says is not blocking anyone is a
  // contradiction, and guessing wrong here invents a false attention request.
  if (PENDING_INTERACTION_PHASES.has(phase) && signals.userBlocked < thresholds.userBlockedLow) {
    return rejected(verdict, 'screen_state reports a wait but blocked_on_user disagrees', signals, confidence)
  }

  // A finished turn that still shows a cancellation marker was interrupted, not
  // completed. The distinction is invisible in the composer itself.
  if (phase === SESSION_PHASES.COMPLETED && signals.interrupted > thresholds.interruptHigh) {
    phase = SESSION_PHASES.INTERRUPTED
  }

  let activeTool = null
  if (ACTIVE_TOOL_PHASES.has(phase)) {
    const tool = choiceOf(answers, 'active_tool')
    // "working with nothing visibly running" stays running, but claiming a tool
    // would be a guess — and an activeTool is exactly what the Claude idle sweep
    // keys on, so a wrong one changes behaviour rather than just display.
    const toolTrusted = tool && tool !== 'none' &&
      confidenceOf(answers, 'active_tool') >= thresholds.toolAccept &&
      !(phase === SESSION_PHASES.RUNNING && signals.running < thresholds.toolRunningLow)
    if (toolTrusted) activeTool = tool
  }

  // What THIS reading says about a wait being over, independent of history.
  // A shell prompt counts: the dialog is gone because the agent is gone, and
  // without a resolver the PID sweep's process_exit is refused by the WAIT
  // guard, leaving a dead session asking for approval forever.
  const exitGrade = PENDING_INTERACTION_PHASES.has(phase) || signals.userBlocked >= thresholds.userBlockedLow
    ? null
    : confidence >= thresholds.waitExit ? 'strict' : 'relaxed'

  return {
    verdict,
    phase,
    interactionType,
    activeTool,
    confidence,
    gate: 'accept',
    exitGrade,
    resolvesWait: waitExitReached(context.currentPhase, exitGrade, context, thresholds),
    blockedReason: phase === null ? 'shell prompt is owned by process liveness' : undefined,
    signals
  }
}

// Whether the evidence gathered so far is enough to conclude the user acted.
// `evidence.exitStreak` counts consecutive readings graded strict, this one
// included; `evidence.exitSustainedMs` is how long every reading since the wait
// began has graded at least relaxed. A reading graded null resets both, which
// is what keeps one rejected or blocked reading from being bridged over.
function waitExitReached(currentPhase, exitGrade, evidence = {}, thresholdsInput) {
  if (!PENDING_INTERACTION_PHASES.has(currentPhase) || exitGrade === null) return false
  const thresholds = thresholdsFrom(thresholdsInput)
  if (exitGrade === 'strict' && Number(evidence.exitStreak || 0) >= thresholds.waitExitStreak) return true
  return Number(evidence.exitSustainedMs || 0) >= thresholds.waitExitSustainMs
}

function pendingInteractionChanged(session, interp, extracted) {
  if (!PENDING_INTERACTION_PHASES.has(interp.phase)) return false
  const previous = session.pendingInteraction || {}
  // approval and plan share one phase, so the subtype is the only thing that
  // moves when a tool confirmation becomes a plan confirmation. The picker and
  // status bar count plans separately, so a stale subtype is visible.
  //
  // Unless a tool the hooks recorded fixes it: the reducer derives the subtype
  // from session.pendingToolUse before any reason an event carries, so a
  // hook-era ExitPlanMode wait stays a plan whatever the screen says. Compared
  // anyway, a reading of `approval` there re-sent the wait on every tick and
  // rewrote the session file each time.
  const pinned = Boolean(session.pendingToolUse && session.pendingToolUse.tool)
  if (!pinned && interp.interactionType && previous.type !== interp.interactionType) return true
  const details = extracted && extracted.pendingDetails
  return Boolean(details) && previous.details !== details
}

function displayFieldsChanged(session, interp, extracted) {
  // Not compared for a wait: the event deliberately omits activeTool so that
  // sameWaitRefresh() holds, so the session's value can never converge on the
  // reading's and this would report a change on every single tick.
  if (!PENDING_INTERACTION_PHASES.has(interp.phase) &&
    (session.activeTool || null) !== (interp.activeTool || null)) return true
  if (extracted) {
    if (extracted.lastUserPrompt && session.lastUserPrompt !== extracted.lastUserPrompt) return true
    if (extracted.sessionTitle && session.sessionTitle !== extracted.sessionTitle) return true
  }
  return pendingInteractionChanged(session, interp, extracted)
}

// Which canonical event announces a given phase. This is the whole point of the
// design: the classifier speaks the vocabulary hooks already speak, so every
// guard in phaseDecision() applies to a screen reading unchanged and no
// exemption had to be carved out for it. `debug.js commandInject` does the same
// thing for injected phases, and six sweeps in sync.js already synthesize these
// events from weaker evidence than a screen (one of them from a bare timeout).
const EVENT_FOR_PHASE = Object.freeze({
  [SESSION_PHASES.WAITING_FOR_APPROVAL]: AGENT_EVENTS.PERMISSION_REQUEST,
  [SESSION_PHASES.WAITING_FOR_ANSWER]: AGENT_EVENTS.QUESTION_ASKED,
  [SESSION_PHASES.COMPLETED]: AGENT_EVENTS.TURN_COMPLETE,
  [SESSION_PHASES.INTERRUPTED]: AGENT_EVENTS.INTERRUPTED,
  // Deliberately NOT prompt_submit. That is the only member of
  // TURN_START_EVENTS, so it resets currentTurnId/turnStartedAt and clears the
  // error residue — claims a screen reading cannot support. Both events are in
  // TURN_REOPEN_EVENTS, so this reopens a finished session just as well.
  [SESSION_PHASES.RUNNING]: AGENT_EVENTS.ASSISTANT_MESSAGE_UPDATE
})

// Phases that claim a turn happened, which a never-prompted session has not had.
const NO_TURN_WITHOUT_PROMPT = new Set([SESSION_PHASES.COMPLETED, SESSION_PHASES.INTERRUPTED])

const RESOLVER_FOR_WAIT = Object.freeze({
  [SESSION_PHASES.WAITING_FOR_APPROVAL]: AGENT_EVENTS.PERMISSION_RESOLVED,
  [SESSION_PHASES.WAITING_FOR_ANSWER]: AGENT_EVENTS.QUESTION_ANSWERED
})

function baseEvent(type, interp, options, now) {
  const capture = options.capture
  const session = options.session || {}
  return {
    type,
    source: STATE_SOURCE,
    stateSource: STATE_SOURCE,
    rawEventName: `pane_${interp.verdict}`,
    timestamp: now,
    confidence: interp.confidence,
    reason: `pane read as ${interp.verdict}`,
    tmuxPane: (capture && capture.paneId) || session.tmuxPane
  }
}

// Returns the events that carry this reading into the session, newest last, or
// [] when the reading already agrees with the session. Comparing against the
// session's real phase rather than against the last event we sent is what makes
// this self-healing: whatever moved the phase, a disagreement with the screen
// gets corrected, and agreement stays silent.
//
// Leaving a WAIT takes two events, because the reducer models it as two facts:
// the user acted (the resolver), and the screen now shows something else.
function paneEventsFromInterpretation(interp, options = {}) {
  const session = options.session || {}
  const extracted = options.extracted
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const current = currentPhase(session)

  if (interp.gate !== 'accept') return []

  const inWait = PENDING_INTERACTION_PHASES.has(current)

  // A shell prompt decides no phase — process liveness does — but it does end a
  // wait. The resolver is the part only the screen can supply; once the session
  // is out of WAIT, the PID sweep's process_exit is no longer refused.
  if (interp.phase === null) {
    return inWait && interp.resolvesWait ? [baseEvent(RESOLVER_FOR_WAIT[current], interp, options, now)] : []
  }

  const target = EVENT_FOR_PHASE[interp.phase]
  if (!target) return []

  // A session that has never been prompted is `idle`, and its empty composer
  // reads as a finished turn. Moving it to completed would show DONE for work
  // that never happened; idle is the more precise of two phases that both mean
  // "waiting for the person to type". A prompt on screen means there was a turn.
  // Interrupted too: a cancel marker left by the pane's previous process turns
  // the same empty composer into `interrupted`, and there was no turn to cancel.
  const neverPrompted = !session.lastUserPrompt && !(extracted && extracted.lastUserPrompt)
  if (current === SESSION_PHASES.IDLE && neverPrompted && NO_TURN_WITHOUT_PROMPT.has(interp.phase)) return []
  // Nor does a startup screen start one. A spinner while MCP servers boot reads
  // as working, and once the session was running the guard above no longer
  // applied: the composer that followed completed a turn nobody sent. Only
  // when the composer was found with no prompt echo above it — where the
  // extractor cannot find a composer at all, an absent prompt proves nothing,
  // and refusing there would keep a real first turn from ever showing.
  if (current === SESSION_PHASES.IDLE && neverPrompted && interp.phase === SESSION_PHASES.RUNNING &&
    extracted && extracted.composer === true) return []

  const targetIsWait = PENDING_INTERACTION_PHASES.has(interp.phase)
  const phaseDiffers = current !== interp.phase

  const fieldsChanged = displayFieldsChanged(session, interp, extracted)
  // A wait the screen still shows, with nothing new to say about it.
  if (!phaseDiffers && !fieldsChanged) return []

  const events = []

  // Leaving a wait for anything that is not another wait. WAIT->WAIT needs no
  // resolver: permission_request / question_asked are already `explicitWait`.
  if (inWait && !targetIsWait) {
    if (!interp.resolvesWait) return []
    // question_answered is applied unconditionally from ANY phase, terminal
    // ones included, so the phase check the reducer skips has to happen here.
    // permission_resolved needs no such care — applySessionEvent no-ops it
    // outside waitingForApproval.
    events.push(baseEvent(RESOLVER_FOR_WAIT[current], interp, options, now))
  }

  // The resolver already lands on running, so a reading of `working` needs
  // nothing more.
  const resolverIsEnough = events.length > 0 && interp.phase === SESSION_PHASES.RUNNING
  if (!resolverIsEnough && (phaseDiffers || fieldsChanged)) {
    events.push(stateEvent(target, interp, options, now))
  }

  return events
}

function stateEvent(type, interp, options, now) {
  const session = options.session || {}
  const extracted = options.extracted
  const event = baseEvent(type, interp, options, now)

  const updates = {}
  if (extracted) {
    // Undefined is skipped by the reducer, so a failed extraction keeps whatever
    // was captured earlier instead of clearing it. Claude draws on the alternate
    // screen, so the prompt echo is usually readable only right after it is sent.
    updates.lastUserPrompt = extracted.lastUserPrompt
    updates.sessionTitle = extracted.sessionTitle
  }
  if (Object.keys(updates).length > 0) event.updates = updates

  if (PENDING_INTERACTION_PHASES.has(interp.phase)) {
    // activeTool is deliberately absent here, not null: sameWaitRefresh()
    // requires both it and pendingToolUse to be undefined, and without that a
    // re-read of an unchanged dialog counts as a brand new wait, dropping
    // pendingToolUse and resetting how long the user has been waiting.
    if (interp.interactionType === 'plan') event.attentionReason = PLAN_ATTENTION_REASON
    // Only when the dialog's details changed. Re-sending the same details on a
    // refresh made sameWaitRefresh() false, so a title becoming readable on an
    // unchanged dialog restarted the user's wait clock.
    const details = extracted && extracted.pendingDetails
    const previous = session.pendingInteraction && session.pendingInteraction.details
    if (details && details !== previous) event.pendingToolUse = { details, timestamp: now }
    return event
  }

  event.activeTool = interp.activeTool
  return event
}

module.exports = {
  EVENT_FOR_PHASE,
  RESOLVER_FOR_WAIT,
  STATE_SOURCE,
  VERDICTS,
  interpretPaneAnswers,
  paneEventsFromInterpretation,
  waitExitReached
}
