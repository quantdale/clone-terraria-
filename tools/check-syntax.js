/* tools/check-syntax.js — static gate: node --check equivalent for every js file. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
}
walk(path.join(root, 'js'));
for (const f of fs.readdirSync(root)) {
  if (/^(tmp_|_smoke_|\.magic-)/.test(f) && f.endsWith('.js')) files.push(path.join(root, f));
}

let failed = 0;
for (const f of files) {
  try {
    new Function(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    // new Function wraps in a function body; real parse errors still throw.
    console.error('SYNTAX FAIL', path.relative(root, f), '-', e.message);
    failed++;
  }
}
console.log(`checked ${files.length} files, ${failed} failures`);
process.exit(failed ? 1 : 0);
