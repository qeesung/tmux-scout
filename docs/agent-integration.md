# Agent Integration Guide

This guide describes how tmux-scout adds and maintains support for agent CLIs.
It is meant for contributors adding a new agent or tightening an existing one.

## Integration Planes

An agent integration usually touches four layers:

1. Agent metadata in `scripts/lib/agents.js`

   Add the stable agent id, picker label, color, process-name hints, setup flag,
   and config paths. Keep the id lowercase and stable because it is persisted in
   session state.

2. Installer manager in `scripts/setup/<agent>.js`

   Implement `install`, `uninstall`, `status`, and optional `doctor` checks.
   Register the manager in `scripts/setup/managers.js`. Installers must be
   idempotent and preserve unrelated user config.

3. Hook runtime in `scripts/hooks/*.js`

   Convert the agent payload into canonical `AgentEvent` objects, then let
   `scripts/lib/session-state.js` reduce those events into session snapshots.
   Prefer the shared helpers in `scripts/lib/hook-adapter.js` and
   `scripts/lib/agent-events.js` over writing directly to status files.

4. Fixtures and tests

   Capture representative flows under `tests/fixtures/flow/<agent>/`, especially
   prompt submit, tool start/stop, approval wait, answer wait, plan confirmation,
   completion, interruption, and crash/stale behavior. Add focused assertions to
   `tests/run.js` when the payload mapping has edge cases.

## Event Mapping

Hook adapters should emit canonical event types from `scripts/lib/agent-events.js`.
The reducer maps these into the session contract documented in
`docs/session-contract.md`.

Use these common mappings:

| Agent behavior | Canonical event | Expected phase |
|---|---|---|
| New agent session | `session_start` | `idle` |
| User submits prompt | `prompt_submit` | `running` |
| Tool starts | `tool_use` | `running` |
| Tool finishes | `post_tool_use` / `post_tool_use_failure` | `running` unless it resolves a deferred completion |
| Permission requested | `permission_request` | `waitingForApproval` |
| User answer requested | `question_asked` | `waitingForAnswer` |
| Plan confirmation requested | `permission_request` with plan reason/type | `waitingForApproval` |
| Agent finishes turn | `stop` / `turn_complete` / `session_end` | `completed` |
| User interrupts | `interrupted` | `interrupted` |
| Process or pane dies | `pane_state` / reconcile event | `crashed` or `stale` |

When the agent gives a stable request id or turn id, pass it through. It lets the
reducer clear the right pending interaction when the next lifecycle event arrives.

## Waiting Interactions

Waiting state is represented as `pendingInteraction` plus the legacy
`needsAttention` string. Integrations should fill as much detail as possible:

- `type`: `approval`, `question`, or `plan`
- `reason`: short normalized reason, such as `waiting for approval`
- `details`: user-visible prompt or tool detail
- `tool`: tool or command name when known
- `requestId` / `turnId`: stable ids when exposed by the agent
- `source` / `stateSource` / `rawEventName`: evidence for debugging

## Installer Rules

- Preserve user-owned config and comments whenever the target format allows it.
- Mark managed blocks or commands clearly so uninstall can remove only
  tmux-scout-owned content.
- Re-running install must update stale paths without duplicating hooks.
- `status` should distinguish installed, missing, stale, and partially installed
  states when possible.
- `doctor` should report missing binaries, parse failures, unsupported config
  versions, and permission problems without mutating user config.

## Current Built-ins

tmux-scout currently ships first-class metadata, setup manager registration, and
hook/runtime mapping for:

Claude Code, Codex, Gemini CLI, Kimi CLI, GitHub Copilot CLI, OpenCode,
Cursor Agent, Hermes, Trae CLI, and Traex CLI.

Trae CN is not a separate built-in id or setup flag yet. Treat it as covered
only when it uses the same local config shape and hook payloads as the Trae or
Traex integrations; otherwise add it as a new integration with its own tests.

## Contributor Checklist

1. Add metadata in `scripts/lib/agents.js`.
2. Add or update a setup manager and register it in `scripts/setup/managers.js`.
3. Add hook adapter logic that emits canonical events.
4. Add at least one flow fixture covering the highest-risk lifecycle.
5. Run `npm run check` and `npm test`.
6. Update README setup tables if the user-visible agent list changes.
