'use strict';
// Runs one Claude Code job in a console window of its own, so the user can watch every step and
// see at once whether it is still running, finished or failed. Started by lib/claude.js with a
// job folder holding task.txt and job.json; writes status.json while it runs and result.json at
// the end. Closing the window stops the job.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const jobDir = process.argv[2];
const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
const task = fs.readFileSync(path.join(jobDir, 'task.txt'), 'utf8');

const C = { dim: '\x1b[90m', red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m', cyan: '\x1b[96m', off: '\x1b[0m' };
const began = Date.now();
const elapsed = () => {
  const s = Math.round((Date.now() - began) / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const out = (text, color = '') => console.log(`${C.dim}[${elapsed()}]${C.off} ${color}${text}${color && C.off}`);
const setTitle = (text) => process.stdout.write(`\x1b]0;${text}\x07`);
const one = (text, max = 160) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

let steps = 0, lastStep = 'starting', lastEventAt = Date.now();
function status(step) {
  lastStep = step;
  lastEventAt = Date.now();
  try { fs.writeFileSync(path.join(jobDir, 'status.json'), JSON.stringify({ step, steps, at: Date.now() })); } catch { /* next one */ }
}

function describe(tool) {
  const i = tool.input || {};
  const target = i.command || i.file_path || i.path || i.pattern || i.url || i.description || JSON.stringify(i);
  return `${tool.name}: ${one(target, 140)}`;
}

setTitle(`Claude Code (${job.model}) RUNNING - ${job.title}`);
console.log(`${C.cyan}Claude Code job, started by AllAiHarness${C.off}`);
console.log(`model:     ${job.model}`);
console.log(`workspace: ${job.workspace}`);
console.log(`time limit: ${job.timeoutSec}s. Closing this window stops the job.`);
console.log(`${C.dim}task:\n${task.trim().slice(0, 1500)}${C.off}\n`);

const child = spawn(job.cmd, job.args, { cwd: job.workspace, windowsHide: true });
out(`claude started (pid ${child.pid})`);
status('started');

let buf = '', stderr = '', result = null, timedOut = false;
child.stdout.on('data', (d) => {
  buf += d;
  let cut;
  while ((cut = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, cut).trim();
    buf = buf.slice(cut + 1);
    if (line) onEvent(line);
  }
});
child.stderr.on('data', (d) => {
  stderr = (stderr + d).slice(-4000);
  for (const line of String(d).split('\n')) if (line.trim()) out(`stderr: ${line.trim()}`, C.red);
});

function onEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return out(line, C.dim); }
  if (ev.type === 'system' && ev.subtype === 'init') {
    out(`session ready, model ${ev.model}`);
  } else if (ev.type === 'assistant') {
    for (const part of ev.message?.content || []) {
      if (part.type === 'text' && part.text.trim()) out(part.text.trim());
      if (part.type === 'tool_use') { steps++; out(`> ${describe(part)}`, C.cyan); status(describe(part)); }
    }
  } else if (ev.type === 'user') {
    for (const part of ev.message?.content || []) {
      if (part.type !== 'tool_result') continue;
      const text = Array.isArray(part.content) ? part.content.map((c) => c.text || '').join(' ') : part.content;
      if (part.is_error) out(`  ! ${one(text, 400)}`, C.red);
      else out(`  ok ${one(text, 120)}`, C.dim);
    }
  } else if (ev.type === 'result') {
    result = ev;
  }
}

// A line now and then while nothing happens, so a long silence never looks like a hang.
const beat = setInterval(() => {
  if (Date.now() - lastEventAt >= 60000) out(`still running; last step: ${lastStep}`, C.yellow);
}, 60000);

const timer = setTimeout(() => {
  timedOut = true;
  out(`time limit of ${job.timeoutSec}s reached; stopping Claude Code`, C.red);
  killTree();
}, job.timeoutSec * 1000);

function killTree() {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

child.on('error', (e) => finish(null, `could not start ${job.cmd}: ${e.message}`));
child.on('close', (code) => finish(code));
child.stdin.on('error', () => {});
child.stdin.end(task);

let finished = false;
function finish(code, startError) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  clearInterval(beat);
  fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify({ result, code, stderr, timedOut, startError, steps }));
  const failed = startError || timedOut || !result || result.is_error;
  console.log();
  if (failed) {
    out(`FAILED: ${startError || (timedOut ? 'time limit reached' : result ? result.subtype : `claude exited with code ${code}`)}`, C.red);
  } else {
    out(`DONE in ${steps} steps${typeof result.total_cost_usd === 'number' ? `, $${result.total_cost_usd.toFixed(4)}` : ''}`, C.green);
  }
  setTitle(`Claude Code (${job.model}) ${failed ? 'FAILED' : 'DONE'} - ${job.title}`);
  // A failure stays on screen until the user closes the window; a success goes after a while.
  const keep = failed ? 3600 : job.keepOpenSec;
  out(`This window closes in ${keep}s. Close it any time.`, C.dim);
  setTimeout(() => process.exit(0), keep * 1000);
}
