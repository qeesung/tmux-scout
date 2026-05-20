// Central metadata for known terminal coding agents.

const path = require('path')

// Shells are never agent processes themselves. We exclude them so a transient
// shell whose argv happens to contain "/claude-XXXX-cwd" (or similar tmp-file
// patterns from agent CLIs) can't be misidentified as the agent.
const SHELL_BASENAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'nu'])

// `color` is the terminal foreground chosen from the product palette for legibility.
const AGENTS = [
  {
    id: 'claude',
    label: 'claude',
    brandColor: '#d97757',
    color: '38;5;173',
    processNames: ['claude'],
    // Anchored so /tmp/claude-XXXX-cwd (Claude Code tmp marker) does NOT match.
    // Accepts `claude`, `claude.js`/`.mjs`/`.cjs` so `node /path/claude.js` still matches.
    commandIncludes: ['claude-code', /(^|\/)claude(\.[cm]?js)?(\s|$)/]
  },
  {
    id: 'codex',
    label: 'codex',
    brandColor: '#10a37f',
    color: '38;5;36',
    processNames: ['codex'],
    commandIncludes: [/\/codex\b/]
  },
  {
    id: 'opencode',
    label: 'opencode',
    brandColor: '#fab283',
    color: '38;5;216',
    processNames: ['opencode'],
    commandIncludes: ['opencode']
  },
  {
    id: 'gemini',
    label: 'gemini',
    brandColor: '#4285f4',
    color: '38;5;69',
    processNames: ['gemini'],
    commandIncludes: ['gemini-cli', /\/gemini\b/]
  },
  {
    id: 'copilot-cli',
    aliases: ['copilot', 'github-copilot'],
    label: 'copilot',
    brandColor: '#8534f3',
    color: '38;5;99',
    processNames: ['copilot'],
    commandIncludes: ['gh copilot', 'github-copilot']
  },
  {
    id: 'cursor',
    label: 'cursor',
    brandColor: '#edecec',
    color: '38;5;255',
    processNames: ['cursor'],
    commandIncludes: ['cursor-agent', /\/cursor\b/]
  },
  {
    id: 'kimi',
    label: 'kimi',
    brandColor: '#0d0f14',
    color: '38;5;246',
    processNames: ['kimi'],
    commandIncludes: [/\/kimi\b/]
  },
  {
    id: 'hermes',
    label: 'hermes',
    brandColor: '#e5c07b',
    color: '38;5;180',
    processNames: ['hermes'],
    commandIncludes: [/\/hermes\b/]
  },
  {
    id: 'coco',
    aliases: ['trae'],
    label: 'Trae',
    brandColor: '#32f08c',
    color: '38;5;84',
    processNames: ['trae', 'coco'],
    commandIncludes: ['traecli', /\/trae\b/, /\/coco\b/]
  }
]

const byName = new Map()
for (const agent of AGENTS) {
  byName.set(agent.id, agent)
  for (const alias of agent.aliases || []) byName.set(alias, agent)
}

function normalizeAgentType(value) {
  return String(value || '').trim().toLowerCase()
}

function agentConfig(agentType) {
  const normalized = normalizeAgentType(agentType)
  return byName.get(normalized) || {
    id: normalized || 'unknown',
    label: normalized || 'agent',
    color: '37',
    processNames: normalized ? [normalized] : [],
    commandIncludes: normalized ? [normalized] : []
  }
}

function agentDisplay(agentType) {
  const config = agentConfig(agentType)
  return {
    label: config.label || config.id,
    color: config.color || '37'
  }
}

function matchesNeedle(needle, command) {
  if (!needle) return false
  if (needle instanceof RegExp) return needle.test(command)
  const lowered = normalizeAgentType(needle)
  return lowered.length > 0 && command.includes(lowered)
}

function scoreAgentProcess(proc, agentType) {
  const config = agentConfig(agentType)
  const name = String(proc && proc.basename ? proc.basename : '').toLowerCase()
  const command = String(proc && (proc.commandLine || proc.args || proc.command) || '').toLowerCase()
  const commandPath = String(proc && proc.command || '').toLowerCase()
  const basename = path.basename(commandPath).toLowerCase()
  const processNames = (config.processNames || []).map(normalizeAgentType)
  const needles = config.commandIncludes || []

  if (!config.id || config.id === 'unknown') return 0
  if (SHELL_BASENAMES.has(name) || SHELL_BASENAMES.has(basename)) return 0
  if (processNames.includes(name) || processNames.includes(basename)) return 100
  if (name.includes(config.id) || basename.includes(config.id)) return 80
  if ((config.aliases || []).some(alias => name.includes(alias) || basename.includes(alias))) return 75
  if (needles.some(needle => matchesNeedle(needle, command))) return 70
  return 0
}

module.exports = {
  AGENTS,
  normalizeAgentType,
  agentConfig,
  agentDisplay,
  scoreAgentProcess
}
