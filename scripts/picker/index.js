#!/usr/bin/env node
// Single-process entry point: sync data then render picker lines.

const statusFile = process.argv[2]
const currentPane = process.argv[3] || ''

if (!statusFile) process.exit(1)

let cached
try {
  const sync = require('./sync')
  const watcherRunning = sync.isWatcherRunning()
  // For whoever has no status bar widget: opening the picker brings it back.
  if (!watcherRunning) require('../lib/watcher-revive').reviveWatcher({ by: 'picker' })
  // When the watcher owns reconciliation, the picker must not run the sweeps
  // that force a session to a terminal state. idleComplete belongs with the
  // others: only the watcher can see which sessions the pane model is currently
  // watching, so running it here would force-complete a session the watcher was
  // deliberately leaving alone.
  cached = sync.run(statusFile, watcherRunning
    ? {
      reconcile: false,
      codexMode: 'none',
      paneGroundTruth: false,
      stuckSweep: false,
      idleComplete: false,
      registryPrune: false
    }
    : {})
} catch (_) {}
require('./render').run(statusFile, currentPane, cached)
