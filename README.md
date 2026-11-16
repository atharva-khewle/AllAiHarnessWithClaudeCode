# AllAiHarnessWithClaudeCode

Gives the DeepSeek web chat hands in a project folder: it can read, search, write, edit and run commands there, and hand larger jobs to Claude Code. You only talk to DeepSeek in the browser.

## Use

1. Copy this folder into the project folder you want to work on.
2. Double-click `start.bat` (or run `node server.js`). Keep the window open.
3. It asks which model Claude Code should use (haiku, sonnet or opus; Enter keeps haiku), then whether to continue an old chat. Paste the chat's link and press Enter, or just press Enter for a new chat.
4. Two windows open: a Chrome window on DeepSeek and a "Claude Code - <workspace>" window with Claude Code ready in it. The first time, log in there. The server sends the setup message; DeepSeek answers "Ready." An old chat that this copy already set up continues without a new setup message.
5. Chat with DeepSeek. Everything else happens by itself. The Chrome window may be covered or minimized while it works.

## The three windows

- **Server window** (the one `start.bat` opened): every action DeepSeek takes. Commands it runs itself (`run`) are printed in full, with their output line by line as it comes, then `ok` or the error and the time taken. Most work happens here: DeepSeek does small steps itself and does not use Claude Code for them.
- **Claude Code window**: the real Claude Code screen. Idle until DeepSeek hands it a job with the `claude` action; each job starts a fresh Claude Code there. You see its every step and can type into it.
- **Chrome window**: the chat. A tag in the bottom right corner names the workspace; a bar at the top shows Claude Code jobs and problems.

## Several sessions at once

Put a copy of this folder in each project and run each `start.bat`. Each server gets its own Chrome window, its own chat and its own Claude Code window, all named after its workspace. A server only ever touches the chat it opened, and only runs agent blocks of chats set up for its own workspace, so sessions never run each other's work. Closing a server closes its Claude Code window. All share one Chrome and one DeepSeek login.

The workspace is the folder this folder sits in. Needs Node.js 22 or newer and Chrome; nothing to install.

Options: `--chat <link>` or `--new` to skip the chat question, `--model <name>` to skip the model question, `--workspace <dir>` to point at another folder, `--manual` to have messages wait in the message box until you press Enter.

## Claude Code

There is nothing to set up or connect. When DeepSeek uses the `claude` action, the server starts Claude Code by itself in the workspace, waits for it to finish and sends its report to DeepSeek.

Each job runs the real Claude Code screen in the server's Claude Code window, so you see every step, error and permission question, and can type into it. The task is in `jobs/<id>/task.md`; Claude Code writes its report to `jobs/<id>/report.md`, and the server sends that to DeepSeek. Hooks and the status line in that window (`lib/claude-hook.js`) tell the server each step, each time Claude Code waits for you, and the cost, so the server window prints every step and the chat page bar turns orange when Claude Code needs you. An API error such as a usage limit, or a turn that ends without a report, is passed to DeepSeek at once. The job stays on screen until the next one. Closing the window (or Claude Code in it) before the report stops the job, and DeepSeek is told; the next job opens the window again. The time limit is `claude.timeoutSec`. While the job runs, a blue bar on the chat page shows how long it has been running. With `"window": false` under `claude` in `config.json` (and on macOS or Linux) it runs headless instead and prints its steps in the server window.

## When the chat misbehaves

- Rate-limit notice, or no sign of an answer for 120 s: the same message is sent again after 45 s, up to 5 times. Then a red bar appears on the chat page.
- An answer cut off as too long: the server clicks the page's Continue button.
- Many files: `{"tool": "read", "paths": [...]}` returns up to 30 whole files as text. A message over `maxMessageChars` goes out in parts, each sent after the brain answered "ok" to the one before.
- Claude Code problems (error, timeout, login or usage limit, denied permission) print `CLAUDE CODE PROBLEM` in the server window, show as a red bar on the chat page, and are passed to the brain, which tells you. A blue bar shows while Claude Code works; each Claude result ends with its run time and cost.

## How it works

- DeepSeek's reply is text for you, then `---`, then content blocks with code, then a JSON agent block.
- The server watches the page, runs the agent block and sends the results back as the next message. This repeats until DeepSeek replies without an agent block.
- A new chat in that window gets a new setup message.
- The Chrome profile is in `~/.allaiharness/`, shared by every copy of this folder, so you log in once. Several copies can run at the same time; each uses its own window.
- If the tab is closed, the server opens the same chat again.

## Actions

| Tool | Runs in | Claude tokens |
| --- | --- | --- |
| `list`, `read`, `search` | the server | none |
| `write`, `edit` | the server | none |
| `run` | the server, in a shell in the workspace | none |
| `claude` | Claude Code, in its own window | per call |

DeepSeek is told to do the work itself and to use `claude` only for jobs that need many steps. A Claude Code call runs with a short system prompt, six tools and no plugins or MCP servers, which keeps its fixed cost low.

## Safety limits

- Paths outside the workspace, this folder, `.env*`, key files, `.git/` and `.ssh/` are refused. Files ignored by `.gitignore` are not listed or searched.
- `run` refuses commands that match `run.block` in `config.json`: `git push`, disk and registry tools, recursive deletes aimed outside the workspace, download-and-run pipes, anything naming `.env`.
- Everything else DeepSeek asks for runs without review, with your user rights. Everything it reads and every command output is sent to DeepSeek.

## Files

- `config.json`: chat URL and selectors, page texts for rate limit and Continue, retry timings, limits, `run.block`, Claude Code flags.
- `prompts/bootstrap.md`: the setup message. `prompts/executor.md`: the Claude Code system prompt.
- `log.md`: every agent block and its results. `.state.json`: which blocks already ran, so none runs twice.
