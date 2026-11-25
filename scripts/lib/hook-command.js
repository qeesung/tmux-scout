// Shared helpers for shell hook commands installed into agent config files.

const path = require('path')

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function wrapWithInstallCheck(command, hookPath) {
  return `[ -e ${shellQuote(hookPath)} ] || exit 0; ${command}`
}

function buildNodeHookCommand(hookPath, args = []) {
  const suffix = Array.isArray(args) && args.length > 0
    ? ' ' + args.map(shellQuote).join(' ')
    : ''
  return wrapWithInstallCheck(`node ${shellQuote(hookPath)}${suffix}`, hookPath)
}

// agy reads each hook's stdout as its answer. A PreToolUse hook that prints a
// JSON object without a "decision" — "{}" included — blocks the tool call
// ("tool call denied by pre-tool hook"), while printing nothing leaves the
// decision to agy. Every other event expects a JSON object. So the hook's own
// output is discarded and the wrapper answers: nothing for PreToolUse, "{}"
// otherwise, whatever the hook did. Outside tmux there is no pane to show the
// session in, and the desktop app and IDE read the same hooks.json, so node
// is not started at all.
function buildAgyHookCommand(hookPath, event) {
  const run = `node ${shellQuote(hookPath)} '--agent' 'agy' '--event' ${shellQuote(event)}`
  const guarded = `{ [ -n "$TMUX_PANE" ] && [ -e ${shellQuote(hookPath)} ] && ${run}; } >/dev/null 2>&1`
  return event === 'PreToolUse' ? `${guarded}; exit 0` : `${guarded}; printf '{}'`
}

function extractHookPathFromCommand(command, expectedBasename) {
  if (typeof command !== 'string' || !command) return null

  const quoted = /(['"])(.*?)\1/g
  let match
  while ((match = quoted.exec(command)) !== null) {
    const value = match[2]
    if (!expectedBasename || path.basename(value) === expectedBasename) return value
  }

  const unquoted = /(?:^|\s)(\/[^\s;&|]+\/scripts\/hooks\/[^\s;&|'"`]+)/g
  while ((match = unquoted.exec(command)) !== null) {
    const value = match[1]
    if (!expectedBasename || path.basename(value) === expectedBasename) return value
  }

  return null
}

module.exports = {
  shellQuote,
  wrapWithInstallCheck,
  buildNodeHookCommand,
  buildAgyHookCommand,
  extractHookPathFromCommand
}
