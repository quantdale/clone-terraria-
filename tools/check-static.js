'use strict';
// tools/check-static.js — D1-alt static gate (sandboxed, zero new deps).
// Runs TypeScript in --checkJs filtered mode over js/ and packs/ and fails on
// the two proven signal classes: TS2304 for any name other than the dynamic
// `TC` global, and TS2393 duplicate function implementations. All other codes
// are treated as known noise and excluded from the decision.
//
// Modes: report-only (default, exit 0, prints the full finding list) and
// --enforce (exit 1 when any signal-class finding remains). The gate is
// flipped to enforcing in the same campaign phase that lands the two
// findings' owning fixes (fix-ui-chest-quick-move-crash,
// enforce-gamerng-replicated-loot, world.js canShape dedup).

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const enforce = process.argv.includes('--enforce');

const tscBin = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
const res = spawnSync(tscBin, ['-p', 'tsconfig.check.json'], {
  cwd: root,
  encoding: 'utf8',
  shell: true,
});

const lines = String(res.stdout || '').split(/\r?\n/).filter(Boolean);

const SIGNAL_CODES = new Set(['TS2393']);
function isSignal(line) {
  const m = line.match(/error (TS\d+): (.*)$/);
  if (!m) return false;
  const [, code, msg] = m;
  if (SIGNAL_CODES.has(code)) return true;
  if (code === 'TS2304' && !/Cannot find name 'TC'\./.test(msg)) return true;
  return false;
}

const signals = lines.filter(isSignal);
const noise = lines.filter((l) => !isSignal(l));

console.log(`check-static: ${lines.length} diagnostics total, ${signals.length} signal(s).`);
if (noise.length) {
  console.log('noise (excluded) by code:');
  const byCode = {};
  for (const l of noise) {
    const m = l.match(/error (TS\d+)/);
    const c = m ? m[1] : 'other';
    byCode[c] = (byCode[c] || 0) + 1;
  }
  for (const [c, n] of Object.entries(byCode).sort()) console.log(`  ${c}: ${n}`);
}
if (signals.length) {
  console.log('signal findings:');
  for (const l of signals) console.log('  ' + l);
}

if (enforce && signals.length) {
  console.error(`check-static: FAIL (${signals.length} signal finding(s))`);
  process.exit(1);
}
console.log(enforce ? 'check-static: pass (no signal findings)' : 'check-static: report-only (exit 0)');
