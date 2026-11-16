# AllAiHarnessWithClaudeCode

Gives the DeepSeek web chat hands in a project folder: it can read, search, write, edit and run commands there, and hand larger jobs to Claude Code. You only talk to DeepSeek in the browser.

## Use

1. Copy this folder into the project folder you want to work on.
2. Double-click `start.bat` (or run `node server.js`). Keep the window open.
3. It asks which model Claude Code should use (haiku, sonnet or opus; Enter keeps haiku), then whether to continue an old chat. Paste the chat's link and press Enter, or just press Enter for a new chat.
4. A Chrome window opens on DeepSeek. The first time, log in there. The server sends the setup message; DeepSeek answers "Ready." An old chat that this copy already set up continues without a new setup message.
5. Chat with DeepSeek. Everything else happens by itself. The Chrome window may be covered or minimized while it works.

The workspace is the folder this folder sits in. Needs Node.js 22 or newer and Chrome; nothing to install.

Options: `--chat <link>` or `--new` to skip the chat question, `--model <name>` to skip the model question, `--workspace <dir>` to point at another folder, `--manual` to have messages wait in the message box until you press Enter.

## Claude Code

There is nothing to set up or connect. When DeepSeek uses the `claude` action, the server starts Claude Code by itself (`claude -p` in the workspace), waits for it to finish and sends its report to DeepSeek.

Each job opens its own window titled `Claude Code (<model>) RUNNING`. The window shows the task and every step and error as it happens, with the time. It prints a line each minute while nothing new happens. At the end the title changes to DONE or FAILED. A finished window closes after `claude.keepOpenSec` seconds; a failed one stays open for an hour. Closing the window stops the job, and DeepSeek is told. The time limit is `claude.timeoutSec`. While the job runs, a blue bar on the chat page shows the time, the step count and the current step. It uses the Claude Code that is installed and logged in on this machine; the server prints at start whether it found it. Without Claude Code everything else still works.

## When the chat misbehaves

- Rate-limit notice, or no sign of an answer for 120 s: the same message is sent again after 45 s, up to 5 times. Then a red bar appears on the chat page.
- An answer cut off as too long: the server clicks the page's Continue button.
- Many files: `{"tool": "read", "paths": [...]}` returns up to 30 whole files as text. A message over `maxMessageChars` goes out in parts, each sent after the brain answered "ok" to the one before.
- Claude Code problems (error, timeout, login or usage limit, denied permission) print `CLAUDE CODE PROBLEM` in the server window, show as a red bar on the chat page, and are passed to the brain, which tells you. A blue bar shows while Claude Code works; each Claude result ends with its run time and cost.

## How it works

- DeepSeek's reply is text for you, then `---`, then content blocks with code, then a JSON agent block.
- The server watches the page, runs the agent block and sends the results back as the next message. This repeats until DeepSeek replies without an agent block.
- A new chat in that tab gets a new setup message.
- The Chrome profile is in `~/.allaiharness/`, shared by every copy of this folder, so you log in once. Several copies can run at the same time; each uses its own tab.
- If the tab is closed, the server opens the same chat again.

## Actions

| Tool | Runs in | Claude tokens |
| --- | --- | --- |
| `list`, `read`, `search` | the server | none |
| `write`, `edit` | the server | none |
| `run` | the server, in a shell in the workspace | none |
| `claude` | Claude Code (Haiku), headless | per call |

DeepSeek is told to do the work itself and to use `claude` only for jobs that need many steps. A Claude Code call runs with a short system prompt, six tools and no plugins or MCP servers, which keeps its fixed cost low.

## Safety limits

- Paths outside the workspace, this folder, `.env*`, key files, `.git/` and `.ssh/` are refused. Files ignored by `.gitignore` are not listed or searched.
- `run` refuses commands that match `run.block` in `config.json`: `git push`, disk and registry tools, recursive deletes aimed outside the workspace, download-and-run pipes, anything naming `.env`.
- Everything else DeepSeek asks for runs without review, with your user rights. Everything it reads and every command output is sent to DeepSeek.

## Files

- `config.json`: chat URL and selectors, page texts for rate limit and Continue, retry timings, limits, `run.block`, Claude Code flags.
- `prompts/bootstrap.md`: the setup message. `prompts/executor.md`: the Claude Code system prompt.
- `log.md`: every agent block and its results. `.state.json`: which blocks already ran, so none runs twice.
