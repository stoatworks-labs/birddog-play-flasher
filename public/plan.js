// Turning a parsed .img (plus an optional .fw) into an ordered list of writes,
// and executing it against a device in loader mode.
//
// Nothing here holds more than a few MB: partition contents stay in the Blob
// until the moment they are pushed to USB, and filesystem edits ride along as
// sparse patches applied to each chunk in flight. That is what lets a 2.4 GB
// image be flashed from a browser tab.

import { partitionBlob, findPartition, parseParameter } from './rkfw.js';
import { buildGpt, parseUuidLines } from './gpt.js';
import { planInjection } from './inject.js';
import { SECTOR_SIZE, SECTORS_PER_TRANSFER } from './rockusb.js';

const READ_AHEAD = 4 << 20;

/**
 * @param {object} fw            from parseRkfw()
 * @param {object} opts
 * @param {number} opts.diskSectors  device size, from READ_FLASH_INFO
 * @param {Blob=}  opts.packageBlob  a .fw to inject
 */
export async function buildPlan(fw, { diskSectors, packageBlob = null }) {
  const paramPart = findPartition(fw, 'parameter');
  if (!paramPart) throw new Error('image has no parameter partition');
  const paramText = new TextDecoder('latin1').decode(
    new Uint8Array(await partitionBlob(fw, paramPart).arrayBuffer()),
  );
  const param = parseParameter(paramText);
  if (!param.partitions.length) throw new Error('parameter.txt carries no partition table');

  const ops = [];
  const notes = [];

  // parameter.txt is NOT written raw. Its RKAF entry claims sector 0, but on a
  // GPT device that is where the protective MBR belongs — the vendor tool turns
  // the mtdparts line into a partition table instead.
  if ((param.TYPE || '').toUpperCase() === 'GPT') {
    const gpt = buildGpt(param.partitions, diskSectors, parseUuidLines(paramText));
    ops.push({ name: 'gpt', startSector: 0, bytes: gpt.master });
    ops.push({ name: 'gpt-backup', startSector: gpt.backupSector, bytes: gpt.backup });
  } else {
    throw new Error(`unsupported partition table type ${param.TYPE}`);
  }

  let injection = null;
  if (packageBlob) {
    const rootfs = findPartition(fw, 'rootfs');
    const rootfsParam = param.partitions.find((p) => p.name === 'rootfs');
    if (!rootfs || !rootfsParam) throw new Error('image has no rootfs partition to inject into');
    injection = await planInjection(
      partitionBlob(fw, rootfs), rootfsParam.sectors, packageBlob.size,
    );
    notes.push(
      `package: ${packageBlob.size} bytes at rootfs+${injection.relativeSector} `
      + `(${injection.spareSectors - injection.payloadSectors} sectors still spare)`,
      `filesystem: ${injection.patches.length} blocks patched`,
    );
  }

  for (const part of fw.partitions) {
    if (!part.flashed || part.name === 'parameter') continue;
    const op = {
      name: part.name,
      startSector: part.flashAddr,
      blob: partitionBlob(fw, part),
    };
    if (injection && part.name === 'rootfs') op.patches = injection.patches;
    ops.push(op);
  }

  if (injection) {
    const rootfs = findPartition(fw, 'rootfs');
    ops.push({
      name: 'package',
      startSector: rootfs.flashAddr + injection.relativeSector,
      blob: packageBlob,
    });
  }

  for (const op of ops) {
    op.byteLength = op.bytes ? op.bytes.length : op.blob.size;
    op.sectors = Math.ceil(op.byteLength / SECTOR_SIZE);
  }
  const totalSectors = ops.reduce((n, o) => n + o.sectors, 0);
  return { ops, param, injection, notes, totalSectors };
}

/** Overwrite the parts of `chunk` covered by patches. Offsets are op-relative. */
function applyPatches(chunk, chunkStart, patches) {
  if (!patches) return chunk;
  const chunkEnd = chunkStart + chunk.length;
  for (const p of patches) {
    const end = p.offset + p.bytes.length;
    if (end <= chunkStart || p.offset >= chunkEnd) continue;
    const from = Math.max(p.offset, chunkStart);
    const to = Math.min(end, chunkEnd);
    chunk.set(p.bytes.subarray(from - p.offset, to - p.offset), from - chunkStart);
  }
  return chunk;
}

/**
 * How far up the device can actually be read back.
 *
 * MEASURED ON A PLAY, 2026-08-15: reads at or above absolute sector 0x10000
 * return solid 0xCC — a fill pattern, not data — through both u-boot's rockusb
 * and Rockchip's own usbplug loader. This is not speculation about our own
 * writes: `recovery` and `oem` are FACTORY partitions that were never written
 * by this tool, they certainly contain data, and they read as 0xCC too, while
 * `uboot` below the boundary reads its real content.
 *
 * Verification that ignores this is worse than no verification. It reported
 * 57,702 mismatches on a write that was very likely fine, and read as "your
 * flash failed" when it meant "this device cannot be read back that far".
 *
 * So: probe it, and say so.
 */
const FILL_BYTE = 0xcc;

function isFill(bytes) {
  if (!bytes || !bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== FILL_BYTE) return false;
  return true;
}

/**
 * Find the sector above which read-back stops returning real data, by reading
 * regions the caller knows are populated. Returns null when reads are good
 * everywhere probed.
 *
 * `known` is a list of absolute sectors that must contain something — factory
 * partitions are ideal, because their content is not ours to have got wrong.
 */
export async function findReadCeiling(rk, known) {
  for (const sector of known) {
    let data;
    try {
      data = await rk.readLba(sector, 1);
    } catch {
      return sector;      // cannot even read it: treat as the ceiling
    }
    if (isFill(data)) return sector;
  }
  return null;
}

/**
 * Execute a plan. onProgress({op, sectorsDone, totalDone, totalSectors}).
 */
export async function runPlan(rk, plan, { onProgress = () => {}, signal } = {}) {
  let totalDone = 0;
  const chunkBytes = SECTORS_PER_TRANSFER * SECTOR_SIZE;

  for (const op of plan.ops) {
    let written = 0;
    while (written < op.byteLength) {
      if (signal?.aborted) throw new Error('cancelled');
      const readLen = Math.min(READ_AHEAD, op.byteLength - written);
      const buf = op.bytes
        ? op.bytes.subarray(written, written + readLen)
        : new Uint8Array(await op.blob.slice(written, written + readLen).arrayBuffer());

      for (let off = 0; off < buf.length; off += chunkBytes) {
        if (signal?.aborted) throw new Error('cancelled');
        const raw = buf.subarray(off, Math.min(buf.length, off + chunkBytes));
        // The device only takes whole sectors; the tail of the last partition
        // chunk is zero-padded rather than short-written.
        const padded = raw.length % SECTOR_SIZE === 0
          ? new Uint8Array(raw)
          : (() => {
            const p = new Uint8Array(Math.ceil(raw.length / SECTOR_SIZE) * SECTOR_SIZE);
            p.set(raw);
            return p;
          })();
        applyPatches(padded, written + off, op.patches);
        const sector = op.startSector + (written + off) / SECTOR_SIZE;
        await rk.writeLba(sector, padded);

        const done = padded.length / SECTOR_SIZE;
        totalDone += done;
        onProgress({ op, sectorsDone: (written + off) / SECTOR_SIZE + done, totalDone, totalSectors: plan.totalSectors });
      }
      written += readLen;
    }
  }
  return totalDone;
}

/**
 * Read back and compare. Optional, and slow — but this is a recovery tool, and
 * "it flashed fine" from a tool that never looked is worth very little.
 */
export async function verifyPlan(rk, plan, { onProgress = () => {}, sampleOnly = false, readCeiling = null } = {}) {
  const mismatches = [];
  const skipped = [];
  const chunkBytes = SECTORS_PER_TRANSFER * SECTOR_SIZE;
  let checked = 0;

  for (const op of plan.ops) {
    const limit = sampleOnly ? Math.min(op.byteLength, chunkBytes) : op.byteLength;
    for (let off = 0; off < limit; off += chunkBytes) {
      const len = Math.min(chunkBytes, limit - off);
      const expectRaw = op.bytes
        ? op.bytes.subarray(off, off + len)
        : new Uint8Array(await op.blob.slice(off, off + len).arrayBuffer());
      const expect = new Uint8Array(Math.ceil(len / SECTOR_SIZE) * SECTOR_SIZE);
      expect.set(expectRaw);
      applyPatches(expect, off, op.patches);

      const sectors = expect.length / SECTOR_SIZE;
      const at = op.startSector + off / SECTOR_SIZE;

      // Above the ceiling the device returns fill, so a comparison here would
      // manufacture a mismatch for data that may be perfectly written. Record
      // what could not be checked instead of pretending it failed.
      if (readCeiling !== null && at >= readCeiling) {
        skipped.push({ op: op.name, fromSector: at });
        break;
      }

      const got = await rk.readLba(at, sectors);
      for (let i = 0; i < expect.length; i++) {
        if (got[i] !== expect[i]) {
          mismatches.push({ op: op.name, byte: off + i });
          break;
        }
      }
      checked += sectors;
      onProgress({ op, checked });
    }
  }
  return { mismatches, skipped };
}
