#!/usr/bin/env node
// tmux-scout unified hook setup
// Usage: node setup.js <install|uninstall|status> [--agent flags] [--quiet] [--any]

const path = require('path')
const { spawnSync } = require('child_process')
const { managerById, selectManagers } = require('./setup/managers')

const args = process.argv.slice(2)
const command = args.find(a => !a.startsWith('-'))
const flags = new Set(args.filter(a => a.startsWith('-')))

const quiet = flags.has('--quiet')
const selectedManagers = selectManagers(flags)
const selectedManagerIds = new Set(selectedManagers.map(manager => manager.id))
const claude = managerById.claude.module
const codex = managerById.codex.module

// Colors
const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`
}

function shouldRun(id) {
  return selectedManagerIds.has(id)
}

function printManagerHeader(id) {
  const manager = managerById[id]
  console.log(c.cyan(manager.label) + c.dim(' ' + manager.detail))
}

function otherSelectedManagers() {
  return selectedManagers.filter(manager => manager.id !== 'claude' && manager.id !== 'codex')
}

function printActionRows(results) {
  for (const { event, action } of results || []) {
    const icon = action === 'ok' ? c.green('✓')
      : action === 'updated' ? c.yellow('↻')
      : action === 'removed' || action === 'removed_legacy' ? c.red('✗')
      : action === 'not_found' ? c.dim('·')
      : c.green('✓')
    const label = action === 'ok' ? 'already installed'
      : action === 'updated' ? 'path updated'
      : action === 'removed' || action === 'removed_legacy' ? 'removed'
      : action === 'not_found' ? 'not installed'
      : 'hook installed'
    console.log(`  ${icon} ${String(event).padEnd(17)} ${label}`)
  }
}

function doInstall() {
  console.log()
  console.log(c.bold('tmux-scout hook setup'))
  console.log(c.dim('─'.repeat(21)))
  let ok = true

  if (shouldRun('claude')) {
    console.log()
    printManagerHeader('claude')
    const r = claude.install()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      for (const { event, action } of r.results) {
        const icon = action === 'ok' ? c.green('✓')
          : action === 'updated' ? c.yellow('↻')
          : action === 'removed_legacy' ? c.red('✗')
          : c.green('✓')
        const label = action === 'ok' ? 'already installed'
          : action === 'updated' ? 'path updated'
          : action === 'removed_legacy' ? 'legacy hook removed'
          : 'hook installed'
        console.log(`  ${icon} ${event.padEnd(17)} ${label}`)
      }
    }
  }

  if (shouldRun('codex')) {
    console.log()
    printManagerHeader('codex')
    const r = codex.install()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      for (const { event, action } of r.modern.results) {
        const icon = action === 'ok' ? c.green('✓') : action === 'updated' ? c.yellow('↻') : c.green('✓')
        const label = action === 'ok' ? 'already installed' : action === 'updated' ? 'path updated' : 'hook installed'
        console.log(`  ${icon} ${event.padEnd(17)} ${label}`)
      }
      const legacyIcon = r.legacy.action === 'ok' ? c.green('✓') : r.legacy.action === 'updated' ? c.yellow('↻') : c.green('✓')
      const legacyLabel = r.legacy.action === 'ok' ? 'already installed' : r.legacy.action === 'updated' ? 'path updated' : 'fallback hook installed'
      const extra = r.legacy.hasOriginalNotify ? c.dim(' (original notify preserved)') : ''
      console.log(`  ${legacyIcon} ${'notify'.padEnd(17)} ${legacyLabel}${extra}`)
    }
  }

  for (const manager of otherSelectedManagers()) {
    console.log()
    printManagerHeader(manager.id)
    const r = manager.module.install()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      printActionRows(r.results || [{ event: manager.id, action: r.action || 'installed' }])
    }
  }

  console.log()
  console.log(ok ? 'Done.' : 'Done with warnings.')
}

function doUninstall() {
  console.log()
  console.log(c.bold('tmux-scout hook removal'))
  console.log(c.dim('─'.repeat(22)))

  if (shouldRun('claude')) {
    console.log()
    printManagerHeader('claude')
    const r = claude.uninstall()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      for (const { event, action } of r.results) {
        const icon = action === 'removed' ? c.red('✗') : c.dim('·')
        const label = action === 'removed' ? 'removed' : 'not installed'
        console.log(`  ${icon} ${event.padEnd(17)} ${label}`)
      }
    }
  }

  if (shouldRun('codex')) {
    console.log()
    printManagerHeader('codex')
    const r = codex.uninstall()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      const modernIcon = r.modern.action === 'removed' ? c.red('✗') : c.dim('·')
      const modernLabel = r.modern.action === 'removed' ? 'removed' : 'not installed'
      console.log(`  ${modernIcon} ${'event hooks'.padEnd(17)} ${modernLabel}`)
      const legacyIcon = r.legacy.action === 'removed' ? c.red('✗') : c.dim('·')
      const legacyLabel = r.legacy.action === 'removed' ? 'removed' : 'not installed'
      console.log(`  ${legacyIcon} ${'notify'.padEnd(17)} ${legacyLabel}`)
    }
  }

  for (const manager of otherSelectedManagers()) {
    console.log()
    printManagerHeader(manager.id)
    const r = manager.module.uninstall()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      printActionRows(r.results || [{ event: manager.id, action: r.action || 'removed' }])
    }
  }

  console.log()
  console.log('Done.')
}

function doStatus() {
  if (flags.has('--any')) {
    const { checkManagerHealth } = require('./setup/managers')
    const anyInstalled = selectedManagers.some(manager => {
      const report = checkManagerHealth(manager)
      return report.installed || report.partial
    })
    if (!anyInstalled && !quiet) {
      console.log(c.yellow('tmux-scout') + ': no agent hooks installed')
    }
    process.exit(anyInstalled ? 0 : 1)
  }

  let allOk = true

  if (!quiet) console.log()

  if (shouldRun('claude')) {
    const r = claude.status()
    if (r.installed === r.total) {
      if (quiet) {
        // quiet mode — say nothing if all ok
      } else {
        console.log(c.green('Claude Code') + `: ${r.installed}/${r.total} hooks installed ` + c.green('✓'))
      }
    } else {
      allOk = false
      if (quiet) {
        // quiet mode still reports problems
      } else {
        console.log(c.yellow('Claude Code') + `: ${r.installed}/${r.total} hooks installed`)
        if (r.missing.length > 0) {
          console.log(c.dim('  Missing: ' + r.missing.join(', ')))
        }
      }
    }
  }

  if (shouldRun('codex')) {
    const r = codex.status()
    if (!r.available) {
      // Codex not installed — not a problem
      if (!quiet) console.log(c.dim('Codex: not installed'))
    } else if (r.modern.installed) {
      if (!quiet) console.log(c.green('Codex') + `: ${r.modern.installedEvents}/${r.modern.totalEvents} event hooks installed ` + c.green('✓'))
    } else if (r.modern.installedEvents === r.modern.totalEvents) {
      allOk = false
      if (!quiet) console.log(c.yellow('Codex') + ': event hooks installed but config/trust state is incomplete')
    } else if (r.legacy.installed) {
      allOk = false
      if (!quiet) console.log(c.yellow('Codex') + ': legacy notify hook installed (event hooks missing)')
    } else {
      allOk = false
      if (!quiet) console.log(c.yellow('Codex') + ': hook not installed')
    }
    if (!quiet && r.available && r.modern && r.modern.missing && r.modern.missing.length > 0) {
      console.log(c.dim('  Missing event hooks: ' + r.modern.missing.join(', ')))
    }
    if (!quiet && r.available && r.modern && !r.modern.featuresEnabled && r.modern.installedEvents === r.modern.totalEvents) {
      console.log(c.dim('  Missing config: [features].hooks = true'))
    }
    if (!quiet && r.available && r.modern && r.modern.missingTrust && r.modern.missingTrust.length > 0) {
      console.log(c.dim('  Missing trust state entries: ' + r.modern.missingTrust.length))
    }
  }

  for (const manager of otherSelectedManagers()) {
    const report = require('./setup/managers').checkManagerHealth(manager)
    if (report.installed) {
      if (!quiet) console.log(c.green(manager.label) + `: ${report.summary} ` + c.green('✓'))
    } else {
      allOk = false
      if (!quiet) {
        console.log(c.yellow(manager.label) + `: ${report.summary}`)
        for (const issue of report.issues || []) {
          console.log(c.dim('  ' + issue))
        }
      }
    }
  }

  if (!quiet) console.log()

  if (!allOk) process.exit(1)
}

function doWatcher() {
  const commandIndex = args.indexOf(command)
  const watcherArgs = args.slice(commandIndex + 1)
  if (watcherArgs.length === 0) watcherArgs.push('status')
  const result = spawnSync(process.execPath, [path.join(__dirname, 'watcher.js'), ...watcherArgs], {
    stdio: 'inherit'
  })
  process.exit(result.status || 0)
}

function doDoctor() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'doctor.js')], {
    stdio: 'inherit'
  })
  process.exit(result.status || 0)
}

// Main dispatch
if (!command || !['install', 'uninstall', 'status', 'doctor', 'watcher', 'watchdog'].includes(command)) {
  console.log('Usage: node setup.js <install|uninstall|status|doctor|watcher> [--claude] [--codex] [--gemini] [--kimi] [--copilot-cli] [--opencode] [--cursor] [--hermes] [--coco] [--quiet] [--any]')
  console.log('       node setup.js watcher <status|stop|once|run> [--full] [--quiet]')
  process.exit(command ? 1 : 0)
}

try {
  if (command === 'install') doInstall()
  else if (command === 'uninstall') doUninstall()
  else if (command === 'status') doStatus()
  else if (command === 'doctor') doDoctor()
  else if (command === 'watcher' || command === 'watchdog') doWatcher()
} catch (e) {
  console.error('Error: ' + e.message)
  process.exit(1)
}
