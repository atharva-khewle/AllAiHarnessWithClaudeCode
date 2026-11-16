'use strict';
// Runs one task in headless Claude Code and returns its final message.
const path = require('path');
const { spawn } = require('child_process');

const EXECUTOR_PROMPT = path.join(__dirname, '..', 'prompts', 'executor.md');

function runClaude(task, { workspace, cfg }) {
  // The short executor prompt replaces the default system prompt, and cfg.args trims the tool
  // list and settings: together that cuts the fixed cost of a call to a fraction.
  const args = ['-p', '--output-format', 'json', '--system-prompt-file', EXECUTOR_PROMPT, ...cfg.args];

  return new Promise((resolve) => {
    // The task goes in on stdin, so brain-written text is never part of a command line.
    const child = spawn(cfg.cmd, args, { cwd: workspace, windowsHide: true });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, cfg.timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `could not start ${cfg.cmd}: ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, text: `Claude Code timed out after ${cfg.timeoutSec}s` });
      let res = null;
      try { res = JSON.parse(out); } catch { /* not JSON: reported below */ }
      if (Array.isArray(res)) res = res.find((m) => m.type === 'result');
      if (!res) return resolve({ ok: false, text: `Claude Code exited with code ${code}: ${(err || out).trim().slice(-2000)}` });
      resolve({
        ok: !res.is_error,
        text: res.result || `Claude Code finished without a message (${res.subtype})`,
        costUsd: res.total_cost_usd,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(task);
  });
}

module.exports = { runClaude };
