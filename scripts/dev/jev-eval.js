#!/usr/bin/env node
// Measure the pane question set against labelled fixtures.
//
// The criteria wording in pane-questions.js is the part of this feature that
// actually determines accuracy, and wording has no type checker. This script is
// the substitute: label a screen, ask the model, count how often it agrees, and
// report how confident it was when it did not. Run it after every edit to the
// question set.
//
// It is deliberately NOT part of `npm test`: it needs a key and costs money.
//
//   npm run jev-eval               all fixtures
//   npm run jev-eval -- --agent codex
//   npm run jev-eval -- --verbose  per-case answers

const { loadPaneFixtures } = require('../lib/pane-fixtures')
const { captureFromText } = require('../lib/pane-capture')
const { buildPaneState, paneQuestions, PANE_QUESTION_SET_VERSION } = require('../lib/pane-questions')
const { interpretPaneAnswers } = require('../lib/pane-classifier')
const { createJevClient, resolveApiKey } = require('../lib/jev-client')

const { USD_PER_INPUT_MTOK } = require('../lib/pane-metrics')

const PRICE_PER_INPUT_TOKEN = USD_PER_INPUT_MTOK / 1e6

function parseArgs(argv) {
  const args = { agent: null, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') args.agent = argv[++i]
    else if (argv[i] === '--verbose') args.verbose = true
  }
  return args
}

// Through the same pipeline a live pane goes through — trimmed, cut to the
// tail, normalized — so what this scores is what production would have sent.
function captureFromFixture(fixture) {
  return captureFromText(fixture.id, fixture.text)
}

function pad(value, width) {
  return String(value).padEnd(width)
}

function printConfusion(rows) {
  const labels = [...new Set(rows.flatMap(row => [row.expected, row.actual]))].sort()
  if (labels.length === 0) return
  const width = Math.max(...labels.map(label => label.length)) + 2
  console.log('\nConfusion matrix (rows = expected, columns = predicted)')
  console.log(pad('', width) + labels.map(label => pad(label.slice(0, 10), 12)).join(''))
  for (const expected of labels) {
    const cells = labels.map(actual =>
      pad(rows.filter(row => row.expected === expected && row.actual === actual).length, 12))
    console.log(pad(expected, width) + cells.join(''))
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const log = message => console.error(message)
  const client = createJevClient({ apiKey: resolveApiKey(null, log), log })

  if (!client.available) {
    console.error(`Cannot run: TypeSafe client unavailable (${client.reason}).`)
    console.error('Set TYPESAFE_API_KEY, or `tmux set-environment -g TYPESAFE_API_KEY ...`.')
    process.exit(2)
  }

  const fixtures = loadPaneFixtures().filter(item => !args.agent || item.agent === args.agent)
  if (fixtures.length === 0) {
    console.error('No fixtures matched.')
    process.exit(2)
  }

  console.log(`model=${client.model} questionSet=v${PANE_QUESTION_SET_VERSION} fixtures=${fixtures.length}\n`)

  const rows = []
  let inputTokens = 0
  let latencyTotal = 0

  for (const fixture of fixtures) {
    const capture = captureFromFixture(fixture)
    const result = await client.classify(buildPaneState(capture, fixture.agent), paneQuestions())

    if (!result.ok) {
      console.log(`${pad(fixture.id, 28)} ERROR ${result.errorKind} ${result.error || ''}`)
      rows.push({ id: fixture.id, expected: fixture.expect.choice, actual: 'error', ok: false, confidence: 0 })
      continue
    }

    inputTokens += result.usage.input_tokens
    latencyTotal += result.latencyMs

    const answers = result.answers
    const actual = answers.screen_state.choice
    const confidence = answers.screen_state.confidence
    const expected = fixture.expect.choice
    const interp = interpretPaneAnswers(answers, { currentPhase: 'running' })
    const agrees = actual === expected
    // A wrong answer the gate rejects costs nothing; a wrong answer it accepts
    // is what actually moves a session into the wrong state.
    const phaseMatches = interp.phase === (fixture.expect.phase || null)

    rows.push({ id: fixture.id, expected, actual, ok: agrees, confidence, gate: interp.gate, phaseMatches })

    const mark = agrees ? 'ok  ' : 'FAIL'
    console.log(
      `${mark} ${pad(fixture.id, 28)} ${pad(actual, 22)} conf=${confidence.toFixed(2)} ` +
      `gate=${pad(interp.gate, 7)} phase=${pad(interp.phase || 'null', 19)} ${phaseMatches ? '' : `(expected ${fixture.expect.phase})`}`
    )
    if (args.verbose) {
      for (const [name, answer] of Object.entries(answers)) {
        if (answer.type === 'noul') console.log(`       ${pad(name, 26)} ${answer.noul.toFixed(2)}`)
      }
    }
  }

  const correct = rows.filter(row => row.ok).length
  const accepted = rows.filter(row => row.gate === 'accept')
  // Wrong in either sense: the choice, or the phase it became. A right choice
  // can still land on a wrong phase through an auxiliary answer — a spurious
  // interrupt marker turns a correct idle_ready into interrupted — and a wrong
  // phase is exactly what would mis-set a session.
  const acceptedWrong = accepted.filter(row => !row.ok || !row.phaseMatches)
  const meanConfidence = rows.length
    ? rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length
    : 0

  printConfusion(rows.filter(row => row.actual !== 'error'))

  console.log(`\naccuracy         ${correct}/${rows.length}  (${((correct / rows.length) * 100).toFixed(0)}%)`)
  console.log(`phase agreement  ${rows.filter(row => row.phaseMatches).length}/${rows.length}`)
  console.log(`accepted wrong   ${acceptedWrong.length}  <- the ones that would actually mis-set a session`)
  console.log(`mean confidence  ${meanConfidence.toFixed(2)}`)
  console.log(`mean latency     ${Math.round(latencyTotal / Math.max(1, rows.length))}ms`)
  console.log(`input tokens     ${inputTokens} (mean ${Math.round(inputTokens / Math.max(1, rows.length))}/call)`)
  console.log(`cost             $${(inputTokens * PRICE_PER_INPUT_TOKEN).toFixed(6)}`)

  // A failed request is not a wrong answer, so it never reaches acceptedWrong —
  // which let an evaluation where every call failed on auth report success.
  // An eval that did not evaluate has to say so to whoever ran it.
  const failed = rows.filter(row => row.actual === 'error')
  if (failed.length > 0) console.log(`failed requests  ${failed.length}  <- no answer at all; check the key and the network`)
  if (acceptedWrong.length > 0 || failed.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
