'use strict';
// The Claude Code window of one harness server. It stays open for the whole session and runs one
// Claude Code after another: an idle one at the start, then a fresh one for each job. The server
// passes each order through next.json in the session folder.
//   node claude-window.js <sessionDir> <serverPid>
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const [dir, serverPid] = process.argv.slice(2);
const NEXT = path.join(dir, 'next.json');
let child = null;

const serverAlive = () => { try { process.kill(Number(serverPid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function stopChild() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  // The whole tree: Claude Code may have commands of its own running.
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

function run(order) {
  stopChild();
  // A stopped Claude Code leaves its screen modes on: mouse and paste reporting, a hidden cursor.
  process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[2J\x1b[H');
  process.stdout.write(`\x1b]0;${order.title}\x07`);
  console.log(`\x1b[36m=== ${order.header} ===\x1b[0m\n`);
  if (!order.args) return;

  // Claude Code gets the window itself, keyboard included. It must not rename the window: the
  // title says which workspace this is.
  const c = spawn(order.cmd, order.args, {
    cwd: order.cwd, stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' },
  });
  child = c;
  const gone = (message) => {
    if (child !== c) return; // stopped here, for the next order
    child = null;
    if (order.jobDir) {
      try { fs.appendFileSync(path.join(order.jobDir, 'events.jsonl'), JSON.stringify({ kind: 'exit', at: Date.now(), message }) + '\n'); } catch { /* the job is over */ }
    }
    console.log(`\n\x1b[36m=== ${message}. The next job from the brain starts here. ===\x1b[0m`);
  };
  c.on('exit', () => gone('Claude Code was closed'));
  c.on('error', (e) => gone(`Claude Code could not start: ${e.message}`));
}

// Ctrl+C belongs to Claude Code.
process.on('SIGINT', () => {});

setInterval(() => {
  // The window belongs to its server and goes when the server does.
  if (!serverAlive()) { stopChild(); process.exit(0); }
  let order;
  try { order = JSON.parse(fs.readFileSync(NEXT, 'utf8')); } catch { return; }
  try { fs.unlinkSync(NEXT); } catch { return; }
  run(order);
}, 300);
