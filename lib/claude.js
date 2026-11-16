'use strict';
// Runs one task in headless Claude Code and returns its final message. On Windows the job runs
// in a console window of its own (lib/claude-run.js), where the user watches every step; on
// other systems its steps print in the server's terminal.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EXECUTOR_PROMPT = path.join(__dirname, '..', 'prompts', 'executor.md');
const RUNNER = path.join(__dirname, 'claude-run.js');
const TROUBLE = /not logged in|\/login|invalid api key|usage limit|credit balance|rate limit|overloaded|quota|limit reached|API Error/i;

// What went wrong in a Claude Code run, in one sentence for the user, or '' when nothing did.
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

// onStatus gets { step, steps, secs } every few seconds while the job runs.
function runClaude(task, { workspace, cfg, model, title = 'job', onStatus = () => {} }) {
  // The short executor prompt replaces the default system prompt, and cfg.args trims the tool
  // list and settings: together that cuts the fixed cost of a call to a fraction.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--system-prompt-file', EXECUTOR_PROMPT, ...cfg.args];
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaiharness-job-'));
  // The task goes in a file and then on stdin, so brain-written text is never part of a command line.
  fs.writeFileSync(path.join(jobDir, 'task.txt'), task);
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({
    cmd: cfg.cmd, args, workspace, model, title, timeoutSec: cfg.timeoutSec, keepOpenSec: cfg.keepOpenSec ?? 30,
  }));

  return new Promise((resolve) => {
    const began = Date.now();
    const win = process.platform === 'win32';
    // On Windows "start /wait" opens the runner in a console window of its own and ends when
    // that window closes.
    const runner = win
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"start "Claude Code" /wait "${process.execPath}" "${RUNNER}" "${jobDir}""`], {
        cwd: workspace, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      })
      : spawn(process.execPath, [RUNNER, jobDir], { cwd: workspace, stdio: 'inherit' });
    let done = false;

    const poll = setInterval(() => {
      const res = readJson(path.join(jobDir, 'result.json'));
      if (res) return end(res);
      const st = readJson(path.join(jobDir, 'status.json')) || { step: 'starting', steps: 0 };
      onStatus({ ...st, secs: Math.round((Date.now() - began) / 1000) });
    }, 2000);

    // The runner ends without a result when its window was closed.
    runner.on('exit', (code) => setTimeout(() => {
      const res = readJson(path.join(jobDir, 'result.json'));
      if (res) end(res);
      else end(null, `the Claude Code window was closed or crashed (exit code ${code}); the job was stopped`);
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
