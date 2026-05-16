#!/usr/bin/env node
// Preview and document agent colors from the central agent registry.

const { AGENTS } = require('../lib/agents')

function agentColorRows() {
  return AGENTS.map(agent => ({
    agent: agent.label,
    brandColor: agent.brandColor,
    xterm: agent.color
  }))
}

function hexToRgb(hex) {
  const value = String(hex || '').replace(/^#/, '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ]
}

function markdownTable() {
  return [
    '| Agent | Brand color | xterm |',
    '|---|---:|---:|',
    ...agentColorRows().map(row => `| ${row.agent} | \`${row.brandColor}\` | \`${row.xterm}\` |`)
  ].join('\n')
}

function renderTerminal() {
  console.log('tmux-scout agent colors')
  console.log(`${'agent'.padEnd(10)} ${'brand'.padEnd(9)} ${'xterm'.padEnd(10)} sample`)
  console.log(`${'-----'.padEnd(10)} ${'-----'.padEnd(9)} ${'-----'.padEnd(10)} ------`)

  for (const row of agentColorRows()) {
    const [, code] = row.xterm.match(/^38;5;(\d+)$/) || []
    const [r, g, b] = hexToRgb(row.brandColor)
    const label = row.agent.padEnd(10)
    const xterm = row.xterm.padEnd(10)
    const sample = code ? `\x1b[38;5;${code}m${label}\x1b[0m` : label
    const swatch = Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
      ? `\x1b[48;2;${r};${g};${b}m  \x1b[0m`
      : '  '
    console.log(`${row.agent.padEnd(10)} ${row.brandColor.padEnd(9)} ${xterm} ${sample} ${swatch} truecolor`)
  }
}

function run(argv = process.argv.slice(2)) {
  if (argv.includes('--markdown')) {
    console.log(markdownTable())
    return
  }
  renderTerminal()
}

module.exports = {
  agentColorRows,
  markdownTable,
  run
}

if (require.main === module) run()
