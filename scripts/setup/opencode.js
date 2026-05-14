#!/usr/bin/env node
// tmux-scout OpenCode plugin management.

const fs = require('fs')
const path = require('path')
const os = require('os')

const PLUGIN_FILENAME = 'tmux-scout-opencode-plugin.js'
const PLUGIN_VERSION = 'v1'
const PLUGIN_MARKER = `// tmux-scout-opencode-plugin version: ${PLUGIN_VERSION}`
const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'generic.js')

function configDir() {
  return path.join(os.homedir(), '.config', 'opencode')
}

function pluginDir() {
  return path.join(configDir(), 'plugins')
}

function pluginPath() {
  return path.join(pluginDir(), PLUGIN_FILENAME)
}

function configCandidates() {
  return [path.join(configDir(), 'opencode.json'), path.join(configDir(), 'config.json')]
}

function pluginRef() {
  return `file://${pluginPath()}`
}

function expectedHookPathLine() {
  return `const HOOK_PATH = ${JSON.stringify(HOOK_PATH)};`
}

function readJson(filePath) {
  try {
    fs.statSync(filePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw new Error(`Failed to read ${filePath}: ${error.message}`)
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (error) {
    throw new Error(`Failed to read ${filePath}: ${error.message}`)
  }
}

function writeAtomic(filePath, content) {
  const tempPath = filePath + '.tmp.' + process.pid
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, content)
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch (_) {}
    throw error
  }
}

function writeJson(filePath, data) {
  writeAtomic(filePath, JSON.stringify(data, null, 2) + '\n')
}

function primaryConfigPath() {
  for (const candidate of configCandidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return configCandidates()[0]
}

function isScoutPluginRef(value) {
  return String(value || '').includes(PLUGIN_FILENAME)
}

function isManagedPluginRef(value) {
  return String(value || '') === pluginRef()
}

function buildPluginContent() {
  return `${PLUGIN_MARKER}
// OpenCode event bridge for tmux-scout. It spawns the generic tmux-scout hook
// so events still work when the optional watchdog bridge is disabled.
import { spawnSync } from "child_process";

const HOOK_PATH = ${JSON.stringify(HOOK_PATH)};
const NODE = process.env.TMUX_SCOUT_NODE || "node";
const ENV_KEYS = ["TMUX", "TMUX_PANE", "TERM_PROGRAM", "ITERM_SESSION_ID", "TERM_SESSION_ID", "KITTY_WINDOW_ID", "KITTY_LISTEN_ON"];

function runHook(payload) {
  try {
    spawnSync(NODE, [HOOK_PATH, "--agent", "opencode"], {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env }
    });
  } catch {}
}

function makePayload(hookEventName, sessionID, cwd, extra = {}) {
  return {
    hook_event_name: hookEventName,
    session_id: "opencode-" + sessionID,
    cwd: cwd || process.env.PWD || ".",
    ...extra
  };
}

export default async () => {
  const msgRoles = new Map();
  const assistantTextBySession = new Map();
  const userTextBySession = new Map();
  const sessionCwd = new Map();
  const sessionTitle = new Map();

  function textPart(store, messageID, partID, text) {
    let parts = store.get(messageID);
    if (!parts) {
      parts = new Map();
      store.set(messageID, parts);
    }
    if (text) parts.set(partID, text);
    else parts.delete(partID);
    return Array.from(parts.values()).map(v => String(v || "").trim()).filter(Boolean).join("\\n");
  }

  function toolName(raw) {
    const value = String(raw || "Tool");
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  return {
    "event": async ({ event }) => {
      try {
        const t = event.type;
        const p = event.properties || {};

        if (t === "session.created" && p.info) {
          const sid = p.info.id;
          const cwd = p.info.directory || "";
          sessionCwd.set(sid, cwd);
          const title = p.info.title || p.info.name || "";
          if (title) sessionTitle.set(sid, title);
          runHook(makePayload("SessionStart", sid, cwd, { session_title: title }));
          return;
        }

        if (t === "session.deleted" && p.info) {
          const sid = p.info.id;
          runHook(makePayload("SessionEnd", sid, sessionCwd.get(sid), {
            last_assistant_message: assistantTextBySession.get(sid),
            session_title: sessionTitle.get(sid)
          }));
          sessionCwd.delete(sid);
          assistantTextBySession.delete(sid);
          sessionTitle.delete(sid);
          return;
        }

        if (t === "session.status" && p.sessionID && p.status?.type === "idle") {
          runHook(makePayload("Stop", p.sessionID, sessionCwd.get(p.sessionID), {
            last_assistant_message: assistantTextBySession.get(p.sessionID),
            session_title: sessionTitle.get(p.sessionID)
          }));
          return;
        }

        if (t === "message.updated" && p.info?.id && p.info?.sessionID) {
          msgRoles.set(p.info.id, { role: p.info.role, sessionID: p.info.sessionID });
          return;
        }

        if (t === "message.part.updated" && p.part?.type === "text" && p.part?.messageID) {
          const meta = msgRoles.get(p.part.messageID);
          if (!meta) return;
          if (meta.role === "user") {
            if (p.part.synthetic === true || p.part.ignored === true) return;
            const prompt = textPart(userTextBySession, p.part.messageID, p.part.id || p.part.messageID, p.part.text || "");
            if (prompt) runHook(makePayload("UserPromptSubmit", meta.sessionID, sessionCwd.get(meta.sessionID), { prompt }));
            return;
          }
          if (meta.role === "assistant") {
            const text = textPart(assistantTextBySession, p.part.messageID, p.part.id || p.part.messageID, p.part.text || "");
            if (text) {
              assistantTextBySession.set(meta.sessionID, text);
              runHook(makePayload("AssistantMessageUpdate", meta.sessionID, sessionCwd.get(meta.sessionID), {
                assistant_message_preview: text,
                session_title: sessionTitle.get(meta.sessionID)
              }));
            }
            return;
          }
        }

        if (t === "message.part.updated" && p.part?.type === "tool" && p.part?.sessionID) {
          const st = p.part.state?.status;
          const sid = p.part.sessionID;
          const name = toolName(p.part.tool);
          if (st === "running" || st === "pending") {
            runHook(makePayload("PreToolUse", sid, sessionCwd.get(sid), {
              tool_name: name,
              tool_input: p.part.state?.input || {}
            }));
            return;
          }
          if (st === "completed" || st === "error") {
            runHook(makePayload("PostToolUse", sid, sessionCwd.get(sid), { tool_name: name }));
          }
          return;
        }

        if (t === "permission.asked" && p.id && p.sessionID) {
          const name = toolName(p.permission);
          const patterns = p.patterns || [];
          runHook(makePayload("PermissionRequest", p.sessionID, sessionCwd.get(p.sessionID), {
            tool_name: name,
            tool_input: { patterns, metadata: p.metadata, command: p.permission === "bash" ? patterns.join(" && ") : undefined },
            permission_description: patterns[0] || name
          }));
          return;
        }

        if (t === "permission.replied" && p.sessionID) {
          runHook(makePayload("PostToolUse", p.sessionID, sessionCwd.get(p.sessionID)));
          return;
        }

        if (t === "question.asked" && p.id && p.sessionID) {
          const questions = Array.isArray(p.questions) ? p.questions : [];
          runHook(makePayload("QuestionAsked", p.sessionID, sessionCwd.get(p.sessionID), {
            question_text: questions.map(q => q.question).filter(Boolean).join("; ") || "OpenCode has a question"
          }));
          return;
        }

        if ((t === "question.replied" || t === "question.rejected") && p.sessionID) {
          runHook(makePayload("PostToolUse", p.sessionID, sessionCwd.get(p.sessionID)));
        }
      } catch {}
    },
    "shell.env": async (_input, output) => {
      output.env.TMUX_SCOUT_ACTIVE = "1";
      for (const key of ENV_KEYS) {
        if (process.env[key]) output.env["TMUX_SCOUT_" + key] = process.env[key];
      }
    }
  };
};
`
}

function install() {
  const configPath = primaryConfigPath()
  const config = readJson(configPath) || {}
  const otherConfigs = new Map()
  for (const candidate of configCandidates()) {
    if (candidate === configPath) continue
    otherConfigs.set(candidate, readJson(candidate))
  }

  writeAtomic(pluginPath(), buildPluginContent())
  const plugins = Array.isArray(config.plugin) ? config.plugin.filter(ref => !isScoutPluginRef(ref)) : []
  plugins.push(pluginRef())
  config.plugin = plugins
  writeJson(configPath, config)

  for (const candidate of configCandidates()) {
    if (candidate === configPath) continue
    const other = otherConfigs.get(candidate)
    if (!other || !Array.isArray(other.plugin)) continue
    const filtered = other.plugin.filter(ref => !isScoutPluginRef(ref))
    if (filtered.length !== other.plugin.length) {
      if (filtered.length === 0) delete other.plugin
      else other.plugin = filtered
      writeJson(candidate, other)
    }
  }

  return { results: [{ event: 'plugin', action: 'installed' }], path: pluginPath() }
}

function uninstall() {
  let removed = false
  for (const candidate of configCandidates()) {
    const config = readJson(candidate)
    if (!config || !Array.isArray(config.plugin)) continue
    const filtered = config.plugin.filter(ref => !isScoutPluginRef(ref))
    if (filtered.length !== config.plugin.length) {
      removed = true
      if (filtered.length === 0) delete config.plugin
      else config.plugin = filtered
      writeJson(candidate, config)
    }
  }
  try { fs.unlinkSync(pluginPath()); removed = true } catch (_) {}
  return { results: [{ event: 'plugin', action: removed ? 'removed' : 'not_found' }] }
}

function status() {
  let referenced = false
  for (const candidate of configCandidates()) {
    const config = readJson(candidate)
    if (config && Array.isArray(config.plugin) && config.plugin.some(isManagedPluginRef)) {
      referenced = true
      break
    }
  }
  const pluginFile = pluginPath()
  const pluginExists = fs.existsSync(pluginFile)
  const pluginContent = pluginExists ? fs.readFileSync(pluginFile, 'utf-8') : ''
  const hasMarker = pluginExists && pluginContent.includes(PLUGIN_MARKER)
  const hasExpectedHookPath = pluginExists && pluginContent.includes(expectedHookPathLine())
  const hasPlugin = hasMarker && hasExpectedHookPath
  const installed = referenced && hasPlugin
  const missing = []
  if (!pluginExists || !hasMarker) missing.push('plugin file')
  if (hasMarker && !hasExpectedHookPath) missing.push('plugin hook path')
  if (!referenced) missing.push('managed config plugin ref')
  return { installed: installed ? 1 : 0, total: 1, missing, path: pluginPath() }
}

module.exports = { install, uninstall, status }

if (require.main === module) {
  const cmd = process.argv[2]
  const r = cmd === 'install' ? install() : cmd === 'uninstall' ? uninstall() : status()
  if (cmd === 'status' || !cmd) {
    console.log(`OpenCode: ${r.installed === r.total ? 'plugin installed' : 'plugin not installed'}`)
  } else {
    console.log(`OpenCode: ${r.skipped ? r.reason : 'ok'}`)
  }
}
