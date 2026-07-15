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
`docs/session-contract.md`. Protocol-specific payload mappings and transition
semantics are authoritative: do not add a cross-agent heuristic just because
two payloads happen to contain similar text.

Use these common mappings:

| Agent behavior | Canonical event | Expected phase |
|---|---|---|
| Confirmed agent session | `session_start` | `running` |
| User submits prompt | `prompt_submit` | `running` |
| Tool starts | `tool_use` | keeps WAIT sticky; otherwise establishes/keeps `running` |
| Tool finishes | `post_tool_use` / `post_tool_use_failure` | phase-neutral; clears tool residue |
| Adapter activity update | `assistant_message_update` / adapter-scoped `notification` | `running`, except WAIT remains sticky |
| Permission requested | `permission_request` | `waitingForApproval` |
| User answer requested | `question_asked` | `waitingForAnswer` |
| Plan confirmation requested | `permission_request` with plan reason/type | `waitingForApproval` |
| Agent finishes ordinary turn | `stop` / `turn_complete` | `completed`, unless WAIT is still unresolved |
| Agent session is torn down | `session_end` | `completed` after the adapter clears pending interaction |
| Agent session is deleted | `session_delete` | removed from the registry |
| User interrupts | `interrupted` | `interrupted` |
| Process or pane dies | `pane_state` / reconcile event | `crashed` or `stale` |

`session_start` does not mean IDLE. It enters `running`; tmux-scout keeps an
unconfirmed hook shell hidden until there is a real prompt or WAIT. Pane discovery
may retain an internal `idle` liveness placeholder, but that placeholder is never
rendered as an agent state.

The picker and status bar manage only sessions bound to a live `tmuxPane`.
Hooks from Codex App, an IDE, or a plain terminal may share the same lifecycle
semantics, but without a tmux pane they are not rendered or counted.

When the agent gives a stable request id, tool-call id, or turn id, pass it
through. Adapter-specific resolution rules use those ids to avoid clearing a
parallel, unrelated WAIT.

## Waiting Interactions

Waiting state is represented as `pendingInteraction` plus the legacy
`needsAttention` string. Integrations should fill as much detail as possible:

- `type`: `approval`, `question`, or `plan`
- `reason`: short normalized reason, such as `waiting for approval`
- `details`: user-visible prompt or tool detail
- `tool`: tool or command name when known
- `requestId` / `turnId`: stable ids when exposed by the agent
- `source` / `stateSource` / `rawEventName`: evidence for debugging

Codex `request_user_input` should be mapped as `question_asked` on `PreToolUse`
only when its structured input parses successfully, and as `question_answered`
on the matching `PostToolUse`. Codex Stop question parsing accepts only the
protocol's structured Chinese numbered-question shape; generic prose, punctuation, and payload flags
must not invent WAIT.

## Notifications

Notifications are adapter-specific protocol events, never a shared prose
classifier. Current protocol behavior includes:

- Claude `Notification`: acknowledged with no SessionState write.
- Gemini structured `notification_type: ToolPermission`: approval/question WAIT;
  other Gemini notifications are activity updates.
- Coco/Traex exact `notification_type: idle_prompt`: turn completion; other
  supported notifications are activity only.
- OpenCode and Copilot notifications that are not explicitly mapped: no-op.

Never infer permission, question, plan, idle, or completion from words in a
message. There is also no generic silence-to-DONE sweep: missing agent evidence
must not turn BUSY into DONE.

## Resolving a WAIT

A WAIT changes only when the corresponding adapter has explicit evidence that
the interaction ended. Permission resolution is phase-guarded;
`questionAnswered` is intentionally not phase-guarded. Resolution normally
returns to `running`, but an ended hook session finalizes as `completed`.
Examples include a matching question/tool completion, an adapter-defined
PostTool without a tool name, or a Stop/SessionEnd path that first calls
`clearStalePendingInteraction`.

Ordinary tool activity, subagent activity, pane contents, transcript mtime,
silence, and source priority never resolve WAIT. Ordinary turn completion while
WAIT is unresolved also does not plant a latent DONE. A real SessionEnd parks its
end bit until resolution; a later ordinary completion explicitly clears that bit,
matching explicit `isSessionEnd: false` semantics.

For parallel native approvals, preserve the adapter's identity rules. Kimi, for
example, tracks every high-risk `tool_call_id` and clears WAIT only after the last
matching call completes. OpenCode distinguishes a real tool completion (with
`tool_name`) from permission/question resolution (without `tool_name`).

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

## Contributor Checklist

1. Add metadata in `scripts/lib/agents.js`.
2. Add or update a setup manager and register it in `scripts/setup/managers.js`.
3. Add hook adapter logic that emits canonical events.
4. Add at least one flow fixture covering the highest-risk lifecycle.
5. Run `npm run check` and `npm test`.
6. Update README setup tables if the user-visible agent list changes.
