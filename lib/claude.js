'use strict';
// Runs one task in headless Claude Code and returns its final message.
const path = require('path');
const { spawn } = require('child_process');

const EXECUTOR_PROMPT = path.join(__dirname, '..', 'prompts', 'executor.md');

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

function runClaude(task, { workspace, cfg }) {
  // The short executor prompt replaces the default system prompt, and cfg.args trims the tool
  // list and settings: together that cuts the fixed cost of a call to a fraction.
  const args = ['-p', '--output-format', 'json', '--system-prompt-file', EXECUTOR_PROMPT, ...cfg.args];

  return new Promise((resolve) => {
    // The task goes in on stdin, so brain-written text is never part of a command line.
    const child = spawn(cfg.cmd, args, { cwd: workspace, windowsHide: true });
    const began = Date.now();
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, cfg.timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      const problem = `could not start ${cfg.cmd}: ${e.message}`;
      resolve({ ok: false, text: problem, problem });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        const problem = `Claude Code timed out after ${cfg.timeoutSec}s and was stopped`;
        return resolve({ ok: false, text: problem, problem });
      }
      let res = null;
      try { res = JSON.parse(out); } catch { /* not JSON: reported below */ }
      if (Array.isArray(res)) res = res.find((m) => m.type === 'result');
      const problem = problemOf(res, code, err || out);
      if (!res) return resolve({ ok: false, text: problem, problem });
      const secs = Math.round((Date.now() - began) / 1000);
      const cost = typeof res.total_cost_usd === 'number' ? `, $${res.total_cost_usd.toFixed(4)}` : '';
      resolve({
        ok: !res.is_error,
        text: `${res.result || `Claude Code finished without a message (${res.subtype})`}\n[Claude Code ran ${secs}s${cost}]`,
        problem,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(task);
  });
}

module.exports = { runClaude };
