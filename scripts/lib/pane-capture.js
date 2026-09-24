// Capture, normalize and fingerprint tmux pane contents.
//
// This module exists for level-triggered state detection: instead of waiting
// for an agent to emit a hook event, scout can look at what the terminal shows
// right now. Pane text is therefore read on a timer, which makes cost control
// the whole design problem.
//
// Agent TUIs animate. Codex scatters braille particles across its idle screen,
// traex paints block-element banners, Claude cycles a thinking glyph, and every
// one of them renders a live elapsed-time or token counter. Those pixels change
// on every frame while the session's *state* does not, so hashing raw pane text
// never matches and every tick would spend an API call re-asking a question
// whose answer cannot have changed.
//
// normalizePaneText strips exactly that class of variation and nothing else.
// The same normalized text is both hashed and sent to the classifier, so a
// cached answer always corresponds to the state that produced it.

const { execFileSync, spawnSync } = require('child_process')
const crypto = require('crypto')

const DEFAULT_TAIL_LINES = 40
const FINGERPRINT_LENGTH = 16

// Frame-variable glyph classes.
const BRAILLE = /[⠀-⣿]/g          // Codex background particles; also braille spinners
const BOX_DRAWING_RUN = /[─-╿]{3,}/g   // ───── rules around Claude's input box
const BLOCK_ELEMENT_RUN = /[▀-▟]{3,}/g // ▄▄▄▄▄ traex banners
// Claude cycles this glyph at the start of its "Thinking…" line. Deliberately
// excludes ASCII -|/\ so ordinary markdown bullets and table borders survive.
const LEADING_SPINNER = /^([ \t]*)[✻✽✶✳✢✺·∙●○◐◑◒◓](?=[ \t])/gm
// Defensive only: `tmux capture-pane -p` omits escape sequences unless -e is set.
const ANSI = /\[[0-9;?]*[ -/]*[@-~]/g

// Live counters. The surrounding words ("Worked for" vs "esc to interrupt")
// carry the state; the digits only carry the clock.
const DURATION = /\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/g
const TOKENS = /\d+(?:\.\d+)?k?\s*tokens?/gi
const PERCENT = /\d+%/g

function normalizePaneText(text) {
  if (typeof text !== 'string' || !text) return ''
  return text
    .replace(ANSI, '')
    // A particle replaces a space rather than being inserted between two
    // characters, so it has to normalize back to a space. Deleting it outright
    // would turn "»⠁Ask" into "»Ask" while a clean frame reads "» Ask", and the
    // whitespace collapse below cannot recreate a separator that is not there.
    .replace(BRAILLE, ' ')
    .replace(BOX_DRAWING_RUN, '───')
    .replace(BLOCK_ELEMENT_RUN, '▄▄▄')
    .replace(LEADING_SPINNER, '$1*')
    .replace(DURATION, '<dur>')
    .replace(TOKENS, '<tok>')
    .replace(PERCENT, '<pct>')
    .split('\n')
    // Collapse whitespace runs. Two reasons, both load-bearing: a stripped
    // braille particle leaves "»Ask" where an unanimated frame has "» Ask", so
    // without this the fingerprint still flaps; and TUI panes are mostly column
    // padding, which is pure cost in a request billed per input token.
    // Indentation carries no signal for "is something blocking the user".
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// The last few normalized lines on their own. While an agent streams output the
// body scrolls but the bottom — spinner line, composer, status bar — is the
// same after normalization, so this stays still; a dialog replacing the
// composer, or the turn finishing, moves it. The observer uses that to read a
// screen whose BOTTOM changed right away, instead of waiting out the backoff
// meant for bodies that only keep scrolling.
const BOTTOM_LINES = 4

function bottomFingerprint(normalizedText) {
  return paneFingerprint(lastLines(normalizedText, BOTTOM_LINES))
}

function paneFingerprint(normalizedText) {
  return crypto
    .createHash('sha1')
    .update(String(normalizedText || ''))
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH)
}

// Returns the visible pane contents, not the scrollback: the question is what
// the user is looking at. -J joins wrapped lines so a long sentence is not split
// into fragments that read like separate UI elements.
//
// Only the visible screen is read, never scrollback: the question asked of the
// model is what the screen shows now, and older text is exactly the irrelevant
// detail it is documented to lose accuracy on. (CLIs drawing on the alternate
// screen, as Claude Code does, have no scrollback for tmux to return anyway.)
function capturePaneRaw(paneId) {
  if (!paneId) return null
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', String(paneId)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch (_) {
    return null
  }
}

// The last `lines` lines of CONTENT. capture-pane returns every row of the
// pane, and a tall pane whose CLI has printed only a few lines is mostly empty
// rows below it; slicing before dropping those would keep nothing but blanks,
// leaving the classifier with an empty screen it skips forever.
// capture-pane returns every row of the pane, including the empty ones below a
// CLI that has printed only a few lines. Everything downstream reasons about
// "the bottom of the screen", and for them that means the last line with
// something on it.
function withoutTrailingBlankRows(text) {
  const all = String(text || '').split('\n')
  let end = all.length
  while (end > 0 && all[end - 1].trim() === '') end--
  return all.slice(0, end).join('\n')
}

function lastLines(text, lines) {
  const count = Number.isInteger(lines) && lines > 0 ? lines : DEFAULT_TAIL_LINES
  return withoutTrailingBlankRows(text).split('\n').slice(-count).join('\n')
}

// capturePaneTail(paneId, lines) -> { raw, text, fingerprint } | null
// `text` is normalized and ready to hand to the classifier; `raw` is kept for
// regex extraction of prompts and tool arguments, which needs the original.
function capturePaneTail(paneId, lines = DEFAULT_TAIL_LINES) {
  const captured = capturePaneRaw(paneId)
  if (captured === null) return null
  return captureFromText(paneId, captured, lines)
}

// capturePanes(paneIds, lines) -> Map<paneId, capture>, one tmux process for all
// of them. Starting a process is the expensive part, not the capture: on a
// machine where every spawn costs 60-190ms, twelve panes read one at a time
// took most of a 2-second tick, and every pane waited three ticks for a turn.
// As one command sequence, 46 panes read in about 160ms.
//
// Each pane's output is preceded by a line carrying a marker unique to the
// call, which is what the output is split on; the pane id printed after it
// says whose screen follows. A pane that closed since it was listed ends the
// sequence — tmux stops at the first command that fails — so the panes after
// it are read again by another call. A pane missing from the map was not read.
//
// `memo` (pane -> its previous capture) is read and updated: a pane whose text
// has not changed gets its previous capture back, not a new one.
function capturePanes(paneIds, lines = DEFAULT_TAIL_LINES, run = runTmux, memo = null) {
  const captures = new Map()
  let pending = [...new Set((paneIds || []).filter(Boolean).map(String))]
  while (pending.length > 0) {
    const marker = `\u001fscout:${crypto.randomBytes(6).toString('hex')}:`
    const args = []
    for (const paneId of pending) {
      if (args.length > 0) args.push(';')
      args.push('display-message', '-p', '-t', paneId, `${marker}#{pane_id}`, ';', 'capture-pane', '-p', '-J', '-t', paneId)
    }
    const result = run(args)
    if (!result || typeof result.stdout !== 'string') break
    const segments = result.stdout.split(marker).slice(1)
    segments.forEach((segment, index) => {
      // The last segment of a failed sequence is the pane that failed.
      if (result.status !== 0 && index === segments.length - 1) return
      const newline = segment.indexOf('\n')
      if (newline < 0 || segment.slice(0, newline) !== pending[index]) return
      const paneId = pending[index]
      const capture = captureFromText(paneId, segment.slice(newline + 1), lines, memo && memo.get(paneId))
      captures.set(paneId, capture)
      if (memo) memo.set(paneId, capture)
    })
    if (result.status === 0 || segments.length === 0) break
    pending = pending.slice(segments.length)
  }
  return captures
}

function runTmux(args) {
  return spawnSync('tmux', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024
  })
}

// The pure half of capturePaneTail, for callers that already have the text —
// jev-eval replays fixtures through it, so what it scores is what production
// would have sent.
function captureFromText(paneId, captured, lines = DEFAULT_TAIL_LINES, previous = null) {
  // Trimmed here, once, so the prompt extractor gets the same bottom the
  // classifier does. It locates the composer inside a bottom window of a few
  // lines; with blank rows under it the composer falls outside that window and
  // an unsent draft is read back as the submitted prompt.
  const raw = withoutTrailingBlankRows(captured)
  // The same text normalizes to the same everything. Normalizing is a dozen
  // regular expressions over the whole screen, and most screens have not
  // changed since they were last read.
  if (previous && previous.paneId === paneId && previous.raw === raw && previous.lines === lines) return previous
  const text = normalizePaneText(lastLines(raw, lines))
  return { paneId, raw, lines, text, fingerprint: paneFingerprint(text), bottom: bottomFingerprint(text) }
}

module.exports = {
  DEFAULT_TAIL_LINES,
  capturePaneTail,
  capturePanes,
  captureFromText,
  BRAILLE,
  bottomFingerprint,
  lastLines,
  normalizePaneText,
  withoutTrailingBlankRows,
  paneFingerprint
}
