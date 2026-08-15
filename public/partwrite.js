// Writing individual partition images to a device, instead of a whole factory
// image.
//
// The whole-image path exists to put a unit back to factory. This one exists to
// put something else on it — a replacement OS writes only the partitions it
// owns and leaves the rest of the boot chain alone, so that the vendor's
// recovery path still works afterwards.
//
// Two rules shape everything here, and both are about not turning a reversible
// mistake into an irreversible one:
//
//  1. **Aim using the device's own GPT, never a hardcoded sector.** A number
//     copied out of a parameter file is right until it is pointed at a unit
//     that has already been reflashed, or is not a PLAY at all. Reading the
//     table off the device and matching by name makes the wrong device fail
//     harmlessly instead of getting a 3.5 GiB write at a plausible offset.
//  2. **Refuse the partitions that are the way back, by default.** `uboot`,
//     `trust` and `recovery` are what loader mode and the vendor's restore
//     depend on. A caller that genuinely means to replace them has to say so.
//
// DOM-free on purpose: the tests drive this in Node.

import { SECTOR_SIZE } from './rockusb.js';
import { parseGpt } from './gpt.js';

/** Partitions this tool will not write unless explicitly told to. */
export const PROTECTED = ['uboot', 'trust', 'recovery'];

/**
 * Read the partition table off a connected device.
 * @param {import('./rockusb.js').RockUsb} rk
 */
export async function readDeviceGpt(rk) {
  const bytes = await rk.readLba(0, 34);
  if (!bytes || bytes.length < 34 * SECTOR_SIZE) {
    throw new Error('short read while fetching the partition table');
  }
  return parseGpt(bytes);
}

/**
 * Turn {partition name -> file} into a plan runPlan() can execute.
 *
 * @param {{name:string,firstLba:number,sectors:number}[]} parts  from the device
 * @param {{partition:string, blob:Blob, label?:string}[]} assignments
 * @param {{allowProtected?:boolean}} opts
 * @returns {{ops:Array, notes:string[], totalSectors:number}}
 */
export function buildPartitionPlan(parts, assignments, { allowProtected = false } = {}) {
  if (!assignments.length) throw new Error('nothing to write');

  const byName = new Map(parts.map((p) => [p.name, p]));
  const ops = [];
  const notes = [];
  const seen = new Set();

  for (const a of assignments) {
    const part = byName.get(a.partition);
    if (!part) {
      throw new Error(
        `this device has no partition called "${a.partition}". `
        + `It has: ${parts.map((p) => p.name).join(', ')}`,
      );
    }
    if (seen.has(a.partition)) {
      throw new Error(`two files are both assigned to "${a.partition}"`);
    }
    seen.add(a.partition);

    if (!allowProtected && PROTECTED.includes(a.partition)) {
      throw new Error(
        `"${a.partition}" is part of how this device is recovered. `
        + `Writing it can leave no way back. Enable the override only if that is the intent.`,
      );
    }

    const capacity = part.sectors * SECTOR_SIZE;
    if (a.blob.size > capacity) {
      throw new Error(
        `${a.label || a.partition}: ${a.blob.size} bytes does not fit in "${a.partition}" `
        + `(${capacity} bytes). A larger write is silently truncated and the result does not boot.`,
      );
    }
    // Not an error — a filesystem image smaller than its partition is normal,
    // and so is a boot image half the size of the slot it lives in.
    const pct = Math.round((a.blob.size / capacity) * 100);
    notes.push(
      `${a.partition}: ${a.blob.size} bytes at sector 0x${part.firstLba.toString(16)} `
      + `(${pct}% of the partition)`,
    );

    ops.push({
      name: a.partition,
      startSector: part.firstLba,
      blob: a.blob,
      byteLength: a.blob.size,
      sectors: Math.ceil(a.blob.size / SECTOR_SIZE),
    });
  }

  // Low sectors first, so a plan reads in the order the device is laid out.
  ops.sort((x, y) => x.startSector - y.startSector);
  const totalSectors = ops.reduce((n, o) => n + o.sectors, 0);
  return { ops, notes, totalSectors };
}

/**
 * A guess at which partition a file is for, from its name. Only ever a
 * pre-selection for a human to confirm — never used to write unattended.
 */
export function guessPartition(filename, parts) {
  const f = filename.toLowerCase();
  const names = parts.map((p) => p.name);
  // Longest name first, so "recovery" is not matched by "rec" inside another.
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    if (f.includes(n)) return n;
  }
  if (/\.(ext[234]|img|bin)$/.test(f) && f.includes('root')) return names.includes('rootfs') ? 'rootfs' : null;
  return null;
}
