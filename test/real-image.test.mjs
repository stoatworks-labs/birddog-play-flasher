// End-to-end plan build against genuine vendor files.
//
// Skipped unless PLAY_IMG (and, for the injection half, PLAY_FW) point at
// copies on the machine running the tests. Those files are BirdDog's firmware:
// they are never committed here and CI never sees them, so this test is a local
// gate rather than a CI one. Everything CI can prove is proved elsewhere.
//
//   PLAY_IMG=~/Downloads/PLAY_1.0.30.img PLAY_FW=~/…/BirdDog_PLAY-1.0.34.fw npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openAsBlob, mkdtempSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRkfw, readLoader, findPartition } from '../public/rkfw.js';
import { parseRkBoot, ENTRY471, ENTRY472 } from '../public/rkboot.js';
import { buildPlan } from '../public/plan.js';
import { SECTOR_SIZE } from '../public/rockusb.js';

const IMG = process.env.PLAY_IMG;
const FW = process.env.PLAY_FW;
const DISK_SECTORS = 15_269_888;

const E2FSCK = ['/opt/homebrew/opt/e2fsprogs/sbin/e2fsck', '/usr/sbin/e2fsck', 'e2fsck']
  .find((p) => { try { execFileSync(p, ['-V'], { stdio: 'pipe' }); return true; } catch (e) { return e.code !== 'ENOENT'; } });

test('the factory image parses', { skip: !IMG && 'set PLAY_IMG' }, async () => {
  const fw = await parseRkfw(await openAsBlob(IMG));
  assert.equal(fw.model, 'RK3328');
  assert.equal(fw.chip, 'H223');

  const names = fw.partitions.map((p) => p.name);
  for (const n of ['parameter', 'uboot', 'trust', 'boot', 'rootfs', 'oem', 'userdata:grow']) {
    assert.ok(names.includes(n), `${n} is present`);
  }
  // package-file and bootloader are metadata: flashing them anywhere would be a
  // bug, and 0xFFFFFFFF is how the container says so.
  assert.equal(findPartition(fw, 'package-file').flashed, false);
  assert.equal(findPartition(fw, 'bootloader').flashed, false);
  assert.equal(findPartition(fw, 'backup').flashed, false, 'backup is RESERVED');
});

test('the loader carries the entries maskrom needs', { skip: !IMG && 'set PLAY_IMG' }, async () => {
  const fw = await parseRkfw(await openAsBlob(IMG));
  const boot = parseRkBoot(await readLoader(fw));
  assert.equal(boot.chip, 'H223');
  assert.ok(boot.entries.some((e) => e.type === ENTRY471), 'has a DDR init entry');
  assert.ok(boot.entries.some((e) => e.type === ENTRY472), 'has a loader entry');
  for (const e of boot.entries) assert.ok(e.data.length > 0, `${e.name} has data`);
});

test('a plain flash plan covers the device without overlapping', { skip: !IMG && 'set PLAY_IMG' }, async () => {
  const fw = await parseRkfw(await openAsBlob(IMG));
  const plan = await buildPlan(fw, { diskSectors: DISK_SECTORS });

  assert.equal(plan.ops[0].name, 'gpt');
  assert.equal(plan.ops[1].name, 'gpt-backup');
  assert.ok(!plan.ops.some((o) => o.name === 'parameter'),
    'parameter.txt is turned into a GPT, never written raw to sector 0');

  assertNoOverlap(plan.ops);
  for (const op of plan.ops) {
    assert.ok(op.startSector + op.sectors <= DISK_SECTORS, `${op.name} fits the device`);
  }
});

test('an injected plan patches the rootfs and parks the package in the tail', { skip: (!IMG || !FW) && 'set PLAY_IMG and PLAY_FW' }, async () => {
  const fw = await parseRkfw(await openAsBlob(IMG));
  const pkg = await openAsBlob(FW);
  const plan = await buildPlan(fw, { diskSectors: DISK_SECTORS, packageBlob: pkg });

  assertNoOverlap(plan.ops);

  const rootfsOp = plan.ops.find((o) => o.name === 'rootfs');
  const pkgOp = plan.ops.find((o) => o.name === 'package');
  assert.ok(rootfsOp.patches?.length, 'rootfs carries filesystem patches');
  assert.equal(pkgOp.byteLength, pkg.size);

  // The package must land inside the rootfs partition but past its filesystem.
  const rootfsPart = plan.param.partitions.find((p) => p.name === 'rootfs');
  const partStart = rootfsOp.startSector;
  assert.ok(pkgOp.startSector >= partStart + plan.injection.fsSectors, 'package starts past the filesystem');
  assert.ok(pkgOp.startSector + pkgOp.sectors <= partStart + rootfsPart.sectors,
    'package stays inside the rootfs partition');

  // And it must not collide with userdata, which is the next thing along.
  const userdata = plan.ops.find((o) => o.name === 'userdata:grow');
  assert.ok(pkgOp.startSector + pkgOp.sectors <= userdata.startSector, 'package clears userdata');
});

test('the patched rootfs is a filesystem e2fsck accepts', { skip: (!IMG || !FW || !E2FSCK) && 'set PLAY_IMG and PLAY_FW' }, async (t) => {
  const fw = await parseRkfw(await openAsBlob(IMG));
  const plan = await buildPlan(fw, { diskSectors: DISK_SECTORS, packageBlob: await openAsBlob(FW) });
  const op = plan.ops.find((o) => o.name === 'rootfs');

  // Materialise exactly what the flasher would push, patches and all.
  const dir = mkdtempSync(join(tmpdir(), 'bdreal-'));
  const out = join(dir, 'rootfs.img');
  const fd = openSync(out, 'w');
  const CHUNK = 8 << 20;
  for (let off = 0; off < op.byteLength; off += CHUNK) {
    const len = Math.min(CHUNK, op.byteLength - off);
    const buf = new Uint8Array(await op.blob.slice(off, off + len).arrayBuffer());
    for (const p of op.patches) {
      const end = p.offset + p.bytes.length;
      if (end <= off || p.offset >= off + len) continue;
      buf.set(p.bytes, p.offset - off);
    }
    writeSync(fd, buf, 0, buf.length, off);
  }
  closeSync(fd);

  execFileSync(E2FSCK, ['-fn', out], { stdio: 'pipe' });
  t.diagnostic(`patched ${op.patches.length} blocks in a ${op.byteLength} byte rootfs`);
});

function assertNoOverlap(ops) {
  const ranges = ops
    .map((o) => ({ name: o.name, from: o.startSector, to: o.startSector + o.sectors }))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i].from >= ranges[i - 1].to,
      `${ranges[i].name} (${ranges[i].from}) overlaps ${ranges[i - 1].name} (ends ${ranges[i - 1].to})`);
  }
}
