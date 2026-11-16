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

// `label` names this server on its chat page.
function createChat(cfg, label = 'AllAiHarness') {
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

  const pages = async () => (await (await fetch(`${endpoint}/json/list`)).json()).filter((t) => t.type === 'page');

  // Opens a Chrome window of its own and waits until the message box is there. The window shows
  // `url` when given, else the chat this server was last on, else a new chat.
  async function start(url) {
    if (tab) tab.close();
    const open = url || lastUrl || cfg.url;
    let blanks = [];
    if (!(await debuggerUp())) {
      // A normally launched Chrome: the login survives and the site sees an ordinary browser.
      spawn(findChrome(cfg.chromePath), [
        `--remote-debugging-port=${cfg.debugPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 60 && !(await debuggerUp()); i++) await sleep(500);
      if (!(await debuggerUp())) throw new Error('Chrome did not start');
      blanks = (await pages()).filter((t) => t.url === 'about:blank');
    }
    // Every server makes its own window here and never takes a page that is already open:
    // several servers share the one Chrome and its login, and each keeps to its own chat.
    const browser = await connect((await (await fetch(`${endpoint}/json/version`)).json()).webSocketDebuggerUrl);
    const { targetId } = await browser.call('Target.createTarget', { url: open, newWindow: true });
    browser.close();
    // The empty page Chrome started with has done its job.
    for (const t of blanks) await fetch(`${endpoint}/json/close/${t.id}`).catch(() => {});
    tab = await connect(`ws://127.0.0.1:${cfg.debugPort}/devtools/page/${targetId}`);
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

  // What the page shows right now, for noticing a rate-limit notice, a stalled answer and the
  // Continue button. Text inside replies and the message box is ignored, so a reply that merely
  // talks about rate limits does not count.
  const limitRe = JSON.stringify(cfg.page?.limit || 'too frequent|try again later|rate limit|请稍后|过于频繁');
  const continueRe = JSON.stringify(cfg.page?.continue || '^\\s*(continue( generating)?|继续生成)\\s*$');
  const leaves = `[...document.querySelectorAll('body *')].filter((e) => !e.children.length
    && !e.closest(${JSON.stringify(cfg.selectors.reply)}) && !e.closest('textarea,#__harness_banner,#__harness_badge'))`;
  // A small tag in the corner of the page: which workspace this chat works on.
  const badge = `if (!document.getElementById('__harness_badge')) {
        const b = document.createElement('div');
        b.id = '__harness_badge';
        b.textContent = ${JSON.stringify(label)};
        b.style.cssText = 'position:fixed;bottom:6px;right:10px;z-index:2147483646;padding:2px 8px;border-radius:4px;font:12px sans-serif;color:#fff;background:#374151;opacity:.85;pointer-events:none';
        document.body.appendChild(b);
      }`;

  function state() {
    return evaluate(`(() => {
      const limit = new RegExp(${limitRe}, 'i'), cont = new RegExp(${continueRe}, 'i');
      ${badge}
      const leaf = ${leaves};
      return {
        // The page keeps only its last few messages, so a count of replies would stop growing.
        sig: [...document.querySelectorAll(${JSON.stringify(cfg.selectors.message)})].slice(-2).map((m) => m.innerText.length + m.innerText.slice(-30)).join('|'),
        replied: (() => { const all = document.querySelectorAll(${JSON.stringify(cfg.selectors.message)}); const last = all[all.length - 1]; return !!last && !!last.querySelector(${JSON.stringify(cfg.selectors.reply)}); })(),
        size: document.body.innerText.length,
        limited: leaf.some((e) => e.textContent.length < 200 && limit.test(e.textContent)),
        cont: leaf.some((e) => cont.test(e.textContent)),
      };
    })()`);
  }

  // Clicks the Continue button that the page shows under an answer that was cut off as too long.
  function clickContinue() {
    return evaluate(`(() => {
      const cont = new RegExp(${continueRe}, 'i');
      const el = ${leaves}.reverse().find((e) => cont.test(e.textContent));
      if (!el) return false;
      (el.closest('button,[role=button]') || el).click();
      return true;
    })()`);
  }

  // A bar across the top of the chat page, so the user sees a problem without watching the
  // server window. Click it to dismiss; no text removes it.
  async function banner(text, color = '#b91c1c') {
    try {
      await evaluate(`(() => {
        let b = document.getElementById('__harness_banner');
        if (!${JSON.stringify(!!text)}) { if (b) b.remove(); return; }
        if (!b) {
          b = document.createElement('div');
          b.id = '__harness_banner';
          b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px 14px;font:14px sans-serif;color:#fff;text-align:center;cursor:pointer';
          b.onclick = () => b.remove();
          document.body.appendChild(b);
        }
        b.style.background = ${JSON.stringify(color)};
        b.textContent = ${JSON.stringify(text || '')};
      })()`);
    } catch { /* the page is reloading; the server window still shows it */ }
  }

  function stop() {
    // Closes the connection only. Chrome stays open so the next run reuses the login.
    if (tab) tab.close();
  }

  return { start, alive, atNewChat, inputText, fill, send, replies, state, clickContinue, banner, stop };
}

module.exports = { createChat };
