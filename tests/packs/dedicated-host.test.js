'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'tools', 'mp-server.js');

test('dedicated host: pack options require values before startup', () => {
  for (const option of ['--packs', '--pack-file']) {
    const result = spawnSync(process.execPath, [SERVER, option], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(option + ' requires a value'));
  }
});

test('dedicated host: oversized local manifest is rejected before startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pack-host-'));
  const file = path.join(dir, 'oversized.json');
  try {
    fs.writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
    const result = spawnSync(process.execPath, [SERVER, '--pack-file', file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /exceeds 256 KiB or is not a file/);
    assert.doesNotMatch(result.stdout, /listening|world created/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
