'use strict';
// Runs one task in Claude Code and returns its final report. On Windows the real interactive
// Claude Code opens in a window of its own, so the user sees everything it does and can step
// in; it writes its report to a file that the server waits for. Elsewhere, or with
// "window": false, it runs headless through lib/claude-run.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXECUTOR_PROMPT = path.join(__dirname, '..', 'prompts', 'executor.md');
const RUNNER = path.join(__dirname, 'claude-run.js');
const JOBS = path.join(__dirname, '..', 'jobs');
const TROUBLE = /not logged in|\/login|invalid api key|usage limit|credit balance|rate limit|overloaded|quota|limit reached|API Error/i;
// Flags that only work in headless (-p) mode.
const PRINT_ONLY = new Set(['--no-session-persistence']);

// What went wrong in a headless run, in one sentence for the user, or '' when nothing did.
function problemOf(res, code, err) {
  if (!res) return `Claude Code exited with code ${code} and no result: ${(err || '').trim().slice(-300)}`;
  const text = String(res.result || '');
  const denied = (res.permission_denials || []).map((d) => d.tool_name).filter(Boolean);
  if (res.subtype === 'error_max_turns') return 'Claude Code stopped at its turn limit; the job is probably unfinished';
  if (res.is_error || res.subtype?.startsWith('error')) {
    return `Claude Code failed (${res.subtype || 'error'}): ${text.slice(0, 300) || 'no message'}`;
  }
  if (text.length < 400 && TROUBLE.test(text)) return `Claude Code reports: ${text.slice(0, 300)}`;
  if (denied.length) return `Claude Code was denied permission for: ${[...new Set(denied)].join(', ')}`;
  return '';
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

function newJobDir() {
  const dir = path.join(JOBS, `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// onStatus gets { step, steps, secs } every few seconds while the job runs.
function runClaude(task, opts) {
  return opts.cfg.window !== false && process.platform === 'win32' ? runInWindow(task, opts) : runHeadless(task, opts);
}

function runInWindow(task, { workspace, cfg, onStatus = () => {} }) {
  const jobDir = newJobDir();
  const taskFile = path.join(jobDir, 'task.md');
  const reportFile = path.join(jobDir, 'report.md');
  // The task stays in a file: brain-written text never goes on a command line.
  fs.writeFileSync(taskFile, task);
  const rel = (p) => path.relative(workspace, p).split(path.sep).join('/');
  const prompt = `Your task is in the file ${rel(taskFile)}. Read it and carry it out. As your very last step, `
    + `use the Write tool to save your final reply, in the STATUS CHANGED OUTPUT NOTES form, to ${rel(reportFile)}`;
  const args = ['--system-prompt-file', EXECUTOR_PROMPT, ...cfg.args.filter((a) => !PRINT_ONLY.has(a)), prompt];
  const line = args.map((a) => `"${a.replace(/"/g, '')}"`).join(' ');

  return new Promise((resolve) => {
    const began = Date.now();
    // "start /wait" opens Claude Code in a window of its own and ends when that window closes.
    const win = spawn('cmd.exe', ['/d', '/s', '/c', `"start "Claude Code job" /wait "${cfg.cmd}" ${line}"`], {
      cwd: workspace, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
    });
    let done = false, lastSize = -1;

    const poll = setInterval(() => {
      const secs = Math.round((Date.now() - began) / 1000);
      // The report counts once it has stopped growing.
      const report = readText(reportFile);
      if (report !== null && report.trim()) {
        if (report.length === lastSize) return end(report.trim(), secs);
        lastSize = report.length;
      }
      if (secs >= cfg.timeoutSec) {
        spawn('taskkill', ['/pid', String(win.pid), '/T', '/F'], { stdio: 'ignore' });
        return end(null, secs, `Claude Code hit its time limit of ${cfg.timeoutSec}s without a report; its window was closed`);
      }
      onStatus({ step: 'working in its own window', steps: 0, secs });
    }, 2000);

    win.on('exit', () => setTimeout(() => {
      const report = readText(reportFile);
      const secs = Math.round((Date.now() - began) / 1000);
      if (report && report.trim()) end(report.trim(), secs);
      else end(null, secs, 'the Claude Code window was closed before it wrote its report; the job was stopped');
    }, 1000));
    win.on('error', (e) => end(null, 0, `could not open the Claude Code window: ${e.message}`));

    function end(report, secs, problem = '') {
      if (done) return;
      done = true;
      clearInterval(poll);
      if (!report) return resolve({ ok: false, text: problem, problem });
      const failed = /^STATUS:\s*(failed|blocked)/mi.test(report);
      resolve({ ok: true, text: `${report}\n[Claude Code ran ${secs}s; its window stays open until you close it]` });
    }
  });
}

function runHeadless(task, { workspace, cfg, model, title = 'job', onStatus = () => {} }) {
  // The short executor prompt replaces the default system prompt, and cfg.args trims the tool
  // list and settings: together that cuts the fixed cost of a call to a fraction.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', EXECUTOR_PROMPT, ...cfg.args];
  const jobDir = newJobDir();
  fs.writeFileSync(path.join(jobDir, 'task.txt'), task);
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({
    cmd: cfg.cmd, args, workspace, model, title, timeoutSec: cfg.timeoutSec, keepOpenSec: cfg.keepOpenSec ?? 30,
  }));

  return new Promise((resolve) => {
    const began = Date.now();
    const runner = spawn(process.execPath, [RUNNER, jobDir], { cwd: workspace, stdio: 'inherit' });
    let done = false;

    const poll = setInterval(() => {
      const res = readJson(path.join(jobDir, 'result.json'));
      if (res) return end(res);
      const st = readJson(path.join(jobDir, 'status.json')) || { step: 'starting', steps: 0 };
      onStatus({ ...st, secs: Math.round((Date.now() - began) / 1000) });
    }, 2000);

    runner.on('exit', (code) => setTimeout(() => {
      const res = readJson(path.join(jobDir, 'result.json'));
      if (res) end(res);
      else end(null, `the Claude Code runner stopped without a result (exit code ${code})`);
    }, 500));
    runner.on('error', (e) => end(null, `could not start the Claude Code runner: ${e.message}`));

    function end(out, stopped) {
      if (done) return;
      done = true;
      clearInterval(poll);
      const secs = Math.round((Date.now() - began) / 1000);
      if (stopped) return resolve({ ok: false, text: stopped, problem: stopped });
      const res = out.result;
      let problem;
      if (out.startError) problem = out.startError;
      else if (out.timedOut) problem = `Claude Code hit its time limit of ${cfg.timeoutSec}s and was stopped`;
      else problem = problemOf(res, out.code, out.stderr);
      if (!res) return resolve({ ok: false, text: problem, problem });
      const cost = typeof res.total_cost_usd === 'number' ? `, $${res.total_cost_usd.toFixed(4)}` : '';
      resolve({
        ok: !res.is_error && !out.timedOut,
        text: `${res.result || `Claude Code finished without a message (${res.subtype})`}\n[Claude Code ran ${secs}s, ${out.steps} steps${cost}]`,
        problem,
      });
    }
  });
}

module.exports = { runClaude };
