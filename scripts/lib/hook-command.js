// Shared helpers for shell hook commands installed into agent config files.

const path = require('path')

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function wrapWithInstallCheck(command, hookPath) {
  return `[ -e ${shellQuote(hookPath)} ] || exit 0; ${command}`
}

function buildNodeHookCommand(hookPath) {
  return wrapWithInstallCheck(`node ${shellQuote(hookPath)}`, hookPath)
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
  extractHookPathFromCommand
}
