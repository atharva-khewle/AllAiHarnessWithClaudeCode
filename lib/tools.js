'use strict';
// What the brain can do in the workspace without Claude Code: list, read, search, write, edit, run.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

// Paths the brain may never touch. Everything read here is sent to an external chat service.
const DENY = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.(git|ssh|aws|gnupg)(\/|$)/,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/,
  /(^|\/)\.(npmrc|netrc|pypirc)$/,
  /(^|\/)\.[^/]*token[^/]*$/i,
];
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target']);
const MAX_READ_LINES = 400;
const MAX_MANY = 30;
const MAX_MANY_LINES = 3000;
const MAX_FILE_BYTES = 2 << 20;
const MAX_LIST = 500;
const MAX_HITS = 100;
const MAX_RUN_OUTPUT = 8000;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function globToRe(glob) {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${body}$`);
}

function createTools(workspace, { deny = [], exclude = [], run: runCfg = {} } = {}) {
  const root = fs.realpathSync(workspace);
  const denyRe = [...DENY, ...deny.map((s) => new RegExp(s, 'i'))];
  const denied = (rel) => denyRe.some((re) => re.test(rel));
  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  // Folders inside the workspace that are off limits to the brain (the harness itself).
  const hidden = exclude
    .map((dir) => toRel(path.resolve(dir)))
    .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  const excluded = (rel) => hidden.some((h) => rel === h || rel.startsWith(h + '/'));

  function resolve(p) {
    const abs = path.resolve(root, String(p || '.'));
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    const rel = toRel(real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path is outside the workspace: ${p}`);
    if (denied(rel)) throw new Error(`access denied (secret file): ${p}`);
    if (excluded(rel)) throw new Error(`access denied (harness folder): ${p}`);
    return { abs: real, rel };
  }

  function walk(dir, prefix, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 5000) return out;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel, out);
      } else if (entry.isFile()) out.push(rel);
    }
    return out;
  }

  function files() {
    let all;
    try {
      // Tracked plus untracked-but-not-ignored, so .gitignore is respected.
      all = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\0').filter(Boolean);
    } catch {
      all = walk(root, '', []);
    }
    return all.filter((f) => !denied(f) && !excluded(f)).sort();
  }

  function list({ path: p = '.' } = {}) {
    const { rel } = resolve(p);
    const under = files().filter((f) => !rel || f === rel || f.startsWith(rel + '/'));
    if (!under.length) return 'no files';
    const shown = under.slice(0, MAX_LIST).join('\n');
    return under.length > MAX_LIST ? `${shown}\n[${under.length - MAX_LIST} more; list a subfolder]` : shown;
  }

  function loadText(abs) {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(abs);
    return buf.includes(0) ? null : buf.toString('utf8');
  }

  function openText(p) {
    if (!p) throw new Error('"path" is missing');
    const { abs, rel } = resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
    if (fs.statSync(abs).isDirectory()) throw new Error(`${p} is a folder; use list`);
    const text = loadText(abs);
    if (text === null) throw new Error(`${p} is binary or larger than 2 MB`);
    return { abs, rel, text };
  }

  // Several whole files in one result. The server sends it in parts when it is large.
  function readMany(paths) {
    if (paths.length > MAX_MANY) throw new Error(`at most ${MAX_MANY} files per read; split the list`);
    return paths.map((p) => {
      try {
        const { rel, text } = openText(p);
        const lines = text.split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const shown = lines.slice(0, MAX_MANY_LINES).map((line, i) => `${i + 1}: ${line}`).join('\n');
        const cut = lines.length > MAX_MANY_LINES ? `\n[${lines.length - MAX_MANY_LINES} more lines; read the rest with start/end]` : '';
        return `=== ${rel} (${lines.length} lines)\n${shown}${cut}`;
      } catch (e) {
        return `=== ${p}\nerror: ${e.message}`;
      }
    }).join('\n\n');
  }

  function read({ path: p, paths, start, end } = {}) {
    if (Array.isArray(paths)) return readMany(paths.map(String));
    const { rel, text } = openText(p);
    const lines = text.split(/\r?\n/);
    // The newline that ends the file is not a line of its own.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const first = Math.max(1, parseInt(start, 10) || 1);
    const cap = first + MAX_READ_LINES - 1;
    const last = Math.min(lines.length, parseInt(end, 10) || cap, cap);
    const body = lines.slice(first - 1, last).map((line, i) => `${first + i}: ${line}`).join('\n');
    return `${rel} lines ${first}-${last} of ${lines.length}\n${body}`;
  }

  function search({ pattern, glob } = {}) {
    if (!pattern) throw new Error('"pattern" is missing');
    const re = new RegExp(pattern);
    const match = glob ? globToRe(glob) : null;
    const hits = [];
    for (const f of files()) {
      if (match && !match.test(glob.includes('/') ? f : path.posix.basename(f))) continue;
      let text;
      try { text = loadText(path.join(root, f)); } catch { continue; }
      if (text === null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= MAX_HITS) return `${hits.join('\n')}\n[stopped at ${MAX_HITS} matches; narrow the pattern]`;
      }
    }
    return hits.length ? hits.join('\n') : 'no matches';
  }

  function write({ path: p, content } = {}) {
    if (!p) throw new Error('"path" is missing');
    if (typeof content !== 'string') throw new Error('"content" is missing');
    const { abs, rel } = resolve(p);
    const existed = fs.existsSync(abs);
    if (existed && fs.statSync(abs).isDirectory()) throw new Error(`${p} is a folder`);
    // A replaced file keeps its line endings.
    const crlf = existed && fs.readFileSync(abs, 'utf8').includes('\r\n');
    let text = content.replace(/\r\n/g, '\n');
    if (text && !text.endsWith('\n')) text += '\n';
    if (crlf) text = text.replace(/\n/g, '\r\n');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return `${existed ? 'replaced' : 'created'} ${rel} (${text.split('\n').length - 1} lines)`;
  }

  // Splits "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" text into its find/replace pairs.
  function parseChanges(changes) {
    const pairs = [];
    let pair = null, part = null;
    for (const line of changes.replace(/\r\n/g, '\n').split('\n')) {
      if (/^<{5,} *SEARCH\s*$/.test(line)) { pair = { find: [], replace: [] }; part = 'find'; }
      else if (part === 'find' && /^={5,}\s*$/.test(line)) part = 'replace';
      else if (part === 'replace' && /^>{5,} *REPLACE\s*$/.test(line)) {
        pairs.push({ find: pair.find.join('\n'), replace: pair.replace.join('\n') });
        pair = null; part = null;
      } else if (pair) pair[part].push(line);
    }
    if (pair) throw new Error('"changes" has a SEARCH part that is not closed with ======= and >>>>>>> REPLACE');
    if (!pairs.length) throw new Error('"changes" has no <<<<<<< SEARCH / ======= / >>>>>>> REPLACE part');
    return pairs;
  }

  // Returns `text` with `find` replaced, or throws saying why it could not be.
  function replaceIn(text, rel, { find, replace, all }) {
    if (typeof find !== 'string' || !find.trim()) throw new Error('the text to find is empty; use write to create a file');
    if (typeof replace !== 'string') throw new Error('the replacement text is missing');
    // Matches line by line, ignoring line-ending style and spaces before a line break, which do
    // not survive the trip through a chat page. The last line is matched as written, so text
    // that stops in the middle of a line leaves the rest of that line alone.
    const lines = find.replace(/\r\n/g, '\n').split('\n').map((line) => escapeRe(line.trimEnd()));
    const re = new RegExp(lines.join('[ \\t]*\\r?\\n'), 'g');
    const count = (text.match(re) || []).length;
    if (!count) {
      // Say where the nearest candidate is, so the next attempt can copy it exactly.
      const first = find.split('\n').find((line) => line.trim()) || '';
      const at = text.split(/\r?\n/).findIndex((line) => line.trim() === first.trim());
      const hint = at < 0
        ? `its first line (${JSON.stringify(first.trim().slice(0, 80))}) is nowhere in the file`
        : `line ${at + 1} has its first line, so the indentation or a later line differs`;
      throw new Error(`the SEARCH text is not in ${rel}: ${hint}. It must be lines that are in the file now, copied exactly, without the line numbers`);
    }
    if (count > 1 && !all) throw new Error(`the SEARCH text is in ${rel} ${count} times; add surrounding lines to make it unique`);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const replacement = replace.replace(/\r\n/g, '\n').split('\n').join(eol);
    return text.replace(re, () => replacement);
  }

  // Applies every change or none: a file is never left half edited.
  function edit({ path: p, changes, find, replace, all } = {}) {
    const { abs, rel, text } = openText(p);
    const pairs = typeof changes === 'string' ? parseChanges(changes) : [{ find, replace, all }];
    let result = text;
    pairs.forEach((pair, i) => {
      try { result = replaceIn(result, rel, pair); } catch (e) {
        throw new Error(pairs.length > 1 ? `change ${i + 1} of ${pairs.length}: ${e.message}. Nothing was changed` : e.message);
      }
    });
    fs.writeFileSync(abs, result);
    return `edited ${rel} (${pairs.length} change${pairs.length > 1 ? 's' : ''})`;
  }

  const blockRe = (runCfg.block || []).map((s) => new RegExp(s, 'i'));

  // Runs a shell command in the workspace. Resolves to { ok, text }. onOutput gets the output
  // piece by piece while the command runs.
  function run({ cmd, timeout } = {}, onOutput = () => {}) {
    return new Promise((done) => {
      if (typeof cmd !== 'string' || !cmd.trim()) return done({ ok: false, text: '"cmd" is missing' });
      // cmd.exe runs the first line only and drops the rest without a word.
      if (process.platform === 'win32' && /[\r\n]/.test(cmd.trim())) {
        return done({ ok: false, text: 'a command must be one line here (cmd.exe runs only the first line). For more, write a script file and run it.' });
      }
      if (blockRe.some((re) => re.test(cmd))) {
        return done({ ok: false, text: 'blocked by the harness: this kind of command is not allowed here. If it is needed, ask the user to run it.' });
      }
      const limit = Math.min(Math.max(parseInt(timeout, 10) || runCfg.timeoutSec || 120, 1), runCfg.maxTimeoutSec || 600);
      const child = spawn(cmd, { cwd: root, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', timedOut = false;
      const collect = (d) => { out = (out + d).slice(-(2 << 20)); onOutput(String(d)); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the whole tree: the shell and whatever it started.
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, limit * 1000);
      child.on('error', (e) => { clearTimeout(timer); done({ ok: false, text: `could not start the command: ${e.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        out = out.trim();
        if (out.length > MAX_RUN_OUTPUT) {
          // The end of the output matters most: that is where errors and summaries are.
          out = `${out.slice(0, 2000)}\n[... ${out.length - MAX_RUN_OUTPUT} characters cut ...]\n${out.slice(-(MAX_RUN_OUTPUT - 2000))}`;
        }
        const status = timedOut ? `stopped after ${limit}s (timeout)` : `exit code ${code}`;
        done({ ok: !timedOut && code === 0, text: out ? `${status}\n${out}` : status });
      });
    });
  }

  return { root, list, read, search, write, edit, run };
}

module.exports = { createTools };
