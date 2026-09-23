// Loader for pane-text fixtures under tests/fixtures/pane/.
//
// A fixture is a scenario JSON plus the pane text it describes:
//
//   <scenario>.txt         required — one captured frame
//   <scenario>.frame2.txt  optional — a second frame of the same screen
//   <scenario>.json        required — { name, agent, expect }
//
// When a second frame is present the two must normalize to the same
// fingerprint. That assertion is the contract behind the whole cost model: if
// two frames of one unchanged screen disagree, every tick pays for a fresh
// classification of a state that did not move.
//
// Fixture text is reconstructed UI chrome with synthetic body content. The
// chrome is what a classifier reads; the prose is not, and real captures carry
// whatever the user happened to be working on.

const fs = require('fs')
const path = require('path')
const { collectFixtureFiles } = require('./flow-fixtures')

const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'pane')
const FRAME2_SUFFIX = '.frame2.txt'

function readPaneFixture(jsonPath) {
  const scenario = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  const base = jsonPath.replace(/\.json$/, '')
  const textPath = `${base}.txt`
  const frame2Path = `${base}${FRAME2_SUFFIX}`
  return {
    id: path.relative(DEFAULT_FIXTURE_DIR, base),
    jsonPath,
    textPath,
    name: scenario.name || path.basename(base),
    agent: scenario.agent,
    expect: scenario.expect || {},
    text: fs.readFileSync(textPath, 'utf-8'),
    frame2: fs.existsSync(frame2Path) ? fs.readFileSync(frame2Path, 'utf-8') : null
  }
}

// Pane fixtures use the same layout as flow fixtures (<agent>/<scenario>.json
// plus sidecar files), so they are collected by the same walker.
function loadPaneFixtures(rootDir = DEFAULT_FIXTURE_DIR) {
  return collectFixtureFiles(rootDir).map(readPaneFixture)
}

module.exports = {
  DEFAULT_FIXTURE_DIR,
  loadPaneFixtures
}
