// The question set a System One model answers about a pane.
//
// This file is the product. Everything else in the pane pipeline is plumbing
// that can be verified offline; accuracy lives or dies on the wording below, so
// treat every edit as a behaviour change and re-run `npm run jev-eval`.
//
// Four properties of the model shape these questions:
//
//   * It answers the question as written and does not infer intent, so every
//     boundary case has to be stated outright — including in each question that
//     touches it, since questions are evaluated independently of one another.
//   * Every question in one request is evaluated in parallel against a state
//     that is ingested once — but each question's criteria text is still billed.
//     Measured on the fixtures, the question set is ~2000 of the ~2300 input
//     tokens in a call and the screen is ~280, so a question costs roughly seven
//     times what the thing it is asking about costs. Cross-checks are cheap, not
//     free: carry one only if a decision reads it.
//   * Accuracy drops when the state carries detail the question does not need,
//     which is why only the tail of the screen is sent and the bottom few lines
//     are repeated where every question's evidence actually lives.
//   * Reasoning that needs several hops costs accuracy, so plan approval is its
//     own outcome rather than something derived from "approval" plus a second
//     question.
//
// Bumping PANE_QUESTION_SET_VERSION invalidates every cached answer. Do it for
// any wording change. Note also that choice confidence is
// (n * maxProbability - 1) / (n - 1): adding or removing an outcome shifts the
// scale, so thresholds must be re-tuned when the outcome list changes.

// v3: dropped `has_numbered_options` and `agent_exited`. Neither was read by any
// decision — they only reached the shadow log — and each duplicated something
// already being asked: `agent_exited` is the `shell_prompt` outcome of
// screen_state asked a second time, and a numbered option list is already
// described in the `awaiting_*` criteria and covered by `blocked_on_user`.
// Removing them is -13% input tokens on every uncached call, and because both
// were noul rather than choice, no confidence scale moved and no threshold
// needed retuning.
//
// v2: the outcome set had no home for a composer holding a half-written
// instruction, so the model split between idle_ready and awaiting_answer at
// ~0.45 confidence on exactly that screen. Folded it into idle_ready rather
// than adding an outcome, since a draft and an empty composer mean the same
// thing to a session state machine — and adding an outcome would have shifted
// the confidence scale for every other answer.
const { lastLines } = require('./pane-capture')

const PANE_QUESTION_SET_VERSION = 3
const BOTTOM_LINES = 8

const AGENT_LABELS = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  cursor: 'Cursor Agent',
  copilot: 'GitHub Copilot CLI',
  'copilot-cli': 'GitHub Copilot CLI',
  opencode: 'OpenCode',
  kimi: 'Kimi CLI',
  hermes: 'Hermes',
  trae: 'Trae CLI',
  coco: 'Trae CLI',
  traex: 'Traex CLI'
})

// Per-CLI rendering notes. Kept to a few lines and held in the state rather
// than forked into separate question sets, so there is one set to tune and one
// set to test; adding a CLI is a data change.
const AGENT_HINTS = Object.freeze({
  claude: [
    'Its composer is a single line starting with "❯", drawn between two long horizontal rules.',
    'A submitted instruction is echoed earlier in the transcript on a line that also starts with "❯".',
    'A running turn shows a line such as "✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)"; the leading glyph animates.',
    'Approval dialogs are boxed and list numbered options beginning with "1. Yes".',
    'The bottom status line reads like "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)".'
  ],
  codex: [
    'Its composer line starts with "»" and shows the grey placeholder "Ask Codex to do anything" when empty.',
    'The bottom status line contains " · Ready · " when the agent is idle and waiting for a new instruction.',
    'A finished turn prints a separator like "─ Worked for 3m 37s ─".',
    'Tool activity is printed as indented lines such as "    Read config.yml" or "    Search TODO".'
  ],
  gemini: [
    'Its composer is a box containing "> " with a footer showing the model name and remaining context percentage.',
    'Tool confirmations ask "Apply this change?" with options "Yes, allow once / Yes, allow always / No".'
  ],
  traex: [
    'Its composer shows a grey placeholder such as "Implement {feature}" when empty.',
    'A finished turn prints "⏱ Worked for 7m 40s · done 2:42 PM".'
  ]
})

const DEFAULT_HINTS = Object.freeze([
  'Its composer is the input line at the very bottom, usually marked with ">", "›" or "❯".'
])

const PANE_QUESTIONS = Object.freeze({
  screen_state: {
    type: 'choice',
    instructions:
      'This is a plain-text snapshot of a terminal pane running an interactive AI coding agent. Decide what the ' +
      'BOTTOM of the screen shows right now. The bottom is authoritative: everything above it is older transcript ' +
      'and must not decide the answer. Judge only what is literally visible; do not infer what the agent intends.',
    criteria: {
      awaiting_approval:
        'A prompt is asking the person to allow or deny one specific action the agent has already proposed: running ' +
        'a shell command, editing or creating a file, fetching a URL, or calling a tool. Typical shapes: a boxed ' +
        'dialog showing the command text or file path followed by numbered options such as "1. Yes", "2. Yes, and ' +
        'don\'t ask again", "3. No, and tell Claude what to do differently"; or a line such as "Do you want to ' +
        'proceed?", "Allow command?", "[y/n]". The agent has stopped and the next keystroke decides whether that one ' +
        'action runs.',
      awaiting_plan_approval:
        'A prompt is asking the person to approve a written multi-step PLAN before implementation starts, rather ' +
        'than one concrete action. Typical shapes: plan steps or a plan summary under a header such as "Claude has ' +
        'written up a plan and is ready to execute. Would you like to proceed?" or "Ready to code?", followed by ' +
        'options such as "Yes, and switch to BYPASS PERMISSIONS", "Yes, manually approve edits", "Tell Claude what ' +
        'to change". Choose this instead of awaiting_approval whenever what is being approved is a plan rather than ' +
        'a single command or file edit.',
      awaiting_answer:
        'The agent has stopped and is asking the person an open question, or offering a choice about WHAT it should ' +
        'do, rather than asking permission to run something it already decided on. It needs information or a ' +
        'decision before it can continue. An empty composer waiting for a brand new instruction is NOT this: choose ' +
        'idle_ready for that.',
      working:
        'The agent is producing output or executing something right now. Typical shapes: an animated spinner; a ' +
        'live elapsed-time or token counter; words such as "Thinking", "Working", "Running", "Compacting"; a hint ' +
        'that the person may press Esc to interrupt; a tool invocation whose result has not printed yet; assistant ' +
        'text that stops mid-sentence; command output still scrolling. Nothing on screen is waiting on the person.',
      idle_ready:
        'The agent is still running and has FINISHED its last turn. The bottom of the screen is the agent\'s own ' +
        'composer, and the agent is doing nothing while it waits for the person to send a new instruction. The ' +
        'composer may be empty, may show only a greyed-out placeholder hint, OR may contain text the person is ' +
        'still typing and has not sent yet — a half-written instruction sitting in the composer is still this ' +
        'outcome, because the agent is idle either way. A status line may read "Ready", "done", "Worked for ' +
        '<duration>", or offer to clear the conversation. The previous answer above it is complete. There is no ' +
        'question from the agent, no option list and no running indicator.',
      shell_prompt:
        'The AI agent is not running at all. The bottom of the screen is an ordinary operating-system shell prompt: ' +
        'a line ending in "$", "%" or "#", or showing a username, hostname, directory path or git branch, with ' +
        'nothing after it but a cursor. Any agent output above it is left over from a process that already exited.',
      unknown:
        'The snapshot is empty, unreadable, captured mid-redraw, shows an unrelated program such as a text editor, ' +
        'a pager, htop or a log tail, or matches no other outcome well enough to decide.'
    }
  },

  blocked_on_user: {
    type: 'noul',
    instructions:
      'Looking only at the bottom of the snapshot: is the agent unable to make any further progress until the ' +
      'person at the keyboard types or selects something?',
    criteria: {
      true:
        'The bottom shows a question, a permission dialog, a selectable option list, or any other prompt whose ' +
        'answer the agent needs before it can continue. It has stopped and is waiting on the person.',
      false:
        'The bottom shows work in progress, streaming output, a spinner or interrupt hint, an ordinary shell ' +
        'prompt, or the agent\'s own composer after a finished turn. A composer counts as false whether it is ' +
        'empty or holds a half-written instruction the person has not sent: the agent is available, not blocked ' +
        'on an answer. Only a prompt the AGENT put on screen counts as true.'
    }
  },

  is_running: {
    type: 'noul',
    instructions: 'Is there a visible sign that the agent is busy at this very moment?',
    criteria: {
      true:
        'A spinner, an elapsed-time counter that is still counting, a token counter, a progress bar, an explicit ' +
        'hint that the person may press Esc to interrupt, or a tool invocation with no finished result under it.',
      false:
        'Every visible tool invocation already shows its result, or the agent is waiting on the person, or the ' +
        'bottom is an empty composer or a shell prompt.'
    }
  },

  interrupt_marker_visible: {
    type: 'noul',
    instructions:
      'Does the snapshot show that the most recent turn was cancelled by the person rather than finishing on its own?',
    criteria: {
      true:
        'Text below the last assistant output says the request was interrupted, stopped, cancelled or aborted by ' +
        'the user — for example "[Request interrupted by user]", "Interrupted", "Aborted", "^C".',
      false:
        'No such text appears below the last assistant output, or it is older history with completed work beneath it.'
    }
  },

  active_tool: {
    type: 'choice',
    instructions:
      'Which kind of tool is the agent running, or asking permission to run, right now? Judge from the tool name or ' +
      'the action described nearest the bottom of the snapshot.',
    criteria: {
      shell: 'A shell or terminal command. Names such as Bash, Shell, Terminal, Run, exec, or a visible command line such as "npm test" or "git status".',
      file_edit: 'Changing an existing file. Names such as Edit, MultiEdit, StrReplace, Update, Patch, ApplyPatch, or a visible diff with + and - lines.',
      file_write: 'Creating or overwriting a whole file. Names such as Write, Create, NewFile.',
      file_read: 'Reading a file or listing a directory. Names such as Read, View, Cat, LS, Glob.',
      search: 'Searching code or text. Names such as Grep, Search, Find, Ripgrep.',
      web: 'Fetching a URL or searching the web. Names such as WebFetch, WebSearch, Browse, Curl.',
      task: 'Delegating to a sub-agent or background task. Names such as Task, Agent, Subagent, Dispatch, Explore.',
      todo: 'Updating a plan or task list. Names such as TodoWrite, UpdatePlan, ExitPlanMode.',
      mcp: 'Calling an MCP or external integration tool; the name contains "mcp" or is namespaced with a double underscore or a slash.',
      other_tool: 'A tool is clearly named or described but fits none of the categories above.',
      none:
        'No tool is running and none is being proposed right now. Choose this whenever the agent has finished its ' +
        'turn and is sitting at its composer, even if completed tool calls are visible earlier in the transcript: ' +
        'the question is about current activity, not about history.'
    }
  }
})

function agentLabel(agentType) {
  return AGENT_LABELS[agentType] || `${agentType || 'unknown'} CLI`
}

function agentHints(agentType) {
  return AGENT_HINTS[agentType] || DEFAULT_HINTS
}

// State is a JSON object rather than one blob so the rendering notes cannot be
// mistaken for something actually on the screen, and `bottom` repeats the few
// lines every question is really about instead of making the model locate them.
// Deliberately absent: pid, timestamps, session id, working directory and the
// current phase — none of them are visible on the screen, and the previous
// phase in particular would invite the model to reason about history when the
// hysteresis it would be guessing at is already handled in code.
function buildPaneState(capture, agentType) {
  const screen = (capture && capture.text) || ''
  return {
    agent: agentLabel(agentType),
    agentHints: agentHints(agentType),
    screen,
    bottom: lastLines(screen, BOTTOM_LINES)
  }
}

function paneQuestions() {
  return PANE_QUESTIONS
}

module.exports = {
  PANE_QUESTION_SET_VERSION,
  buildPaneState,
  paneQuestions
}
