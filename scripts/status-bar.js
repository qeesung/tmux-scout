#!/usr/bin/env node
// Lightweight status bar widget: counts active sessions by status.
// Called by tmux via #(node .../status-bar.js) every status-interval.
//
// Customize via tmux option @scout-status-format using {W}, {B}, {D}, {I} placeholders.
// Example: set -g @scout-status-format '{W}/{B}/{D}/{I}'

const path = require('path')
const { execSync } = require('child_process')

const STATUS_FILE = (process.env.HOME || '') + '/.tmux-scout/status.json'
const BASE_FMT = '#[fg=#e06c75]{W}#[default]|#[fg=#e5c07b]{B}#[default]|#[fg=#98c379]{D}#[default]'
const IDLE_FMT = '|#[fg=#61afef]{I}#[default]'

// Reuse sync + render logic so counts stay aligned with picker
const sync = require(path.join(__dirname, 'picker', 'sync'))
const { getActiveSessions } = require(path.join(__dirname, 'picker', 'render'))

let cached
try { cached = sync.run(STATUS_FILE) } catch (_) {}
if (!cached || !cached.status) process.exit(0)

const active = getActiveSessions(cached.status, cached.panes)

const now = Date.now()
let wait = 0, busy = 0, done = 0, idle = 0

for (const s of active) {
  if (s.needsAttention || (s.pendingToolUse && s.pendingToolUse.timestamp && now - s.pendingToolUse.timestamp > 5000)) {
    wait++
  } else if (s.status === 'working') {
    busy++
  } else if (s.status === 'completed') {
    done++
  } else if (s.status === 'idle') {
    idle++
  }
}

if (wait + busy + done + idle === 0) process.exit(0)

let fmt = ''
try {
  fmt = execSync('tmux show-option -gqv @scout-status-format', {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
} catch (_) {}

if (fmt) {
  const output = fmt
    .replace(/\{W\}/g, String(wait))
    .replace(/\{B\}/g, String(busy))
    .replace(/\{D\}/g, String(done))
    .replace(/\{I\}/g, String(idle))
  process.stdout.write(output)
} else {
  let output = BASE_FMT
    .replace(/\{W\}/g, String(wait))
    .replace(/\{B\}/g, String(busy))
    .replace(/\{D\}/g, String(done))
  if (idle > 0) {
    output += IDLE_FMT.replace(/\{I\}/g, String(idle))
  }
  process.stdout.write(output + ' ')
}
