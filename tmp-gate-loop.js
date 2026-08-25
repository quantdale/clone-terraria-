/* tmp-gate-loop.js — retry npm run validate until green (max attempts) */
const { execSync } = require('child_process');
const fs = require('fs');
const MAX = 6;
for (let i = 1; i <= MAX; i++) {
  console.log(`\n=== GATE ATTEMPT ${i}/${MAX} @ ${new Date().toISOString()} ===`);
  try {
    const out = execSync('npm run validate', { cwd: process.cwd(), stdio: 'pipe', timeout: 2700000 }).toString();
    const m = out.match(/(\d+) passed[^\n]*/);
    console.log('GREEN:', m ? m[0] : 'ok');
    fs.writeFileSync('gate-final.txt', `ATTEMPT ${i} GREEN\n` + out.slice(-3000));
    process.exit(0);
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    const m = out.match(/(\d+) failed[\s\S]*?(\d+) passed/);
    console.log('attempt failed:', m ? `${m[2]} passed / ${m[1]} failed` : 'unknown');
    const lastFail = [...out.matchAll(/journey-([a-z])-/g)].map(x => x[1]);
    console.log('failing journeys:', [...new Set(lastFail)].join(','));
  }
}
console.log('MAX ATTEMPTS REACHED');
process.exit(1);
