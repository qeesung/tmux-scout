#!/usr/bin/env node
// Single-process entry point: sync data then render picker lines.

const statusFile = process.argv[2]
const currentPane = process.argv[3] || ''

if (!statusFile) process.exit(1)

let cached
try { cached = require('./sync').run(statusFile) } catch (_) {}
require('./render').run(statusFile, currentPane, cached)
