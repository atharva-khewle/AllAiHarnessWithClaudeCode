'use strict';
// Message format between the server and the brain.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROMPTS = path.join(__dirname, '..', 'prompts');
// Last line of the setup text. A request typed by the user goes after it.
const REQUEST_MARKER = 'MY REQUEST:';
const LABEL = /^@[\w.-]+$/;

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function render(file, vars) {
  const template = fs.readFileSync(path.join(PROMPTS, file), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? '')).trimEnd();
}

function tryParse(text) {
  try { return JSON.parse(text.replace(/ /g, ' ')); } catch { return null; }
}

// Finds the agent block in each reply. `replies` holds, per reply, the text of its code blocks.
// An agent block is complete JSON with a "key" and an "actions" list; one that is still
// streaming does not parse and is skipped. The other code blocks of the reply that start with
// a label line (@1, @2, ...) are its content blocks.
function findBlocks(replies) {
  const blocks = [];
  for (const codeBlocks of replies) {
    let at = -1, obj = null;
    for (let i = codeBlocks.length - 1; i >= 0 && at < 0; i--) {
      const parsed = tryParse(codeBlocks[i].trim());
      if (parsed && typeof parsed.key === 'string' && Array.isArray(parsed.actions)) { at = i; obj = parsed; }
    }
    if (!obj) continue;
    const contents = {};
    codeBlocks.forEach((text, i) => {
      if (i === at) return;
      const body = text.replace(/\r\n/g, '\n');
      const cut = body.indexOf('\n');
      const label = (cut < 0 ? body : body.slice(0, cut)).trim();
      if (LABEL.test(label)) contents[label] = cut < 0 ? '' : body.slice(cut + 1).replace(/\n$/, '');
    });
    blocks.push({
      key: obj.key,
      id: obj.id ?? '?',
      actions: obj.actions,
      contents,
      // Identity of the block: what decides whether it already ran.
      hash: sha(codeBlocks[at].trim()),
      // State of the whole reply: used to tell when it has stopped streaming.
      digest: sha(codeBlocks.join('\u0000')),
      isLast: at === codeBlocks.length - 1,
    });
  }
  return blocks;
}

// Swaps "@label" values in an action for the content block they name.
function fillContents(action, contents) {
  const filled = {};
  for (const [field, value] of Object.entries(action)) {
    const takesContent = ['content', 'changes', 'find', 'replace', 'task'].includes(field);
    if (typeof value === 'string' && LABEL.test(value)) {
      if (value in contents) { filled[field] = contents[value]; continue; }
      if (takesContent) {
        throw new Error(`content block ${value} is not in the reply; put it before the agent block, with ${value} as its first line`);
      }
    } else if (typeof value === 'string' && takesContent && /^@[\w.-]+\s*\n/.test(value)) {
      throw new Error(`"${field}" mixes a label with other text. A label must be the whole value: put the complete text in its own content block and refer to that block alone`);
    }
    filled[field] = value;
  }
  return filled;
}

function clip(text, max) {
  text = String(text);
  return text.length > max ? `${text.slice(0, max)}\n[cut ${text.length - max} characters; ask for a narrower range]` : text;
}

function formatResults(blockId, results, { maxResultChars, maxMessageChars, note = '' }) {
  const each = Math.min(maxResultChars, Math.floor(maxMessageChars / Math.max(1, results.length)));
  const parts = results.map((r) => {
    const target = r.action.path || r.action.pattern || r.action.cmd || '';
    return `[${r.action.id} ${r.action.tool} ${String(target).slice(0, 80)}] ${r.status}\n${clip(r.text, each)}`.trimEnd();
  });
  const next = Number.isFinite(Number(blockId)) ? `Next block id: ${Number(blockId) + 1}` : '';
  return [`RESULTS for block ${blockId}`, ...parts, note, next].filter(Boolean).join('\n\n');
}

module.exports = { REQUEST_MARKER, render, findBlocks, fillContents, formatResults };
