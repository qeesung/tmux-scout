# Session State Contract

tmux-scout persists plain JSON under `~/.tmux-scout/`. This document describes
the stable fields that producers and views should share. The executable source
of truth is `scripts/lib/session-contract.js`; update that module with any
contract change.

## Files

```
~/.tmux-scout/status.json
~/.tmux-scout/sessions/{session-id}.json
```

`status.json` is the aggregate index used by the picker, status bar, watchdog,
and debug commands. Per-session files mirror individual snapshots for easier
inspection and recovery.

The aggregate registry is maintained by `scripts/lib/session-registry.js`.
It supports explicit session deletion and periodic pruning of snapshots that no
longer need to be shown:

- hidden Codex/internal sessions after the short terminal display window
- `crashed` / `stale` terminal sessions after the same display window
- sessions with an explicit `endedAt` older than the 24-hour retention window
- old inactive snapshots when the registry exceeds its capacity cap

## Snapshot Shape

Every session snapshot should include:

| Field | Meaning |
|---|---|
| `sessionId` | Stable id for the agent session |
| `agentType` | Agent id from `scripts/lib/agents.js` |
| `phase` | Canonical lifecycle phase |
| `status` | Legacy status used by older views |
| `startedAt` / `lastUpdated` / `endedAt` | Millisecond timestamps |
| `workingDirectory` | Agent working directory when known |
| `sessionTitle` / `lastUserPrompt` | User-facing prompt/title |
| `tmuxPane` | Linked tmux pane id, such as `%12` |
| `pid` | Tracked foreground or agent process id |
| `pendingToolUse` | Current tool activity |
| `pendingInteraction` | Approval/question/plan wait detail |
| `stateEvidence` | Recent reducer evidence stream |

Views should tolerate missing optional fields. Hooks should not write view-only
fields such as picker colors or formatted text.

## Canonical Phases

| Phase | Legacy status | Meaning |
|---|---|---|
| `idle` | `idle` | Session exists but is not currently working |
| `running` | `working` | Agent is processing a prompt or tool |
| `waitingForApproval` | `working` | Agent is blocked on permission or plan confirmation |
| `waitingForAnswer` | `working` | Agent is blocked on user input |
| `completed` | `completed` | Latest turn completed |
| `interrupted` | `interrupted` | User or transcript reported interruption |
| `crashed` | `crashed` | Linked process or pane died unexpectedly |
| `stale` | `stale` | State is too old or the backing source disappeared |

`needsAttention` remains for compatibility, but new code should use
`pendingInteraction` and `phase` first.

## Pending Interaction

`pendingInteraction` is present only while the session is waiting for the user.

| Field | Meaning |
|---|---|
| `type` | `approval`, `question`, or `plan` |
| `phase` | `waitingForApproval` or `waitingForAnswer` |
| `reason` | Normalized short reason |
| `details` | User-visible prompt, tool, or command detail |
| `tool` | Tool name when known |
| `requestId` / `turnId` | Agent ids used to clear the wait correctly |
| `source` / `stateSource` / `rawEventName` | Debug evidence |
| `confidence` | Relative reducer confidence |

## AgentEvent Inputs

Hook adapters should call the reducer with `AgentEvent` objects. Important fields
are:

| Field | Meaning |
|---|---|
| `type` | Canonical event type from `scripts/lib/agent-events.js` |
| `timestamp` | Millisecond timestamp or parseable timestamp string |
| `source` / `stateSource` | Producer identity |
| `rawEventName` | Original agent event name |
| `phase` / `status` | Optional direct phase hint |
| `attentionReason` / `needsAttention` | Wait reason |
| `pendingToolUse` / `activeTool` | Tool activity |
| `turnId` / `requestId` / `toolCallId` / `toolUseId` | Correlation ids |
| `force` | Allow high-confidence overwrite when needed |

The reducer records accepted and rejected observations in `stateEvidence`.
Evidence entries include source, raw event name, phase, previous phase, timestamp,
details, and an optional blocked reason.

`session_delete` is the canonical delete event. It does not map to a phase;
the registry removes the aggregate entry and its per-session JSON file.

## Source Priority

tmux-scout accepts observations from hooks, transcript readers, pane/process
checks, watchdog reconciliation, and debug injection. The reducer favors
higher-confidence lifecycle sources during short races, while terminal states
from process/pane reconciliation can still close dead sessions.

Use the reducer instead of writing lifecycle fields by hand. It keeps
`phase`, `status`, `needsAttention`, `pendingInteraction`, `pendingToolUse`,
`stateSource`, `stateConfidence`, and `stateEvidence` consistent.

## Writer Model

When the watchdog is running, hooks send updates to the local bridge socket at
`~/.tmux-scout/run/bridge.sock`. The bridge acts as a single writer for status
files. If the bridge is unavailable, hooks fall back to direct atomic writes.

Readers should treat files as eventually consistent and re-read on each render.
Writers must not assume they are the only producer unless they are inside the
bridge server.

The watchdog reconciliation loop is a single coordinator pass, scoped to tmux:

1. reconcile tmux panes and tracked PIDs
2. scan known Codex/Claude transcripts for missed interruption signals
3. apply stale/stuck fallbacks
4. prune expired registry entries and remove their per-session files
5. let picker/status bar render the current `status.json` snapshot

## Validation

Use these commands while changing the contract:

```bash
npm run check
npm test
node scripts/debug.js show <session-id> --plain
node scripts/debug.js evidence <session-id>
node scripts/debug.js replay tests/fixtures/flow/<agent>/<fixture>.json --show
```

Flow fixtures validate final snapshots against `scripts/lib/session-contract.js`
and make reducer regressions easier to review.
