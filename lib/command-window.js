'use strict';
// The Commands window of one harness server: shows, read only, every command the brain runs and
// its output as it comes. The server writes it all to a file; this follows that file.
//   node command-window.js <file> <serverPid>
const fs = require('fs');

const [file, serverPid] = process.argv.slice(2);
let offset = 0;

const serverAlive = () => { try { process.kill(Number(serverPid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Typing here does nothing; Ctrl+C does not close it either. The window goes with its server.
process.on('SIGINT', () => {});

setInterval(() => {
  let size;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size > offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    process.stdout.write(buf);
  }
  if (!serverAlive()) process.exit(0);
}, 200);
