// Regex extraction of the display fields a System One model cannot produce.
//
// Jev returns typed decisions, never generated text, so `lastUserPrompt` and
// `sessionTitle` have to be read off the screen directly. That makes this the
// most brittle module in the pane pipeline: every pattern here is a bet on one
// CLI's current rendering, and a TUI redesign breaks it. Two consequences shape
// the design:
//
//   * Nothing downstream may depend on extraction succeeding. A miss returns
//     undefined and callers fall back to the working directory name, exactly as
//     `scripts/hooks/generic.js:276` already does for hook sessions.
//   * Patterns live in one table so adding a CLI is a data change, and so a
//     broken pattern is obvious in a diff.
//
// Extraction runs on RAW pane text, not the normalized form. Normalization
// trims every line, which would let an indented "> quoted line" inside an
// agent's own output masquerade as a prompt echo. Column zero is the signal.

const { BRAILLE, withoutTrailingBlankRows } = require('./pane-capture')

const DEFAULT_COMPOSER_WINDOW = 6
const TITLE_MAX = 100

// `markers` are the glyphs a CLI puts in front of a submitted prompt and in
// front of its own composer — the same glyph in both places, which is why the
// composer has to be located positionally rather than by shape.
// `placeholders` are greyed hint strings shown in an EMPTY composer; matching
// one means the box is empty, not that the user typed that text.
//
// Verified against live panes: claude, codex. The others are extrapolated from
// the same shape and should be confirmed before being relied on.
const PANE_PATTERNS = Object.freeze({
  claude: {
    markers: ['❯', '>'],
    placeholders: ['try "how do i..."'],
    // The composer sits between two full-width rules, however many lines a
    // shift+enter draft runs to.
    composerRules: true,
    toolLine: /^\s*[⏺●]\s*([A-Z][A-Za-z]*)\((.*)\)\s*$/,
    // Every message starts with one, prose and tool calls alike.
    bullet: /^\s*[⏺●]\s/,
    // See extractBackgroundWork().
    background: {
      statusLine: /^\s*[✻✽✶✳✢✺·∙*]\s+\S/,
      finished: /\sfor\s.*·\s*done\b/,
      stillRunning: /·\s*([^·]*?\S)\s+still running\s*$/,
      footer: /·\s*(\d+\s+shells?)(?=\s*(?:·|$))/
    }
  },
  codex: {
    markers: ['»', '›'],
    placeholders: ['ask codex to do anything'],
    toolLine: /^ {2,}(Read|Search|Edit|Write|Run|List|Apply)\s+(\S.*)$/
  },
  gemini: {
    markers: ['>', '❯'],
    placeholders: ['type your message or @path/to/file'],
    toolLine: null
  },
  traex: {
    markers: ['❯'],
    placeholders: ['implement {feature}'],
    toolLine: null
  },
  default: {
    markers: ['❯', '›', '»'],
    placeholders: [],
    toolLine: null
  }
})

function patternsFor(agentType) {
  return PANE_PATTERNS[agentType] || PANE_PATTERNS.default
}

function cleanLine(line) {
  return String(line == null ? '' : line).replace(BRAILLE, ' ').replace(/\s+$/, '')
}

// A prompt line is the marker at column zero followed by content. Requiring
// column zero is what keeps an agent's own indented output from matching.
function promptContent(line, markers) {
  const text = cleanLine(line)
  for (const marker of markers) {
    if (!text.startsWith(marker)) continue
    const rest = text.slice(marker.length)
    if (rest && !/^\s/.test(rest)) continue
    return rest.trim()
  }
  return null
}

function isPlaceholder(content, placeholders) {
  const normalized = content.toLowerCase()
  return placeholders.some(item => normalized === item || normalized.startsWith(item))
}

// The composer and a submitted prompt render identically, so the composer is
// found by position: the lowest marker line inside the bottom window. Anything
// above it is scrollback, which is where submitted prompts live. Without this
// split, text the user is still typing would be read back as the session title.
//
// Where the CLI draws the composer between two rules, those bound it instead:
// a draft of four or more lines pushed its marker out of the bottom window, and
// the fallback then read the unsent draft back as the submitted prompt.
const RULE_LINE = /^[─━]{10,}$/
// Status lines under the lower rule; generous, since some CLIs draw two.
const RULE_SEARCH_LINES = 6

function ruleBoundedComposer(lines, patterns) {
  const floor = Math.max(0, lines.length - RULE_SEARCH_LINES)
  let lower = -1
  for (let i = lines.length - 1; i >= floor; i--) {
    if (RULE_LINE.test(cleanLine(lines[i]).trim())) { lower = i; break }
  }
  if (lower < 0) return -1
  for (let i = lower - 1; i >= 0; i--) {
    if (!RULE_LINE.test(cleanLine(lines[i]).trim())) continue
    // The marker is the first line inside the pair; anything else between two
    // rules (a dialog's own borders) is not a composer.
    return i + 1 < lower && promptContent(lines[i + 1], patterns.markers) !== null ? i + 1 : -1
  }
  return -1
}

function findComposerIndex(lines, patterns, composerWindow) {
  if (patterns.composerRules) {
    const bounded = ruleBoundedComposer(lines, patterns)
    if (bounded >= 0) return bounded
  }
  const floor = Math.max(0, lines.length - composerWindow)
  for (let i = lines.length - 1; i >= floor; i--) {
    if (promptContent(lines[i], patterns.markers) !== null) return i
  }
  return -1
}

// { prompt, composer }: `composer` says whether the composer itself was found,
// which is what makes a missing prompt mean "never prompted" rather than
// "could not tell".
function locatePrompt(raw, agentType, options = {}) {
  if (!raw) return { prompt: undefined, composer: false }
  const patterns = patternsFor(agentType)
  const composerWindow = Number.isFinite(options.composerWindow)
    ? options.composerWindow
    : DEFAULT_COMPOSER_WINDOW
  // Also here, not only in capturePaneTail: fixtures, debug.js and any other
  // caller hand this raw text directly, and the composer window counts from the
  // last row whether or not that row has anything on it.
  const lines = withoutTrailingBlankRows(raw).split('\n')
  const composerIndex = findComposerIndex(lines, patterns, composerWindow)
  const composer = composerIndex >= 0
  const start = composer ? composerIndex - 1 : lines.length - 1

  for (let i = start; i >= 0; i--) {
    const content = promptContent(lines[i], patterns.markers)
    if (!content) continue
    if (isPlaceholder(content, patterns.placeholders)) continue
    return { prompt: content, composer }
  }
  return { prompt: undefined, composer }
}

function titleFromPrompt(prompt) {
  if (!prompt) return undefined
  // Same shape hooks already use (scripts/hooks/claude.js:405) so pane-driven
  // rows read identically to hook-driven ones in the picker.
  const title = String(prompt).slice(0, TITLE_MAX).split('\n')[0].trim()
  return title || undefined
}

// Returns { lastUserPrompt, sessionTitle, confidence, composer }.
// `confidence` is 'exact' when a prompt echo was found and 'none' otherwise;
// callers use it to decide whether to fall back rather than to gate any phase.
function extractPromptAndTitle(raw, agentType, options = {}) {
  const { prompt: lastUserPrompt, composer } = locatePrompt(raw, agentType, options)
  if (!lastUserPrompt) return { confidence: 'none', composer }
  return {
    lastUserPrompt,
    sessionTitle: titleFromPrompt(lastUserPrompt),
    confidence: 'exact',
    composer
  }
}

// In the form the reducer stores pendingInteraction.details in: no line breaks
// or tabs, trimmed, at most 200 characters. The classifier compares the two to
// decide whether a dialog changed, and a cut that ended on a space never
// matched the trimmed stored value — every tick re-sent the wait and rewrote
// the session file.
function comparableDetails(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 200).trim()
}

// Best-effort tool detail for the picker's activity column. Claude's bullet
// form is not yet verified against a live pane — confirm it while tuning the
// question set, and until then a miss simply yields no detail.
function extractToolLine(raw, agentType) {
  const patterns = patternsFor(agentType)
  if (!raw || !patterns.toolLine) return {}
  const lines = String(raw).split('\n')

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = cleanLine(lines[i])
    const match = line.match(patterns.toolLine)
    if (!match) {
      // The newest message decides. When it is prose, or a tool drawn some
      // other way, any tool line further up belongs to a call that already
      // finished — and was reported as what an approval dialog below it was
      // asking about.
      if (patterns.bullet && patterns.bullet.test(line)) return {}
      continue
    }
    const tool = match[1]
    const args = (match[2] || '').trim()
    return { tool, details: comparableDetails(args ? `${tool}: ${args}` : tool) }
  }
  return {}
}

// How many lines above the composer the newest status line may sit. A
// "※ recap:" summary or a "/goal active" note can come between the two.
const STATUS_SEARCH_LINES = 12
// Claude writes the session's name or branch into the rule above its composer
// ("───── example-branch ─"), so here a rule only has to start like one.
const LABELLED_RULE_LINE = /^[─━]{10,}/

// What a finished turn left running: background shells or agents, which report
// back when they end and start the agent on a turn of its own. Claude Code says
// so in two places around its composer:
//
//   * the status line of the newest turn, as in "✻ Cooked for 1m 27s · done
//     7:19 PM · 1 shell still running". Only the newest: every finished turn's
//     line stays in the transcript, and an older one says what was running when
//     that turn ended, not now. Found as the first status line above the
//     composer, short of a message bullet or a prompt echo, which belong to an
//     earlier turn — and a working turn's spinner line is a status line too, so
//     a turn under way never reads the finished line above it.
//   * the footer under the composer, as in "⏵⏵ bypass permissions on · 1 shell",
//     which counts the shells still running whatever the status line said.
//
// "← 3 agents" in the same footer is neither: it is on every pane, finished
// turns and running ones alike, and says nothing about what is running.
//
// Returns what is running, such as "1 shell still running"; null when the
// composer was found and nothing is; undefined when there is no telling.
function extractBackgroundWork(raw, agentType) {
  const patterns = patternsFor(agentType)
  const background = patterns.background
  if (!raw || !background) return undefined
  const lines = withoutTrailingBlankRows(raw).split('\n')
  const composer = findComposerIndex(lines, patterns, DEFAULT_COMPOSER_WINDOW)
  if (composer < 0) return undefined

  // The status line first: it names agents as well as shells.
  const floor = Math.max(0, composer - 1 - STATUS_SEARCH_LINES)
  for (let i = composer - 1; i >= floor; i--) {
    const line = cleanLine(lines[i])
    if (LABELLED_RULE_LINE.test(line.trim())) continue
    if (patterns.bullet.test(line) || promptContent(line, patterns.markers) !== null) break
    if (!background.statusLine.test(line)) continue
    const match = background.finished.test(line) && line.match(background.stillRunning)
    if (match) return `${match[1]} still running`
    break
  }

  let lower = composer + 1
  while (lower < lines.length && !LABELLED_RULE_LINE.test(cleanLine(lines[lower]).trim())) lower++
  for (let i = lower + 1; i < lines.length; i++) {
    const match = cleanLine(lines[i]).match(background.footer)
    if (match) return `${match[1]} still running`
  }
  return null
}

module.exports = {
  extractBackgroundWork,
  extractPromptAndTitle,
  extractToolLine
}
