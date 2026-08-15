import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGpt, parseGpt } from '../public/gpt.js';
import { buildPartitionPlan, guessPartition, PROTECTED } from '../public/partwrite.js';
import { verifyPlan, findReadCeiling } from '../public/plan.js';

// The PLAY's factory layout, from parameter.txt. Sectors of 512 bytes.
const PLAY = [
  { name: 'uboot', startSector: 0x4000, sectors: 0x2000, grow: false },
  { name: 'trust', startSector: 0x6000, sectors: 0x2000, grow: false },
  { name: 'misc', startSector: 0x8000, sectors: 0x2000, grow: false },
  { name: 'boot', startSector: 0xa000, sectors: 0x20000, grow: false },
  { name: 'recovery', startSector: 0x2a000, sectors: 0x20000, grow: false },
  { name: 'backup', startSector: 0x4a000, sectors: 0x10000, grow: false },
  { name: 'oem', startSector: 0x5a000, sectors: 0x20000, grow: false },
  { name: 'rootfs', startSector: 0x7a000, sectors: 0x700000, grow: false },
  { name: 'userdata', startSector: 0x77a000, sectors: null, grow: true },
];
const DISK_SECTORS = 15269888;

const deviceParts = () => parseGpt(buildGpt(PLAY, DISK_SECTORS).master);
const blob = (n) => new Blob([new Uint8Array(n)]);

test('a GPT written by this tool reads back as the same table', () => {
  const parts = deviceParts();
  const boot = parts.find((p) => p.name === 'boot');
  const rootfs = parts.find((p) => p.name === 'rootfs');
  assert.equal(boot.firstLba, 0xa000);
  assert.equal(boot.sectors, 0x20000);
  assert.equal(rootfs.firstLba, 0x7a000);
  assert.equal(rootfs.sectors, 0x700000);
  // The grow partition ends at the last usable sector, not at a declared size.
  assert.equal(parts.find((p) => p.name === 'userdata').lastLba, DISK_SECTORS - 34);
});

test('a corrupt header is refused rather than parsed', () => {
  const g = buildGpt(PLAY, DISK_SECTORS).master;
  g[512 + 40] ^= 0xff;                       // flip a byte inside the header
  assert.throws(() => parseGpt(g), /checksum/);
});

test('a plan aims at the sectors the device reports', () => {
  const plan = buildPartitionPlan(deviceParts(), [
    { partition: 'rootfs', blob: blob(1024) },
    { partition: 'boot', blob: blob(2048) },
  ]);
  // Sorted by sector, so boot comes first even though rootfs was listed first.
  assert.deepEqual(plan.ops.map((o) => o.name), ['boot', 'rootfs']);
  assert.equal(plan.ops[0].startSector, 0xa000);
  assert.equal(plan.ops[1].startSector, 0x7a000);
  assert.equal(plan.totalSectors, 4 + 2);
});

test('a file larger than its partition is refused', () => {
  const tooBig = blob(0x20000 * 512 + 1);
  assert.throws(
    () => buildPartitionPlan(deviceParts(), [{ partition: 'boot', blob: tooBig }]),
    /does not fit/,
  );
});

test('a file exactly filling its partition is allowed', () => {
  const exact = blob(0x20000 * 512);
  const plan = buildPartitionPlan(deviceParts(), [{ partition: 'boot', blob: exact }]);
  assert.equal(plan.ops[0].sectors, 0x20000);
});

test('the partitions that are the way back are refused by default', () => {
  for (const name of PROTECTED) {
    assert.throws(
      () => buildPartitionPlan(deviceParts(), [{ partition: name, blob: blob(512) }]),
      /way back|recovered/,
      `${name} should be protected`,
    );
  }
});

test('the override is what makes a protected write possible', () => {
  const plan = buildPartitionPlan(
    deviceParts(),
    [{ partition: 'uboot', blob: blob(512) }],
    { allowProtected: true },
  );
  assert.equal(plan.ops[0].name, 'uboot');
});

test('a partition this device does not have is refused, and says what it has', () => {
  assert.throws(
    () => buildPartitionPlan(deviceParts(), [{ partition: 'system', blob: blob(512) }]),
    /no partition called "system".*rootfs/s,
  );
});

test('two files cannot target one partition', () => {
  assert.throws(
    () => buildPartitionPlan(deviceParts(), [
      { partition: 'boot', blob: blob(512) },
      { partition: 'boot', blob: blob(512) },
    ]),
    /both assigned/,
  );
});

test('polecat filenames pre-select the right partitions', () => {
  const parts = deviceParts();
  assert.equal(guessPartition('polecat-boot.img', parts), 'boot');
  assert.equal(guessPartition('polecat-rootfs.ext4', parts), 'rootfs');
  // "recovery" must not be matched by a shorter name that is a substring of it.
  assert.equal(guessPartition('polecat-recovery.img', parts), 'recovery');
  assert.equal(guessPartition('something-else.bin', parts), null);
});

// --- read ceiling ------------------------------------------------------------
//
// A PLAY returns 0xCC fill instead of data at and above sector 0x10000, through
// every loader tried. Verification that does not know this reports thousands of
// mismatches for a write that was probably fine.

test('a device that returns fill above a sector reports that sector as its ceiling', async () => {
  const CEIL = 0x10000;
  const fake = {
    async readLba(sector) {
      return new Uint8Array(512).fill(sector >= CEIL ? 0xcc : 0x42);
    },
  };
  // Ascending probes: uboot and misc read fine, recovery is the first fill.
  assert.equal(await findReadCeiling(fake, [0x4000, 0x8000, 0x2a000, 0x5a000]), 0x2a000);
});

test('a device that reads properly everywhere has no ceiling', async () => {
  const fake = { async readLba() { return new Uint8Array(512).fill(0x42); } };
  assert.equal(await findReadCeiling(fake, [0x4000, 0x2a000]), null);
});

test('a partition that cannot be read is reported as unverified, not as a mismatch', async () => {
  const CEIL = 0x10000;
  const payload = new Uint8Array(13 << 20).fill(0x11);   // 13 MiB: crosses 0x10000
  const parts = deviceParts();
  const plan = buildPartitionPlan(parts, [{ partition: 'boot', blob: new Blob([payload]) }]);
  const fake = {
    async readLba(sector, count) {
      // Correct data below the ceiling, fill above — exactly the PLAY's behaviour.
      return new Uint8Array(count * 512).fill(sector >= CEIL ? 0xcc : 0x11);
    },
  };
  const { mismatches, skipped } = await verifyPlan(fake, plan, { readCeiling: CEIL });
  assert.deepEqual(mismatches, [], 'nothing above the ceiling should be called a mismatch');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].op, 'boot');
  assert.equal(skipped[0].fromSector, CEIL);
});

test('without a ceiling, the same device produces a wall of false mismatches', async () => {
  // The old behaviour, kept as a test so the regression is visible if the
  // ceiling handling is ever removed.
  const CEIL = 0x10000;
  const payload = new Uint8Array(13 << 20).fill(0x11);   // 13 MiB: crosses 0x10000
  const plan = buildPartitionPlan(deviceParts(), [{ partition: 'boot', blob: new Blob([payload]) }]);
  const fake = {
    async readLba(sector, count) {
      return new Uint8Array(count * 512).fill(sector >= CEIL ? 0xcc : 0x11);
    },
  };
  const { mismatches } = await verifyPlan(fake, plan, { readCeiling: null });
  assert.ok(mismatches.length > 0, 'this is what the PLAY produced: mismatches for good data');
});
