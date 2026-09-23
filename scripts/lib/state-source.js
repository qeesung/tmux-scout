// Which mechanism owns semantic session state.
//
// The two are deliberately either/or for any one agent. Hooks are
// edge-triggered: phase moves only when an agent CLI announces something, so a
// dropped or missing event leaves the session wrong until the next one. The
// pane model is level-triggered: it re-reads the screen and phase becomes a
// function of what is there. Running both would mean two writers with
// different latencies fighting over the same wait — a stale hook completing a
// turn the screen says just started. So while this says `jev`, `setup install`
// installs no hooks for the agents the pane model reads, and `doctor` warns
// when it finds some; agents it does not read keep theirs.
//
// Unset means `hook`: this is the behaviour every existing install has.

const { execFileSync } = require('child_process')

const STATE_SOURCES = Object.freeze({ HOOK: 'hook', JEV: 'jev' })
const STATE_SOURCE_OPTION = '@scout-state-source'
// The agents whose screens the pane model reads unless configured otherwise:
// the ones whose layouts the question set and the prompt extractor were
// checked against.
const DEFAULT_PANE_AGENTS = Object.freeze(['claude', 'codex', 'gemini'])

// Throws when tmux cannot be asked; an unset option is '' (-q suppresses the
// error for that). For a caller that must not mistake the first for the second.
function readTmuxOptionStrict(name) {
  return execFileSync('tmux', ['show-option', '-gqv', name], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function readTmuxOption(name) {
  try {
    return readTmuxOptionStrict(name)
  } catch (_) {
    return ''
  }
}

function stateSource(read = readTmuxOption) {
  const value = String(read(STATE_SOURCE_OPTION) || '').trim().toLowerCase()
  return value === STATE_SOURCES.JEV ? STATE_SOURCES.JEV : STATE_SOURCES.HOOK
}

// Whether the pane model actually runs, and in which mode. Two options can turn
// it on and they are checked in this order everywhere — the watcher, the doctor
// and anything else that needs to know. Resolving it in one place is the point:
// a doctor that reads only @scout-pane-model reports every prerequisite as fine
// while a `jev` install has no SDK, no key and, by then, no hooks either.
//
// `@scout-pane-model` accepts off and shadow only. It once also accepted `on`,
// which let the model write phase while the hooks were still installed and
// writing it too — the two-writer configuration the either/or switch exists to
// rule out, reachable through a side door that setup and doctor never checked.
// Writing is now reachable only through `@scout-state-source jev`, which is the
// path that refuses to install hooks and warns about leftover ones.
function effectivePaneMode(read = readTmuxOption) {
  if (stateSource(read) === STATE_SOURCES.JEV) return 'on'
  const mode = String(read('@scout-pane-model') || '').trim().toLowerCase()
  return mode === 'shadow' ? 'shadow' : 'off'
}

// Which agents the pane model reads. The either/or is per agent: in jev mode an
// agent outside this list is not read from the screen, so it keeps its hooks —
// without them it would have no state at all and sit hidden as a discovery
// placeholder. setup, doctor and the watcher all resolve the list here.
function paneModelAgents(read = readTmuxOption) {
  const configured = String(read('@scout-state-agents') || read('@scout-pane-model-agents') || '')
  const agents = new Set(configured.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
  return agents.size > 0 ? agents : new Set(DEFAULT_PANE_AGENTS)
}

// The gate the watcher classifies with, for anything that wants to show the
// same verdict it would reach — debug.js classify exists to tune exactly this.
// Leaving a wait stays deliberately harder than entering one, so the exit bar
// tracks the accept bar instead of being configured independently: halfway
// from it to certainty. A fixed offset with a cap stopped being higher at all
// once the accept bar was set to 0.9 or above.
function paneModelThresholds(read = readTmuxOption) {
  const accept = Number.parseFloat(read('@scout-pane-model-confidence'))
  if (!Number.isFinite(accept) || accept <= 0 || accept >= 1) return undefined
  return { accept, waitExit: accept + (1 - accept) / 2 }
}

// Agents whose state comes from the screen rather than from hooks.
function screenReadAgents(read = readTmuxOption) {
  return stateSource(read) === STATE_SOURCES.JEV ? paneModelAgents(read) : new Set()
}

module.exports = {
  DEFAULT_PANE_AGENTS,
  STATE_SOURCES,
  STATE_SOURCE_OPTION,
  effectivePaneMode,
  paneModelAgents,
  paneModelThresholds,
  readTmuxOption,
  readTmuxOptionStrict,
  screenReadAgents,
  stateSource
}
