// Proves the ext2 writer produces a filesystem that e2fsck accepts and that
// debugfs can read the injected files back out.
//
// The filesystem is built here by mke2fs with the same feature set as the
// PLAY's factory rootfs (ext2, 1 KiB blocks, 128-byte inodes, dir_index +
// filetype and nothing else), so this test needs no vendor firmware and runs
// in CI. The real 2.4 GB rootfs is exercised by real-image.test.mjs, which is
// skipped unless PLAY_IMG points at a copy.
//
// Our own reader agreeing with our own writer would prove nothing — e2fsck and
// debugfs are the independent judges here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planInjection } from '../public/inject.js';
import { Ext2 } from '../public/ext2.js';

const E2_PATHS = ['', '/opt/homebrew/opt/e2fsprogs/sbin/', '/usr/sbin/', '/sbin/'];

function tool(name) {
  for (const p of E2_PATHS) {
    try {
      execFileSync(`${p}${name}`, ['-V'], { stdio: 'pipe' });
      return `${p}${name}`;
    } catch (e) {
      // Ran but exited non-zero is fine; only "not there" disqualifies it.
      if (e.code !== 'ENOENT') return `${p}${name}`;
    }
  }
  return null;
}

const MKE2FS = tool('mke2fs');
const E2FSCK = tool('e2fsck');
const DEBUGFS = tool('debugfs');

// A 128 MiB partition holding a 32 MiB filesystem — the same shape as the real
// thing (3.5 GiB partition, 2.235 GiB filesystem), scaled down.
const SECTORS = 128 * 1024 * 2;
const PAYLOAD = 45_602_980;    // a real PLAY .fw is this big

function buildImage(dir) {
  const stage = join(dir, 'stage');
  for (const d of ['usr/local/bin', 'etc/systemd/system/multi-user.target.wants']) {
    mkdirSync(join(stage, d), { recursive: true });
  }
  writeFileSync(join(stage, 'etc/rc.local'), '#!/bin/sh -e\ncd /etc/init.d/\n./rcS\nexit 0\n');

  const img = join(dir, 'rootfs.img');
  writeFileSync(img, Buffer.alloc(0));
  execFileSync(MKE2FS, [
    '-q', '-t', 'ext2', '-b', '1024', '-I', '128',
    '-O', 'dir_index,filetype', '-O', '^sparse_super,^resize_inode',
    '-d', stage, img, '32768', // 32 MiB of 1 KiB blocks
  ]);
  return img;
}

test('injection produces a filesystem e2fsck accepts', { skip: !MKE2FS && 'e2fsprogs not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bdflash-'));
  const img = buildImage(dir);

  execFileSync(E2FSCK, ['-fn', img], { stdio: 'pipe' }); // baseline must be clean

  const plan = await planInjection(await openAsBlob(img), SECTORS, PAYLOAD);

  assert.ok(plan.relativeSector % 2048 === 0, 'payload is 1 MiB aligned');
  assert.ok(plan.relativeSector >= plan.fsSectors, 'payload starts past the filesystem');
  assert.ok(plan.payloadSectors <= plan.spareSectors, 'payload fits the partition tail');
  assert.ok(plan.patches.length > 0, 'something was actually written');

  const patched = join(dir, 'patched.img');
  copyFileSync(img, patched);
  const fd = openSync(patched, 'r+');
  for (const p of plan.patches) writeSync(fd, p.bytes, 0, p.bytes.length, p.offset);
  closeSync(fd);

  // e2fsck is the whole point of this test: bitmaps, counters, directory
  // structure and link counts all have to agree.
  const out = execFileSync(E2FSCK, ['-fn', patched], { stdio: 'pipe' }).toString();
  assert.match(out, /files.*blocks/, 'e2fsck reported a summary');

  const cat = (p) => execFileSync(DEBUGFS, ['-R', `cat ${p}`, patched], { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  const script = cat('/usr/local/bin/bd-inject.sh');
  assert.match(script, /^#!\/bin\/sh/, 'script has a shebang');
  assert.match(script, new RegExp(`SKIP=${plan.relativeSector}\\b`), 'script reads the right sector');
  assert.match(script, new RegExp(`BYTES=${PAYLOAD}\\b`), 'script reads the right length');
  assert.match(script, /reboot/, 'script reboots — the wrapper never restarts BirdDogRunner');

  const unit = cat('/etc/systemd/system/BirdDogInject.service');
  assert.match(unit, /ConditionPathExists=!\/userdata\/\.bd-inject-done/, 'unit is one-shot');

  const ls = execFileSync(DEBUGFS, ['-R', 'ls -l /etc/systemd/system/multi-user.target.wants', patched],
    { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  assert.match(ls, /BirdDogInject\.service/, 'unit is enabled via multi-user.target.wants');
  assert.match(ls, /120777/, 'the wants entry is a symlink');

  const stat = execFileSync(DEBUGFS, ['-R', 'stat /usr/local/bin/bd-inject.sh', patched],
    { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  assert.match(stat, /Mode:\s+0755/, 'script is executable');
  assert.match(stat, /User:\s+0\s+Group:\s+0/, 'script is root-owned');
});

test('a file too large for direct blocks is refused, not silently truncated', { skip: !MKE2FS && 'e2fsprogs not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bdflash-'));
  const img = buildImage(dir);
  const fs = await Ext2.open(await openAsBlob(img));
  await assert.rejects(
    () => fs.createFile('/usr/local/bin', 'big', new Uint8Array(13 * 1024)),
    /limit is/,
  );
});

test('an oversized package is refused rather than overrunning the partition', { skip: !MKE2FS && 'e2fsprogs not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bdflash-'));
  const img = buildImage(dir);
  const blob = await openAsBlob(img);
  await assert.rejects(
    () => planInjection(blob, 40 * 1024 * 2, 200 << 20),
    /only \d+ are free/,
  );
});
