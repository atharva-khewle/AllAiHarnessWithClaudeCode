#!/usr/bin/env node
'use strict';
// Server: watches the chat page, runs the agent blocks in the brain's replies, and sends the
// results back. The workspace is the folder this harness folder was put in.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const { createTools } = require('./lib/tools');
const { createChat } = require('./lib/chat');
const { runClaude, openClaudeWindow } = require('./lib/claude');
const { REQUEST_MARKER, render, findBlocks, fillContents, formatResults, splitText } = require('./lib/protocol');

const USAGE = 'usage: node server.js [--chat <link> | --new] [--model <name>] [--workspace <dir>] [--manual] [--config <file>]';
const STATE_FILE = path.join(__dirname, '.state.json');
const LOG_FILE = path.join(__dirname, 'log.md');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toLocaleTimeString()}] ${text}`);

function parseArgs(argv) {
  const opts = { workspace: path.resolve(__dirname, '..'), config: path.join(__dirname, 'config.json'), manual: false, chat: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') opts.workspace = argv[++i];
    else if (argv[i] === '--model') opts.model = argv[++i];
    else if (argv[i] === '--config') opts.config = argv[++i];
    else if (argv[i] === '--manual') opts.manual = true;
    else if (argv[i] === '--chat') opts.chat = argv[++i];
    else if (argv[i] === '--new') opts.chat = '';
    else { console.error(USAGE); process.exit(1); }
  }
  return opts;
}

// Asks a question on the terminal. Enter, or no terminal to ask on, gives an empty answer.
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.on('close', () => { if (!answered) { console.log(); resolve(''); } });
  });
}

function claudeVersion(cmd) {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

// One entry per chat, by the key given in its setup text: its workspace and the blocks that
// already ran. Kept on disk so a restarted server never reruns a block.
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { chats: {} }; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  const tools = createTools(path.resolve(opts.workspace), { deny: cfg.deny, exclude: [__dirname], run: cfg.run });
  // The workspace name is on every window of this server: this one, the chat page and the Claude
  // Code window. With several servers running, it shows which windows belong together.
  const name = path.basename(tools.root);
  process.title = `AllAiHarness - ${name}`;

  // The Commands window (lib/command-window.js): read only, it shows every command the brain runs
  // and its output while it runs. Without it (not on Windows), the output goes to this window.
  let commandsFile = null;
  if (process.platform === 'win32') {
    commandsFile = path.join(__dirname, 'jobs', `commands-${process.pid}.log`);
    fs.mkdirSync(path.dirname(commandsFile), { recursive: true });
    fs.writeFileSync(commandsFile, `\x1b[36m=== AllAiHarness | ${name} | commands the brain runs, with their output as it comes. Read only. ===\x1b[0m\n`);
    const title = `Commands - ${name.replace(/[^\w .-]/g, '_')}`;
    spawn('cmd.exe', ['/d', '/s', '/c', `"start "${title}" "${process.execPath}" "${path.join(__dirname, 'lib', 'command-window.js')}" "${commandsFile}" ${process.pid}"`], {
      stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
    }).on('error', () => {});
  }
  const commandOut = (text) => {
    if (!commandsFile) return process.stdout.write(`\x1b[90m${text.replace(/^(?=.)/gm, '    | ')}\x1b[0m`);
    try { fs.appendFileSync(commandsFile, text); } catch { /* the jobs folder was removed */ }
  };
  const chat = createChat(cfg, `AllAiHarness: ${name}`);
  const state = loadState();
  // The chats this server changed. Only they are saved, on top of what is on disk, so a second
  // server started from this folder keeps its own.
  const own = new Set();
  const saveState = () => {
    const disk = loadState();
    for (const key of own) disk.chats[key] = state.chats[key];
    fs.writeFileSync(STATE_FILE, JSON.stringify(disk));
  };
  // A chat belongs to the workspace it was set up for. In a copy of this folder put into another
  // project, the chats of the first project are not this server's: their blocks never run here.
  const sameDir = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const mine = (key) => !!state.chats[key] && sameDir(state.chats[key].workspace, tools.root);
  // Chats from before this was recorded count as this workspace's.
  for (const [key, c] of Object.entries(state.chats)) if (!c.workspace) { c.workspace = tools.root; own.add(key); }
  const log = (title, body) => fs.appendFileSync(LOG_FILE, `## ${new Date().toISOString()} ${title}\n\n${body}\n\n`);

  // The message last sent, until the brain starts answering it. A rate-limit notice or an answer
  // that never starts means the message is sent again after a wait.
  let waiting = null;
  let gaveUp = false;
  let lastContinue = 0;

  async function sendNow(text) {
    await chat.fill(text);
    await chat.send();
  }

  // Clicks "Continue" when the page offers it for an answer that was cut off as too long.
  async function autoContinue(st) {
    if (!st.cont || Date.now() - lastContinue < 3000) return;
    lastContinue = Date.now();
    if (await chat.clickContinue()) say('answer was cut off as too long; clicked Continue');
  }

  async function watchSent(st) {
    if (!waiting) return;
    if (st.size !== waiting.size) { waiting.size = st.size; waiting.changedAt = Date.now(); }
    // The answer has started once the newest message is a reply and the messages differ from
    // before the send.
    if (st.replied && st.sig !== waiting.sig) { waiting = null; return; }
    if (!st.limited && Date.now() - waiting.changedAt < cfg.idleSec * 1000) return;
    if (++waiting.tries > cfg.maxResends) {
      const msg = `No answer from the chat after ${cfg.maxResends} tries. Check the chat window.`;
      say(msg);
      await chat.banner(msg);
      waiting = null;
      gaveUp = true;
      return;
    }
    say(`${st.limited ? 'rate limit notice' : `no answer for ${cfg.idleSec}s`}; sending the message again in ${cfg.retryWaitSec}s (try ${waiting.tries} of ${cfg.maxResends})`);
    await sleep(cfg.retryWaitSec * 1000);
    await sendNow(waiting.text);
    const after = await chat.state();
    waiting.size = after.size;
    waiting.changedAt = Date.now();
  }

  // Blocks until the brain has answered and the answer has stopped growing.
  async function untilAnswered() {
    let last = -1, same = 0;
    gaveUp = false;
    for (let i = 0; i < 900 && !gaveUp; i++) {
      const st = await chat.state();
      await autoContinue(st);
      await watchSent(st);
      if (!waiting) {
        same = st.size === last ? same + 1 : 0;
        last = st.size;
        if (same >= 5) return;
      }
      await sleep(cfg.pollMs);
    }
  }

  // Delivers a message to the brain. Normally it is sent at once and whatever the user was
  // typing is put back. With --manual it is left in the message box for the user to send. A
  // message over the size limit goes out in parts; each part but the last waits for the answer.
  async function deliver(text) {
    const draft = (await chat.inputText()).split(REQUEST_MARKER).pop().trim();
    if (opts.manual) return chat.fill(draft ? `${text}\n\n${draft}` : text);
    const parts = splitText(text, cfg.maxMessageChars);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const body = parts.length === 1 ? parts[0]
        : `[part ${i + 1} of ${parts.length}${last ? '; the message is complete, go on' : '; more parts follow. Answer only "ok", with no agent block'}]\n${parts[i]}`;
      const before = await chat.state();
      waiting = { text: body, sig: before.sig, size: before.size, changedAt: Date.now(), tries: 0 };
      await sendNow(body);
      if (!last) {
        say(`sent part ${i + 1} of ${parts.length}; waiting for the brain before the next`);
        await untilAnswered();
      }
    }
    if (draft) await chat.fill(draft);
  }

  async function sendSetup() {
    const key = crypto.randomBytes(3).toString('hex');
    state.chats[key] = { workspace: tools.root, seen: [] };
    own.add(key);
    saveState();
    await deliver(render('bootstrap.md', {
      key,
      marker: REQUEST_MARKER,
      path: tools.root,
      shell: process.platform === 'win32' ? 'Windows, cmd.exe' : `${process.platform}, sh`,
      tree: tools.list(),
      maxActions: cfg.maxActionsPerBlock,
    }));
    say(opts.manual ? 'setup text is in the message box; add your request and press Enter' : 'chat set up; talk to the brain in the browser');
  }

  // An old chat that was set up for this workspace goes on as it is. Any other chat gets the
  // setup message first, so the brain knows the format and this workspace.
  async function resumeChat() {
    await sleep(3000); // let the page draw the old messages
    const known = findBlocks(await chat.replies()).some((b) => mine(b.key));
    if (known) say('old chat is already set up; talk to the brain in the browser');
    else await sendSetup();
  }

  async function runAction(action) {
    try {
      switch (action.tool) {
        case 'list': return { ok: true, text: tools.list(action) };
        case 'read': return { ok: true, text: tools.read(action) };
        case 'search': return { ok: true, text: tools.search(action) };
        case 'write': return { ok: true, text: tools.write(action) };
        case 'edit': return { ok: true, text: tools.edit(action) };
        case 'run': {
          // The command and its output go to the Commands window as they come, not at the end.
          commandOut(`\n\x1b[36m[${new Date().toLocaleTimeString()}] ${tools.root}>\x1b[0m ${action.cmd}\n`);
          const began = Date.now();
          const r = await tools.run(action, commandOut);
          commandOut(`\x1b[${r.ok ? '32' : '31'}m[${r.text.split('\n')[0]}, ${Math.round((Date.now() - began) / 1000)}s]\x1b[0m\n`);
          return r;
        }
        case 'claude': {
          if (!claude) throw new Error('Claude Code is not installed on this machine; do the work with write, edit and run');
          if (typeof action.task !== 'string' || !action.task.trim()) throw new Error('"task" is missing');
          await chat.banner(`Claude Code (${workerModel}) is starting in its window...`, '#1d4ed8');
          let lastSaid = 0;
          const r = await runClaude(action.task, {
            workspace: tools.root,
            cfg: cfg.claude,
            model: workerModel,
            title: action.task.replace(/\s+/g, ' ').slice(0, 60),
            // Shown on the chat page and, once a minute, in this window, so a long job never
            // looks like a hang.
            onStep: (step) => console.log(`    claude> ${step.slice(0, 150)}`),
            onStatus: ({ step, steps, secs, waiting }) => {
              const time = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
              chat.banner(`Claude Code (${workerModel}) running ${time}${steps ? `, ${steps} steps` : ''}: ${step}`, waiting ? '#b45309' : '#1d4ed8');
              if (secs - lastSaid >= 60) { lastSaid = secs; say(`Claude Code still running (${time}${steps ? `, ${steps} steps` : ''}: ${step.slice(0, 80)})`); }
            },
          });
          if (r.problem) {
            say(`!!! CLAUDE CODE PROBLEM: ${r.problem}`);
            await chat.banner(`CLAUDE CODE PROBLEM: ${r.problem}`);
            r.text = `CLAUDE CODE PROBLEM: ${r.problem}\nTell the user about this problem first, in your text.\n\n${r.text}`;
          } else await chat.banner('');
          return r;
        }
        default: throw new Error(`unknown tool "${action.tool}"; use list, read, search, write, edit, run or claude`);
      }
    } catch (e) {
      return { ok: false, text: e.message };
    }
  }

  async function runBlock(block) {
    // Marked before it runs: a crash loses one block, it never runs one twice.
    state.chats[block.key].seen.push(block.hash);
    own.add(block.key);
    saveState();

    const actions = block.actions.slice(0, cfg.maxActionsPerBlock).map((a, i) => ({ ...a, id: `a${i + 1}` }));
    say(`block ${block.id}: ${actions.length} action(s)`);
    const results = [];
    let failed = false;
    for (const action of actions) {
      const label = String(action.path || (action.paths || []).join(' ') || action.pattern || action.cmd || action.task || '').replace(/\s+/g, ' ').slice(0, 70);
      if (failed) {
        results.push({ action, status: 'skipped', text: '' });
        console.log(`  ${action.id} ${action.tool} ${label} ... skipped`);
        continue;
      }
      // A command is shown in full, with its output under it as it comes.
      const live = action.tool === 'run' || action.tool === 'claude';
      const began = Date.now();
      if (live) console.log(`  ${action.id} ${action.tool} ${action.tool === 'run' ? String(action.cmd || '') : label}`);
      else process.stdout.write(`  ${action.id} ${action.tool} ${label} ... `);
      let result;
      try { result = await runAction(fillContents(action, block.contents)); } catch (e) { result = { ok: false, text: e.message }; }
      const outcome = result.ok ? 'ok' : `error: ${result.text.split('\n')[0].slice(0, 120)}`;
      console.log(live ? `\n  ${action.id} ${outcome} (${Math.round((Date.now() - began) / 1000)}s)` : outcome);
      results.push({ action, status: result.ok ? 'ok' : 'error', text: result.text });
      failed = !result.ok;
    }

    const note = block.actions.length > actions.length
      ? `Only the first ${actions.length} actions ran; the limit is ${cfg.maxActionsPerBlock} per block.` : '';
    const message = formatResults(block.id, results, { ...cfg, note });
    log(`block ${block.id}`, `${JSON.stringify({ actions: block.actions, contents: block.contents })}\n\n${message}`);
    await deliver(message);
    say(opts.manual ? 'results are in the message box; press Enter there to send' : 'results sent');
  }

  let wasNewChat = false;
  let pending = { digest: null, polls: 0 };
  async function tick() {
    const st = await chat.state();
    await autoContinue(st);
    await watchSent(st);
    const isNewChat = await chat.atNewChat();
    if (isNewChat && !wasNewChat) await sendSetup();
    wasNewChat = isNewChat;

    // Only blocks that carry a key this server issued and that have not run yet.
    const next = findBlocks(await chat.replies())
      .find((b) => mine(b.key) && !state.chats[b.key].seen.includes(b.hash));
    if (!next) { pending = { digest: null, polls: 0 }; return; }
    // Run it once the reply has stopped changing. An agent block that closes the reply means
    // everything before it is complete; otherwise content may still be streaming, so wait longer.
    pending = next.digest === pending.digest ? { digest: next.digest, polls: pending.polls + 1 } : { digest: next.digest, polls: 1 };
    if (pending.polls < (next.isLast ? 2 : 5)) return;
    pending = { digest: null, polls: 0 };
    await runBlock(next);
  }

  process.on('SIGINT', () => { chat.stop(); process.exit(0); });

  // Claude Code needs no setup here: the server starts it by itself, in the workspace.
  const claude = claudeVersion(cfg.claude.cmd);
  console.log(`workspace: ${tools.root}`);
  console.log(`mode: ${opts.manual ? 'manual (messages wait in the message box)' : 'auto (messages are sent for you)'}`);
  console.log(`Claude Code: ${claude ? `found (${claude})` : 'not found; the brain works without it'}`);

  // The model Claude Code works with: haiku, sonnet, opus or a full model name.
  const modelAt = cfg.claude.args.indexOf('--model');
  let workerModel = opts.model || (claude && opts.chat === null
    ? await ask(`Claude Code model (haiku, sonnet, opus) [${cfg.claude.args[modelAt + 1] || 'default'}]: `) : '');
  if (/\s/.test(workerModel)) workerModel = '';
  if (workerModel) {
    if (modelAt >= 0) cfg.claude.args[modelAt + 1] = workerModel; else cfg.claude.args.push('--model', workerModel);
  }
  workerModel = cfg.claude.args[cfg.claude.args.indexOf('--model') + 1] || 'default';
  if (claude) console.log(`Claude Code model: ${workerModel}`);
  if (claude && openClaudeWindow({ workspace: tools.root, cfg: cfg.claude })) {
    console.log(`Claude Code window: "Claude Code - ${name}". Jobs the brain hands to Claude Code run there.`);
  }
  if (commandsFile) console.log(`Commands window: "Commands - ${name}". Every command the brain runs, with its output as it comes.`);

  let link = opts.chat === null ? await ask('Continue an old chat? Paste its link and press Enter. For a new chat just press Enter: ') : opts.chat;
  if (link && !(link.startsWith(cfg.url) && link.length > cfg.url.length)) {
    console.log(`That is not a chat link (it must start with ${cfg.url}). Starting a new chat.`);
    link = '';
  }
  console.log('Keep this window open. Ctrl+C stops the server.\n');

  let resume = !!link;
  let lastProblem = '';
  for (;;) {
    try {
      if (!chat.alive()) {
        // After a lost tab this reopens the chat the tab was on.
        await chat.start(resume ? link : undefined);
        wasNewChat = false;
        say('connected to the chat page');
        if (resume) { resume = false; await resumeChat(); }
      }
      await tick();
      lastProblem = '';
    } catch (e) {
      const problem = e.message.split('\n')[0];
      if (!chat.alive()) {
        say(`chat tab lost (${problem}); opening it again`);
        await sleep(3000);
      } else if (problem !== lastProblem) {
        // With the tab still open the next poll simply tries again, as after a page reload.
        say(`problem: ${problem}`);
        lastProblem = problem;
      }
    }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => { console.error(`\nFailed: ${e.message}`); process.exit(1); });
