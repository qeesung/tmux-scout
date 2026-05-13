#!/usr/bin/env node
// Syntax-check all project JavaScript files without external dependencies.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SCAN_DIRS = ['scripts', 'tests']

function collectJsFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files)
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath)
    }
  }
  return files
}

const files = SCAN_DIRS
  .flatMap(dir => collectJsFiles(path.join(ROOT, dir)))
  .sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    failed++
    console.error(`Syntax check failed: ${path.relative(ROOT, file)}`)
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
}

if (failed > 0) {
  console.error(`Failed ${failed}/${files.length} JavaScript syntax checks.`)
  process.exit(1)
}

console.log(`Checked ${files.length} JavaScript files.`)
