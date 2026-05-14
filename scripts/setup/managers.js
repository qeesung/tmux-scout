// Registry of supported agent hook managers.

const claude = require('./claude')
const codex = require('./codex')

const HOOK_MANAGERS = [
  {
    id: 'claude',
    flag: '--claude',
    label: 'Claude Code',
    detail: '(~/.claude/settings.json)',
    module: claude
  },
  {
    id: 'codex',
    flag: '--codex',
    label: 'Codex',
    detail: '(~/.codex/hooks.json + config.toml)',
    module: codex
  }
]

const managerById = {}
for (const manager of HOOK_MANAGERS) {
  managerById[manager.id] = manager
}

function selectManagers(flags) {
  const selectedFlags = flags || new Set()
  const hasAgentFlag = HOOK_MANAGERS.some(manager => selectedFlags.has(manager.flag))
  if (!hasAgentFlag) return [...HOOK_MANAGERS]
  return HOOK_MANAGERS.filter(manager => selectedFlags.has(manager.flag))
}

function claudeHealth(manager, status) {
  const installed = status.installed === status.total
  const partial = status.installed > 0
  const issues = []
  if (!installed) {
    if (status.missing && status.missing.length > 0) {
      issues.push('Missing hooks: ' + status.missing.join(', '))
    } else {
      issues.push('Hooks not installed')
    }
  }
  return {
    id: manager.id,
    label: manager.label,
    installed,
    partial,
    summary: `${status.installed}/${status.total} hooks installed`,
    issues,
    raw: status
  }
}

function codexHealth(manager, status) {
  if (!status.available) {
    return {
      id: manager.id,
      label: manager.label,
      installed: false,
      partial: false,
      summary: 'not installed',
      issues: ['Codex config directory not found'],
      raw: status
    }
  }

  const modern = status.modern || {}
  const legacy = status.legacy || {}
  const installedEvents = modern.installedEvents || 0
  const totalEvents = modern.totalEvents || 0
  const installed = Boolean(modern.installed)
  const partial = installed || installedEvents > 0 || Boolean(legacy.installed)
  const issues = []

  if (!installed) {
    if (modern.missing && modern.missing.length > 0) {
      issues.push('Missing event hooks: ' + modern.missing.join(', '))
    }
    if (installedEvents === totalEvents && !modern.featuresEnabled) {
      issues.push('Missing config: [features].hooks = true')
    }
    if (modern.missingTrust && modern.missingTrust.length > 0) {
      issues.push('Missing trust state entries: ' + modern.missingTrust.length)
    }
    if (legacy.installed && installedEvents < totalEvents) {
      issues.push('Legacy notify hook installed; event hooks incomplete')
    }
    if (!legacy.installed && installedEvents === 0) {
      issues.push('Hook not installed')
    }
  }

  return {
    id: manager.id,
    label: manager.label,
    installed,
    partial,
    summary: `${installedEvents}/${totalEvents} event hooks installed`,
    issues,
    raw: status
  }
}

function genericHealth(manager, status) {
  const installed = Boolean(status && status.installed)
  return {
    id: manager.id,
    label: manager.label,
    installed,
    partial: installed,
    summary: installed ? 'installed' : 'not installed',
    issues: installed ? [] : ['Hook not installed'],
    raw: status
  }
}

function checkManagerHealth(manager) {
  let status
  try {
    status = manager.module.status()
  } catch (error) {
    return {
      id: manager.id,
      label: manager.label,
      installed: false,
      partial: false,
      summary: 'status failed',
      issues: [error && error.message ? error.message : 'status failed'],
      raw: null
    }
  }

  if (manager.id === 'claude') return claudeHealth(manager, status)
  if (manager.id === 'codex') return codexHealth(manager, status)
  return genericHealth(manager, status)
}

function checkAllHealth(flags) {
  return selectManagers(flags).map(checkManagerHealth)
}

module.exports = {
  HOOK_MANAGERS,
  managerById,
  selectManagers,
  checkManagerHealth,
  checkAllHealth
}
