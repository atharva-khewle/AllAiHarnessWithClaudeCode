'use strict';
// Hook and status-line command for a Claude Code job window. Claude Code runs it with event data
// on stdin; it passes that on to the server through files in the job folder.
//   node claude-hook.js <jobDir> status <workspace>   status line: saves cost and transcript path
//   node claude-hook.js <jobDir> <event>              hook: adds the event to events.jsonl
const fs = require('fs');
const path = require('path');

const [jobDir, kind, name = 'job'] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch { /* nothing usable */ }
  try {
    if (kind === 'status') {
      fs.writeFileSync(path.join(jobDir, 'status.json'), JSON.stringify({
        cost: data.cost?.total_cost_usd, transcript: data.transcript_path, model: data.model?.display_name,
      }));
      const cost = typeof data.cost?.total_cost_usd === 'number' ? ` | $${data.cost.total_cost_usd.toFixed(4)}` : '';
      process.stdout.write(`AllAiHarness | ${name}${cost}`);
    } else {
      fs.appendFileSync(path.join(jobDir, 'events.jsonl'), JSON.stringify({
        kind,
        at: Date.now(),
        tool: data.tool_name,
        input: data.tool_input,
        message: data.message,
        transcript: data.transcript_path,
      }) + '\n');
    }
  } catch { /* the job folder is gone: the server is no longer waiting */ }
  process.exit(0);
});
