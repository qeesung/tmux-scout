#!/usr/bin/env node
// Preview and document agent colors from the central agent registry.

const { AGENTS } = require('../lib/agents')

const AGENT_DOCS = {
  claude: { name: 'Claude Code', flag: '--claude', colorName: 'warm orange', slug: 'claude' },
  codex: { name: 'Codex', flag: '--codex', colorName: 'green', slug: 'codex' },
  opencode: { name: 'OpenCode', flag: '--opencode', colorName: 'peach', slug: 'opencode' },
  gemini: { name: 'Gemini CLI', flag: '--gemini', colorName: 'blue', slug: 'gemini' },
  'copilot-cli': { name: 'GitHub Copilot CLI', flag: '--copilot-cli', colorName: 'purple', slug: 'copilot' },
  cursor: { name: 'Cursor Agent', flag: '--cursor', colorName: 'near-white', slug: 'cursor' },
  kimi: { name: 'Kimi CLI', flag: '--kimi', colorName: 'gray', slug: 'kimi' },
  hermes: { name: 'Hermes', flag: '--hermes', colorName: 'sand', slug: 'hermes' },
  coco: { name: 'Trae CLI', flag: '--trae', colorName: 'bright green', slug: 'trae' },
  traex: { name: 'Traex CLI', flag: '--traex', colorName: 'mint', slug: 'traex' }
}

const XTERM_STEPS = [0, 95, 135, 175, 215, 255]

function componentToHex(value) {
  return value.toString(16).padStart(2, '0')
}

function rgbToHex(rgb) {
  return '#' + rgb.map(componentToHex).join('')
}

function xtermCodeToHex(code) {
  if (code >= 16 && code <= 231) {
    const index = code - 16
    const r = Math.floor(index / 36)
    const g = Math.floor((index % 36) / 6)
    const b = index % 6
    return rgbToHex([XTERM_STEPS[r], XTERM_STEPS[g], XTERM_STEPS[b]])
  }
  if (code >= 232 && code <= 255) {
    const value = 8 + ((code - 232) * 10)
    return rgbToHex([value, value, value])
  }
  return null
}

function colorHex(color) {
  const [, code] = String(color || '').match(/^38;5;(\d+)$/) || []
  return code ? xtermCodeToHex(Number.parseInt(code, 10)) : null
}

function agentColorRows() {
  return AGENTS.map(agent => {
    const docs = AGENT_DOCS[agent.id] || {}
    return {
      agent: docs.name || agent.label,
      label: agent.label,
      flag: docs.flag || '',
      colorName: docs.colorName || 'default',
      swatch: `docs/agent-colors/${docs.slug || agent.id}.svg`,
      colorHex: colorHex(agent.color) || '#ffffff'
    }
  })
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
    '| Agent | Picker label | Setup flag | User-visible color |',
    '|---|---|---|---|',
    ...agentColorRows().map(row => {
      return `| ${row.agent} | \`${row.label}\` | \`${row.flag}\` | ![${row.colorHex}](${row.swatch}) ${row.colorName} (\`${row.colorHex}\`) |`
    })
  ].join('\n')
}

function renderTerminal() {
  console.log('tmux-scout agent colors')
  console.log(`${'agent'.padEnd(20)} ${'label'.padEnd(10)} ${'flag'.padEnd(14)} color`)
  console.log(`${'-----'.padEnd(20)} ${'-----'.padEnd(10)} ${'----'.padEnd(14)} -----`)

  for (const row of agentColorRows()) {
    const agent = AGENTS.find(item => item.label === row.label)
    const [, code] = String(agent && agent.color || '').match(/^38;5;(\d+)$/) || []
    const [r, g, b] = hexToRgb(row.colorHex)
    const label = row.label.padEnd(10)
    const sample = code ? `\x1b[38;5;${code}m${label}\x1b[0m` : label
    const swatch = Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)
      ? `\x1b[48;2;${r};${g};${b}m  \x1b[0m`
      : '  '
    console.log(`${row.agent.padEnd(20)} ${row.label.padEnd(10)} ${row.flag.padEnd(14)} ${sample} ${swatch} ${row.colorName} ${row.colorHex}`)
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
