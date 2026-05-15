#!/usr/bin/env node
// Lightweight status bar widget: counts active sessions by status.
// Called by tmux via #(node .../status-bar.js) every status-interval.
//
// Customize via tmux option @scout-status-format using placeholders:
// {W}=wait, {B}=busy, {D}=done, {I}=idle, {A}=approval, {Q}=question, {P}=plan, {T}=total.
// Example: set -g @scout-status-format '{W}/{B}/{D}/{I}'

const path = require('path')
const fs = require('fs')
const { execSync } = require('child_process')

const STATUS_FILE = (process.env.HOME || '') + '/.tmux-scout/status.json'
const BASE_FMT = '#[fg=#e06c75]{W}#[default]|#[fg=#e5c07b]{B}#[default]|#[fg=#98c379]{D}#[default]'
const IDLE_FMT = '|#[fg=#61afef]{I}#[default]'
const CLICK_RANGE_START = '#[range=user|scout]'
const CLICK_RANGE_END = '#[norange]'
const DEFAULT_CLICK_STYLE = 'underscore'

// Reuse render logic so counts stay aligned with picker without mutating state.
const { getActiveSessions, waitCode } = require(path.join(__dirname, 'picker', 'render'))

function readJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (_) {}
  return fallback
}

function readTmuxOption(name) {
  try {
    return execSync(`tmux show-option -gqv ${name}`, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (_) {
    return ''
  }
}

function clickEnabled(value) {
  return !/^(off|0|false|no|disabled)$/i.test(String(value || '').trim())
}

function summarizeSessions(active) {
  const counts = {
    wait: 0,
    busy: 0,
    done: 0,
    idle: 0,
    approval: 0,
    question: 0,
    plan: 0,
    total: active.length
  }

  for (const s of active) {
    if (s.needsAttention) {
      counts.wait++
      const code = waitCode(s)
      if (code === 'APP') counts.approval++
      else if (code === 'ANS') counts.question++
      else if (code === 'PLAN') counts.plan++
    } else if (s.status === 'working') {
      counts.busy++
    } else if (s.status === 'completed') {
      counts.done++
    } else if (s.status === 'idle') {
      counts.idle++
    }
  }

  return counts
}

function cachedPaneSnapshot(status) {
  const panes = new Map()
  for (const session of Object.values(status && status.sessions ? status.sessions : {})) {
    if (!session || !session.tmuxPane || panes.has(session.tmuxPane)) continue
    panes.set(session.tmuxPane, {
      paneId: session.tmuxPane,
      currentCommand: '',
      paneDead: false,
      windowName: session.tmuxWindowName || ''
    })
  }
  return panes
}

function cachedStatusSnapshot(status) {
  const sessions = {}
  for (const [sessionId, session] of Object.entries(status && status.sessions ? status.sessions : {})) {
    sessions[sessionId] = Object.assign({}, session, { pid: null })
  }
  return Object.assign({}, status || {}, { sessions })
}

function applyFormat(fmt, counts) {
  return fmt
    .replace(/\{W\}/g, String(counts.wait))
    .replace(/\{B\}/g, String(counts.busy))
    .replace(/\{D\}/g, String(counts.done))
    .replace(/\{I\}/g, String(counts.idle))
    .replace(/\{A\}/g, String(counts.approval))
    .replace(/\{Q\}/g, String(counts.question))
    .replace(/\{P\}/g, String(counts.plan))
    .replace(/\{T\}/g, String(counts.total))
}

function applyClickStyle(output, style) {
  const normalized = String(style || DEFAULT_CLICK_STYLE).trim().toLowerCase()
  if (!normalized || /^(off|0|false|no|none|disabled)$/i.test(normalized)) return output
  return `#[${normalized}]${output.replace(/#\[default\]/g, `#[default]#[${normalized}]`)}#[default]`
}

function renderStatusBar(counts, fmt, clickOption, clickStyle) {
  if (counts.total === 0) return ''

  let output = ''
  if (fmt) {
    output = applyFormat(fmt, counts)
  } else {
    if (counts.wait + counts.busy + counts.done + counts.idle === 0) return ''
    output = applyFormat(BASE_FMT, counts)
    if (counts.idle > 0) {
      output += applyFormat(IDLE_FMT, counts)
    }
    output += ' '
  }

  if (output && clickEnabled(clickOption)) {
    return `${CLICK_RANGE_START}${applyClickStyle(output, clickStyle)}${CLICK_RANGE_END}`
  }
  return output
}

function main() {
  const status = readJson(STATUS_FILE, null)
  if (!status) process.exit(0)

  const cachedStatus = cachedStatusSnapshot(status)
  const active = getActiveSessions(cachedStatus, cachedPaneSnapshot(cachedStatus))
  const output = renderStatusBar(
    summarizeSessions(active),
    readTmuxOption('@scout-status-format'),
    readTmuxOption('@scout-status-click'),
    readTmuxOption('@scout-status-click-style')
  )
  if (output) process.stdout.write(output)
}

module.exports = {
  applyFormat,
  applyClickStyle,
  clickEnabled,
  renderStatusBar,
  summarizeSessions,
  cachedPaneSnapshot,
  cachedStatusSnapshot
}

if (require.main === module) main()
