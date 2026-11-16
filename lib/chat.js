'use strict';
// Drives the chat page in a real Chrome window over the DevTools protocol. No dependencies:
// uses the WebSocket and fetch that ship with Node 22 and later.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome(configured) {
  const env = process.env;
  const candidates = [
    configured,
    env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found; set "chromePath" in config.json');
  return found;
}

// One DevTools connection to one tab.
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const waiting = new Map();
    let nextId = 1;
    const tab = {
      open: true,
      call(method, params = {}) {
        if (!tab.open) return Promise.reject(new Error('tab is closed'));
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`${method} timed out`)); }, 30000);
          waiting.set(id, { res, rej, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); },
    };
    ws.addEventListener('open', () => resolve(tab));
    ws.addEventListener('error', () => reject(new Error('could not connect to the Chrome tab')));
    ws.addEventListener('close', () => {
      tab.open = false;
      for (const { rej, timer } of waiting.values()) { clearTimeout(timer); rej(new Error('tab is closed')); }
      waiting.clear();
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const call = waiting.get(msg.id);
      if (!call) return;
      waiting.delete(msg.id);
      clearTimeout(call.timer);
      if (msg.error) call.rej(new Error(msg.error.message)); else call.res(msg.result);
    });
  });
}

function createChat(cfg) {
  const endpoint = `http://127.0.0.1:${cfg.debugPort}`;
  // The profile lives outside the harness folder, so every copy of the folder shares one login.
  const profile = cfg.profileDir || path.join(os.homedir(), '.allaiharness', 'chrome-profile');
  const inputSel = JSON.stringify(cfg.selectors.input);
  let tab = null;
  let lastUrl = null;

  async function debuggerUp() {
    try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; }
  }

  async function evaluate(expression) {
    const res = await tab.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(`page script failed: ${res.exceptionDetails.text}`);
    return res.result.value;
  }

  // Opens a tab of its own and waits until the message box is there. The tab shows `url` when
  // given, else the chat this server was last on, else a new chat.
  async function start(url) {
    if (tab) tab.close();
    const open = url || lastUrl || cfg.url;
    let target;
    if (await debuggerUp()) {
      // Chrome is already up (another copy of the harness, or an earlier run): add a tab.
      target = await (await fetch(`${endpoint}/json/new?${open}`, { method: 'PUT' })).json();
    } else {
      // A normally launched Chrome: the login survives and the site sees an ordinary browser.
      spawn(findChrome(cfg.chromePath), [
        `--remote-debugging-port=${cfg.debugPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        open,
      ], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 60 && !target; i++) {
        await sleep(500);
        try {
          target = (await (await fetch(`${endpoint}/json/list`)).json()).find((t) => t.type === 'page');
        } catch { /* Chrome is still starting */ }
      }
      if (!target) throw new Error('Chrome did not start');
    }
    tab = await connect(target.webSocketDebuggerUrl);
    // Chrome stops drawing a page that is covered, minimized or in a background tab, and the
    // chat then neither shows replies nor sends. This keeps the page live in all those cases.
    await tab.call('Emulation.setFocusEmulationEnabled', { enabled: true });

    let told = false;
    const began = Date.now();
    for (;;) {
      const ready = await evaluate(`!/sign_in|login/i.test(location.href) && !!document.querySelector(${inputSel})`).catch(() => false);
      if (ready) return;
      if (!tab.open) throw new Error('the chat tab was closed');
      const waited = Date.now() - began;
      if (waited > 10 * 60 * 1000) throw new Error('message box did not appear; log in, or fix "selectors.input" in config.json');
      // A page that is only loading gets a few seconds before the user is asked to act.
      if (!told && waited > 8000) { console.log('Waiting for the chat page. Log in in the Chrome window that opened.'); told = true; }
      await sleep(1000);
    }
  }

  const alive = () => !!tab && tab.open;

  // True on the new-chat page, before the first message gives the chat its own URL.
  async function atNewChat() {
    lastUrl = (await evaluate('location.href')).split(/[?#]/)[0];
    return lastUrl === cfg.url;
  }

  function inputText() {
    return evaluate(`(() => { const el = document.querySelector(${inputSel}); return el ? (el.value ?? el.innerText ?? '') : ''; })()`);
  }

  // Replaces what is in the message box, as typing would, without sending it.
  async function fill(text) {
    await evaluate(`(() => { const el = document.querySelector(${inputSel}); el.focus(); el.select ? el.select() : document.execCommand('selectAll'); })()`);
    await tab.call('Input.insertText', { text });
  }

  async function send() {
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    // Enter is ignored while the previous answer is still streaming, so retry for a while.
    for (let i = 0; i < 60; i++) {
      await evaluate(`document.querySelector(${inputSel}).focus()`);
      await tab.call('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...enter });
      await tab.call('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
      await sleep(1000);
      if (!(await inputText()).trim()) return;
      if (cfg.selectors.send) {
        await evaluate(`document.querySelector(${JSON.stringify(cfg.selectors.send)})?.click()`);
        await sleep(1000);
        if (!(await inputText()).trim()) return;
      }
    }
    throw new Error('message was not sent; set "selectors.send" in config.json to the send button');
  }

  // For each reply on the page that has code blocks: the text of those blocks, in order.
  function replies() {
    return evaluate(`[...document.querySelectorAll(${JSON.stringify(cfg.selectors.reply)})]
      .map((m) => [...m.querySelectorAll('pre')].map((p) => p.innerText)).filter((b) => b.length)`);
  }

  function stop() {
    // Closes the connection only. Chrome stays open so the next run reuses the login.
    if (tab) tab.close();
  }

  return { start, alive, atNewChat, inputText, fill, send, replies, stop };
}

module.exports = { createChat };
