'use strict';
// tools/check-rng.js — W23 replicated-truth randomness guard.
// Scans js/ for `Math.random(` call sites. Each site must be covered by a
// call-site allowlist entry (file + line pattern + justification). The
// allowlist is per-call-site, not per-file: a new bare `Math.random(` in an
// already-listed file still fails unless it carries its own entry.
//
// Report-only by default (prints findings, exit 0); --enforce exits 1 on any
// unlisted site. The js/loot.js pot-roll violation is intentionally NOT
// allowlisted: it must show up here until enforce-gamerng-replicated-loot
// lands, then the guard goes quiet.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'js');
const enforce = process.argv.includes('--enforce');

// Each entry: file, a substring that locates the call site (trimmed line
// content), and the justification.
const ALLOWLIST = [
  { file: 'js/particles.js', site: 'Math.random() * Math.PI * 2', why: 'particle effect direction roll' },
  { file: 'js/particles.js', site: 'Math.random() * 0.65', why: 'particle speed jitter' },
  { file: 'js/particles.js', site: 'Math.random() * 0.7', why: 'particle life jitter' },
  { file: 'js/particles.js', site: 'Math.random() * 0.6', why: 'particle size jitter' },
  { file: 'js/particles.js', site: 'Math.random() * colors.length', why: 'particle color pick' },
  { file: 'js/accessories.js', site: 'cx + (Math.random() - 0.5)', why: 'visual sparkle x offset' },
  { file: 'js/accessories.js', site: 'top + Math.random() * hh', why: 'visual sparkle y offset' },
  { file: 'js/accessories.js', site: '(Math.random() - 0.5) * 14', why: 'visual sparkle vx jitter' },
  { file: 'js/accessories.js', site: '-26 - Math.random() * 22', why: 'visual sparkle vy jitter' },
  { file: 'js/accessories.js', site: '0.5 + Math.random() * 0.3', why: 'visual sparkle size jitter' },
  { file: 'js/accessories.js', site: 'd.parts[(Math.random() * d.parts.length) | 0]', why: 'visual sparkle part pick' },
  { file: 'js/audio.js', site: 'd[i] = Math.random() * 2 - 1', why: 'noise burst buffer synthesis' },
  { file: 'js/music.js', site: 'd[i] = Math.random() * 2 - 1', why: 'noise bed synthesis' },
  { file: 'js/music.js', site: 'ARP[(Math.random() * ARP.length) | 0]', why: 'generative arpeggio pick' },
  { file: 'js/music.js', site: 'const r = Math.random();', why: 'generative arpeggio roll' },
  { file: 'js/music.js', site: 'BELLS[(Math.random() * BELLS.length) | 0]', why: 'generative bell pick' },
  { file: 'js/music.js', site: 'if (Math.random() < 0.25) m -= 12;', why: 'generative anchor-tone roll' },
  { file: 'js/music.js', site: 'PHRYGIAN[(Math.random() * PHRYGIAN.length) | 0]', why: 'generative phrygian pick' },
  { file: 'js/music.js', site: 'Math.random() * 1.5', why: 'noise bed slice offset' },
  { file: 'js/music.js', site: '+ Math.random() * 4;', why: 'generative bell timing' },
  { file: 'js/music.js', site: '+ Math.random() * 2.8;', why: 'generative dune timing' },
  { file: 'js/magic.js', site: '(Math.random() - 0.5) * b.size', why: 'magic bolt trail sparkle offset' },
  { file: 'js/magic.js', site: '0.22 + Math.random() * 0.12', why: 'magic bolt trail sparkle life' },
  { file: 'js/magic.js', site: 'b.colors[(Math.random() * b.colors.length) | 0]', why: 'magic bolt trail color pick' },
  { file: 'js/magic.js', site: 'Math.random() * TAU', why: 'meteor visual radius roll' },
  { file: 'js/magic.js', site: '44 + Math.random() * 44', why: 'meteor visual radius roll' },
  { file: 'js/biomes.js', site: 'const r = Math.random;', why: 'ambient weather particle rolls' },
  { file: 'js/player.js', site: 'Math.random() * 3', why: 'visual-only blink timer' },
  { file: 'js/projectiles.js', site: 'Math.random() < 0.35', why: 'glowing-trail visual throttle' },
  { file: 'js/combat.js', site: ': Math.random);', why: 'legacy fallback only when TC.GameRng is absent; seeded stream wins' },
  { file: 'js/lootables.js', site: ': Math.random();', why: 'legacy fallback only when TC.GameRng is absent; seeded stream wins' },
  { file: 'js/main.js', site: '(Math.random() * 2147483647) | 0', why: 'title-screen new-world seed selection' },
  { file: 'js/ui.js', site: '(Math.random() * 2147483647) | 0', why: 'new-world seed selection' },
];

function scanFile(filePath, rel) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  lines.forEach((line, i) => {
    if (!/Math\.random\s*\(/.test(line)) return;
    const allowed = ALLOWLIST.some(
      (a) => a.file === rel && line.includes(a.site)
    );
    if (!allowed) findings.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return findings;
}

const files = fs.readdirSync(root)
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(root, f));
const findings = [];
for (const f of files) findings.push(...scanFile(f, path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/')));

if (findings.length) {
  console.log(`check-rng: ${findings.length} unlisted Math.random call site(s):`);
  for (const f of findings) console.log('  ' + f);
} else {
  console.log('check-rng: all Math.random call sites covered by the audited allowlist.');
}
if (enforce && findings.length) {
  console.error(`check-rng: FAIL (${findings.length} unlisted site(s))`);
  process.exit(1);
}
console.log(enforce ? 'check-rng: pass' : 'check-rng: report-only (exit 0)');
