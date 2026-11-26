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

// v7: agy's working hint. A long turn hangs its plan's checklist under the
// status line, and a message queued during a turn sits there too with
// "Press up to edit queued messages" in the footer. Both push the status line
// out of the bottom lines the model treats as authoritative, and with the
// spinner normalized away it read a running turn as idle_ready at 0.70.
//
// v6: Antigravity CLI (agy) hints, written from live agy 1.5.17 panes. Its
// approval and question dialogs keep "esc to cancel" in the footer, the same
// words a running turn shows, so the hints name the status line above the
// composer as what tells working apart, and say that a dialog wins.
//
// Also v6, for every CLI: a cancelled turn and a completion menu are named as
// idle in awaiting_answer, idle_ready and blocked_on_user. Claude Code and agy
// both print "Interrupted · What should <agent> do instead?" over an empty
// composer, which the model read as a question with its answer box below:
// agy's cancelled turns were accepted as awaiting_answer at 0.74-0.89, and
// Claude's came back idle_ready at 0.39, below the bar, so neither left BUSY.
// A "/" menu under the composer, a numbered-looking list the person opened
// by typing, read as awaiting_answer the same way. shell_prompt now says an
// exited CLI's whole last frame may sit above the shell prompt: agy and Claude
// render inline and leave it there, composer included.
//
// v5: every CLI's hints fill the same five slots (see HINT_SLOTS). Codex
// gained what separates its working screen from its idle one — its composer
// keeps the placeholder while a turn runs — and every quoted example is now in
// the normalized form the model actually receives.
//
// v4: rewrote the Claude hints. They described a running turn by "esc to
// interrupt", which current Claude Code no longer prints, and a glyph the
// model never sees (normalization turns it into "*"); a finished turn's
// "Worked for … · done <time>" line was not described at all. Real screens
// scored 0.38-0.56 — a running Bash rejected outright, a finished turn whose
// last message asked a question accepted by 0.01 — and a rejected answer on a
// screen that stays put holds the session in its old phase. The second case is
// not Claude-specific: awaiting_answer now says the question must be drawn in
// place of the composer, which is also the line hooks draw — a turn that ends
// on a question in prose is a Stop, not a wait.
//
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

const PANE_QUESTION_SET_VERSION = 7
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
  traex: 'Traex CLI',
  agy: 'Antigravity CLI'
})

// Per-CLI rendering notes. Kept to a few lines and held in the state rather
// than forked into separate question sets, so there is one set to tune and one
// set to test; adding a CLI is a data change.
//
// Every agent TUI has the same five things worth describing, so each CLI fills
// the same slots and agentHints() renders them in one order. The slots are
// what separates the outcomes: a CLI whose running turn was not described
// scored 0.38 on a screen that was plainly working, because the generic
// criteria describe no particular CLI and the model had to guess. A slot
// nobody has seen on a real screen is left out, not guessed — an invented
// example sends the model looking for text that is never there. Not yet seen:
// traex while working, Gemini CLI while working or finished.
//
// Each slot is a complete sentence about its own subject, rendered without a
// label. Prefixing the slot name ("Composer: …") was measured and bought
// nothing; rewording the same facts cost Claude 0.05-0.10 of confidence on
// finished screens. Change the wording only with `npm run jev-eval` and live
// screens to compare against.
//
// Everything in double quotes is screen text AS THE MODEL RECEIVES IT, which is
// not what a person sees: pane-capture normalizes the screen first, so an
// animated glyph is "*", braille is gone, durations are "<dur>", token counts
// "<tok>", percentages "<pct>", box-drawing runs "───", and whitespace is
// collapsed. A test holds every quote to that. The Claude hints once quoted
// "✻ Thinking… (12s · esc to interrupt)": a glyph normalization removes, a
// duration it rewrites, and a phrase Claude Code no longer prints.
const HINT_SLOTS = Object.freeze([
  // What the input line looks like, and whether it stays up while a turn runs.
  'composer',
  // What only a running turn shows.
  'working',
  // What only a finished turn shows.
  'finished',
  // What the agent draws when it cannot go on without the person.
  'waiting',
  // What looks meaningful but reads the same in every state.
  'chrome'
])

// Claude's `finished` hint calls a turn that left "1 shell still running" over,
// and as a reading of the screen it is: the composer is up. That the session is
// still busy is decided in code, from the same line (see withBackgroundWork in
// pane-classifier.js), so no wording here has to carry it.
const AGENT_SCREENS = Object.freeze({
  claude: {
    composer:
      'Its composer is a single line starting with "❯", drawn between two long horizontal rules. It stays on ' +
      'screen, usually empty, for the whole of a running turn, so an empty composer on its own does not mean the ' +
      'agent is idle. A submitted instruction is echoed earlier in the transcript on a line that also starts with ' +
      '"❯".',
    working:
      'Just above the composer, a running turn shows a status line of "*", a verb ending in "…" and a live counter ' +
      'in parentheses, such as "* Perambulating… (<dur> · ↓ <tok>)" or "* Infusing… (<dur> · thinking with high ' +
      'effort)". While that line is there the agent is working. A shell command still running also shows ' +
      '"(ctrl+b ctrl+b (twice) to run in background)".',
    finished:
      'A finished turn replaces it with a past-tense line such as "* Worked for <dur> · done 6:16 PM" or "* Churned ' +
      'for <dur> · done 11:00 AM · 1 shell still running", often followed by a "※ recap:" summary. With that line ' +
      'above an empty composer the turn is over and the agent is idle, even when its last message ends by asking ' +
      'the person something: a question it cannot continue without is drawn as a boxed option list instead.',
    waiting: 'Approval dialogs are boxed and list numbered options beginning with "1. Yes".',
    chrome: 'The bottom status line reads like "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)".'
  },
  codex: {
    composer:
      'Its composer is a line starting with "»", showing the placeholder "Ask Codex to do anything" when empty. It ' +
      'stays on screen, placeholder included, while a turn runs, so on its own it does not mean the agent is idle. ' +
      'A submitted instruction is echoed in the transcript on a line starting with "›".',
    working:
      'A running turn shows a line such as "• Working (<dur> • esc to interrupt)" just above the composer, and ' +
      '"Working" among the fields of the bottom status line. Older versions print a "─ Working ───" separator ' +
      'instead, and the composer reads "» Esc to interrupt". Tool activity is printed as lines such as ' +
      '"Read config.yml" or "Search TODO".',
    finished:
      'A finished turn shows a line such as "Worked for <dur> · done 11:33 AM" or "─ Worked for <dur> ───" above ' +
      'the composer, and "Ready" among the fields of the bottom status line.',
    chrome:
      'Warnings starting with "⚠", such as an MCP server that failed to start, are startup noise rather than a ' +
      'question.'
  },
  gemini: {
    composer: 'Its composer is a box containing ">", with a footer showing the model name and the context left.',
    waiting:
      'Tool confirmations ask "Apply this change?" with the options "Yes, allow once", "Yes, allow always" and "No".'
  },
  traex: {
    composer:
      'Its composer is a line starting with "❯" between two "▄▄▄" banners, the upper one carrying the session ' +
      'title, such as "▄▄▄ Analyze issue ▄". Empty, it shows a placeholder such as "Implement {feature}".',
    finished: 'A finished turn prints a line such as "⏱ Worked for <dur> · done 2:42 PM" above the composer.',
    chrome:
      'The status line lists the model, the context left, the directory and the branch, such as "Test-O-New high · ' +
      'Context <pct> left · ~/repos/example · main · No changes".'
  },
  agy: {
    composer:
      'Its composer is a line starting with ">" between two horizontal rules. It stays on screen, empty, for the ' +
      'whole of a running turn, so on its own it does not mean the agent is idle; empty, it may show a mode hint ' +
      'such as "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)". A submitted instruction is ' +
      'echoed in the transcript on a line starting with ">" under a rule. Typing "/" in it opens a command menu ' +
      'ending in "tab Complete": the person is typing and the agent is idle.',
    working:
      'While a turn runs, a status line sits above the composer\'s upper rule: "Generating...", "Working...", ' +
      '"Loading...", "Running command... <dur>", or what the agent is doing cut short and followed by its time, ' +
      'such as "5/6 steps · Checking the config loader... <dur>". Under it there may be a "└ Tip:" line, the ' +
      'steps of its plan, from "⎿ ✓ Review the parser changes" to "* Run tests and static checks", or a message ' +
      'the person queued for later, ending "(alt+m to send immediately)", with "Press up to edit queued messages" ' +
      'in the footer. Those can push the status line out of the last lines; the turn is still running. A prompt ' +
      'echo with only that status line under it is a turn that has just started. With no such line the agent is ' +
      'not working, even though the footer also reads "esc to cancel" while a menu is open.',
    finished:
      'A finished turn leaves no status line: the composer is empty and the footer starts with "? for shortcuts". ' +
      '"* Ran (npm test)" and "▸ Thought for <dur>, <tok>" are history. After the person cancels a turn, a fixed ' +
      'notice starting "⎿ Interrupted ·" is printed above the empty composer; it is printed on every cancel, asks ' +
      'nothing, and the agent is idle. A background task under the composer, with "1 task(s) · /tasks" in the ' +
      'footer, does not make the agent busy.',
    waiting:
      'An approval replaces the composer with "Requesting permission for:", the command, "Run this command?" and ' +
      'options from "> 1. Yes, run command" to "4. No, cancel"; a question replaces it with "Question 1/1:" and ' +
      'numbered choices over "↑/↓ Navigate · enter Select · esc Skip". Either waits on the person although the ' +
      'footer still reads "esc to cancel". While the composer itself is on screen, nothing waits.',
    chrome:
      'The footer\'s right side names the model and effort, such as "Gemini Pro · high". A plan-mode turn ends ' +
      'like any other, with "1 artifact · /artifact to review" above the composer. "Resume with -c (or command ' +
      'below):" is printed only once agy has exited: the frame above it is left over, and the shell prompt under ' +
      'it is the bottom of the screen.'
  }
})

const GENERIC_SCREEN = Object.freeze({
  composer: 'Its composer is the input line at the very bottom, usually marked with ">", "›" or "❯".'
})

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
        'decision before it can continue. The question is drawn as a prompt of its own at the bottom — an option ' +
        'list to pick from, or an input labelled as the answer to it — in place of the agent\'s normal composer. An ' +
        'empty composer waiting for a brand new instruction is NOT this: choose idle_ready for that. Neither is a ' +
        'question at the end of the agent\'s last message with its normal composer below: that turn is over, so ' +
        'choose idle_ready. Nor is a notice that the person cancelled the turn, such as "Interrupted · What should ' +
        'Claude do instead?", above the normal composer, nor a menu the composer opened to complete what the person ' +
        'is typing: choose idle_ready for both.',
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
        'outcome, because the agent is idle either way, and so is a menu of commands or files the composer opened ' +
        'to complete it. A turn the person cancelled ends here too, often with a notice such as "Interrupted · What ' +
        'should Claude do instead?" above the composer. A status line may read "Ready", "done", "Worked for ' +
        '<duration>", or offer to clear the conversation. The previous answer above it is complete, and may end by ' +
        'asking the person something. There is no question prompt drawn in place of the composer, no option list ' +
        'and no running indicator.',
      shell_prompt:
        'The AI agent is not running at all. The bottom of the screen is an ordinary operating-system shell prompt: ' +
        'a line ending in "$", "%" or "#", or showing a username, hostname, directory path or git branch, with ' +
        'nothing after it but a cursor. Any agent output above it is left over from a process that already exited, ' +
        'even when it is the agent\'s whole last frame — its composer, a finished turn or a cancelled one — ' +
        'with the shell prompt under it.',
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
        'empty or holds a half-written instruction the person has not sent, with or without a completion menu ' +
        'under it, and whether or not a cancellation notice such as "Interrupted · What should Claude do instead?" ' +
        'sits above it: the agent is available, not blocked on an answer. Only a prompt the AGENT put on screen ' +
        'counts as true.'
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
  const screen = AGENT_SCREENS[agentType] || GENERIC_SCREEN
  return HINT_SLOTS.filter(slot => screen[slot]).map(slot => screen[slot])
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
  AGENT_SCREENS,
  HINT_SLOTS,
  PANE_QUESTION_SET_VERSION,
  agentHints,
  buildPaneState,
  paneQuestions
}
