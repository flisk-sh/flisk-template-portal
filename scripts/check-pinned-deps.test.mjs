import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifests, MOVING, unpinnedIn } from './check-pinned-deps.mjs';

test('no manifest in this repo uses a moving version tag', () => {
  const found = manifests();
  assert.ok(found.length >= 2, 'expected the root and web manifests');
  assert.deepEqual(found.flatMap(unpinnedIn), []);
});

test('the guard flags latest in a dependency or devDependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinned-deps-'));
  const file = join(dir, 'package.json');
  writeFileSync(file, JSON.stringify({ devDependencies: { '@types/bun': 'latest' }, dependencies: { safe: '1.2.3' } }));
  const bad = unpinnedIn(file);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /devDependencies\.@types\/bun = latest$/);
  assert.ok(MOVING.test('next'));
  assert.ok(!MOVING.test('^5.6.0'));
});
