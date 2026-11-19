// A dependency written as `latest` (or any moving tag) makes `bun install --frozen-lockfile` meaningless: the
// manifest and the lockfile disagree on what "installable" means, and typecheck can break on an unchanged commit.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('..', import.meta.url));
export const MOVING = /^(?:latest|next|canary|beta|dev|\*)$/;

export function manifests(dir = REPO) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...manifests(path));
    else if (entry.name === 'package.json') found.push(path);
  }
  return found;
}

export function unpinnedIn(manifest) {
  const json = JSON.parse(readFileSync(manifest, 'utf8'));
  const bad = [];
  for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(json[kind] || {})) {
      if (MOVING.test(String(version).trim())) bad.push(`${relative(REPO, manifest)}: ${kind}.${name} = ${version}`);
    }
  }
  return bad;
}

export function main() {
  const bad = manifests().flatMap(unpinnedIn);
  for (const line of bad) console.error(`unpinned: ${line}`);
  console.log(`${manifests().length} package.json files checked; ${bad.length} moving version(s).`);
  return bad.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main() ? 1 : 0;
}
