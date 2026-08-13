// Policy checks, not correctness checks.
//
// This repo is public. It can only be public because it needs no vendor
// firmware and no vendor key: the user supplies their own .img, and the loader
// this tool pushes over USB is extracted from that file in the browser at run
// time. The moment a MiniLoaderAll.bin or a factory image gets committed here,
// that stops being true — so the test suite says so out loud.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('no vendor firmware is committed', () => {
  const banned = new Set(['.img', '.fw', '.bin', '.zip']);
  const found = walk(ROOT)
    .filter((p) => banned.has(extname(p).toLowerCase()))
    .map((p) => p.slice(ROOT.length));
  assert.deepEqual(found, [], `vendor payload committed: ${found.join(', ')}`);
});

test('nothing large is committed', () => {
  // A loader blob is ~190 KB and a rootfs is gigabytes. Nothing this repo needs
  // comes close, so a big file is a mistake worth catching early.
  const big = walk(ROOT)
    .map((p) => [p.slice(ROOT.length), statSync(p).size])
    .filter(([, size]) => size > 256 * 1024);
  assert.deepEqual(big, [], `unexpectedly large files: ${big.map(([p, s]) => `${p} (${s})`).join(', ')}`);
});

test('the page carries the AI-assistance disclaimer', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /Built with AI assistance/i);
  assert.match(html, /[Nn]ot affiliated with/);
});

test('the page warns that flashing destroys the unit identity', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /userdata/, 'says what is lost');
  assert.match(html, /factory/i, 'says it restores factory state');
});
