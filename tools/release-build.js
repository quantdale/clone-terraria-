/* tools/release-build.js - reproducible production build.
   The game ships as plain static files (no bundler by design), so a release
   is a verified assembly of exactly what index.html references:

     dist/
       index.html        copied verbatim (relative paths resolve as-is)
       css/… js/…        copied verbatim
       build.json        {version, commit} provenance stamp

   Gates enforced here (build fails loudly):
     - every <script src> / <link href> / <img src> in index.html resolves
     - every shipped .js passes `node --check`
     - output is byte-identical across rebuilds of the same commit
       (no wall-clock stamps: provenance is version + HEAD sha only). */

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function headSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT })
      .toString()
      .trim();
  } catch (e) {
    return 'unknown';
  }
}

// Collect local asset references from index.html (src/href attributes that
// are relative paths, i.e. everything we ship).
function referencedAssets(html) {
  const refs = [];
  const attr = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = attr.exec(html)) !== null) {
    const ref = m[1];
    if (/^(https?:)?\/\//i.test(ref)) continue; // external URL
    if (ref.startsWith('#') || /^(mailto|data):/i.test(ref)) continue;
    refs.push(ref.split('#')[0].split('?')[0]);
  }
  return refs;
}

function copyFile(rel) {
  const src = path.join(ROOT, rel);
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const htmlPath = path.join(ROOT, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const refs = referencedAssets(html);

  // 1) every referenced asset must exist in the repo
  const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (missing.length) {
    console.error('BUILD FAILED - index.html references missing files:');
    for (const m of missing) console.error('  ' + m);
    process.exit(1);
  }

  // 2) clean assemble
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  copyFile('index.html');
  for (const r of refs) copyFile(r);

  // favicon may be referenced implicitly by browsers even without a tag hit
  if (fs.existsSync(path.join(ROOT, 'favicon.ico'))) copyFile('favicon.ico');

  // 3) every shipped .js must parse
  const jsDir = path.join(DIST, 'js');
  const shipped = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) shipped.push(p);
    }
  };
  if (fs.existsSync(jsDir)) walk(jsDir);
  for (const f of shipped) {
    // node --check against the ORIGINAL file path semantics: run on the copy
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
  }

  // 4) provenance stamp (no wall clock: same commit -> identical bytes)
  const stamp = { version: pkg.version, commit: headSha() };
  fs.writeFileSync(
    path.join(DIST, 'build.json'),
    JSON.stringify(stamp, null, 2) + '\n'
  );

  console.log(
    `build OK -> dist/ (${shipped.length} js files, ${refs.length} referenced assets)` +
      ` version=${stamp.version} commit=${stamp.commit.slice(0, 10)}`
  );
}

main();
