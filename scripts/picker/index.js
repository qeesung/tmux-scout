#!/usr/bin/env node
// Single-process entry point: sync data then render picker lines.

const statusFile = process.argv[2]
const currentPane = process.argv[3] || ''

if (!statusFile) process.exit(1)

let cached
try {
  const sync = require('./sync')
  const watcherRunning = sync.isWatcherRunning()
  cached = sync.run(statusFile, watcherRunning
    ? { reconcile: false, codexMode: 'none', paneGroundTruth: false, stuckSweep: false, registryPrune: false }
    : {})
} catch (_) {}
require('./render').run(statusFile, currentPane, cached)
