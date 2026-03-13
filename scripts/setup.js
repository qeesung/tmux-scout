#!/usr/bin/env node
// tmux-scout unified hook setup
// Usage: node setup.js <install|uninstall|status> [--claude] [--codex] [--quiet]

const claude = require('./setup/claude')
const codex = require('./setup/codex')

const args = process.argv.slice(2)
const command = args.find(a => !a.startsWith('-'))
const flags = new Set(args.filter(a => a.startsWith('-')))

const onlyClaude = flags.has('--claude')
const onlyCodex = flags.has('--codex')
const quiet = flags.has('--quiet')
const runClaude = !onlyCodex || onlyClaude
const runCodex = !onlyClaude || onlyCodex

// Colors
const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`
}

function doInstall() {
  console.log()
  console.log(c.bold('tmux-scout hook setup'))
  console.log(c.dim('─'.repeat(21)))
  let ok = true

  if (runClaude) {
    console.log()
    console.log(c.cyan('Claude Code') + c.dim(' (~/.claude/settings.json)'))
    const r = claude.install()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      for (const { event, action } of r.results) {
        const icon = action === 'ok' ? c.green('✓') : action === 'updated' ? c.yellow('↻') : c.green('✓')
        const label = action === 'ok' ? 'already installed' : action === 'updated' ? 'path updated' : 'hook installed'
        console.log(`  ${icon} ${event.padEnd(17)} ${label}`)
      }
    }
  }

  if (runCodex) {
    console.log()
    console.log(c.cyan('Codex') + c.dim(' (~/.codex/config.toml)'))
    const r = codex.install()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      const icon = r.action === 'ok' ? c.green('✓') : r.action === 'updated' ? c.yellow('↻') : c.green('✓')
      const label = r.action === 'ok' ? 'already installed' : r.action === 'updated' ? 'path updated' : 'hook installed'
      const extra = r.hasOriginalNotify ? c.dim(' (original notify preserved)') : ''
      console.log(`  ${icon} notify ${label}${extra}`)
    }
  }

  console.log()
  console.log(ok ? 'Done.' : 'Done with warnings.')
}

function doUninstall() {
  console.log()
  console.log(c.bold('tmux-scout hook removal'))
  console.log(c.dim('─'.repeat(22)))

  if (runClaude) {
    console.log()
    console.log(c.cyan('Claude Code') + c.dim(' (~/.claude/settings.json)'))
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

  if (runCodex) {
    console.log()
    console.log(c.cyan('Codex') + c.dim(' (~/.codex/config.toml)'))
    const r = codex.uninstall()
    if (r.skipped) {
      console.log('  ' + c.yellow('⊘') + ' ' + r.reason)
    } else {
      const icon = r.action === 'removed' ? c.red('✗') : c.dim('·')
      const label = r.action === 'removed' ? 'removed' : 'not installed'
      console.log(`  ${icon} notify ${label}`)
    }
  }

  console.log()
  console.log('Done.')
}

function doStatus() {
  let allOk = true

  if (!quiet) console.log()

  if (runClaude) {
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

  if (runCodex) {
    const r = codex.status()
    if (!r.available) {
      // Codex not installed — not a problem
      if (!quiet) console.log(c.dim('Codex: not installed'))
    } else if (r.installed) {
      if (!quiet) console.log(c.green('Codex') + ': hook installed ' + c.green('✓'))
    } else {
      allOk = false
      if (!quiet) console.log(c.yellow('Codex') + ': hook not installed')
    }
  }

  if (!quiet) console.log()

  if (!allOk) process.exit(1)
}

// Main dispatch
if (!command || !['install', 'uninstall', 'status'].includes(command)) {
  console.log('Usage: node setup.js <install|uninstall|status> [--claude] [--codex] [--quiet]')
  process.exit(command ? 1 : 0)
}

try {
  if (command === 'install') doInstall()
  else if (command === 'uninstall') doUninstall()
  else if (command === 'status') doStatus()
} catch (e) {
  console.error('Error: ' + e.message)
  process.exit(1)
}
