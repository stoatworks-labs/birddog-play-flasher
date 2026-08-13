// GPT construction from parameter.txt.
//
// parameter.txt says `TYPE: GPT`, and its RKAF entry claims a flash address of
// sector 0 — but the 523 bytes of parameter.txt are never written there. The
// vendor tool turns the mtdparts CMDLINE into a partition table and writes
// that instead. Writing the file raw to sector 0 would leave a device with no
// partition table at all, which is exactly the state this tool exists to undo.
//
// Ported from rkdeveloptool's create_gpt_buffer/prepare_gpt_backup. Two details
// are copied deliberately even though they look wrong:
//   - the partition TYPE guid is random per entry. Rockchip's u-boot and kernel
//     find partitions by name, and matching the vendor tool matters more than
//     tidiness;
//   - a `:grow` partition's ending LBA is the last usable sector, not its
//     declared size.

import { crc32 } from './crc.js';

export const SECTOR_SIZE = 512;
const GPT_ENTRIES = 128;
const GPT_ENTRY_SIZE = 128;
const HEADER_SIZE = 92;

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function randomUuid() {
  const b = randomBytes(16);
  b[7] = (b[7] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  return b;
}

/** "614e0000-0000-4b53-8000-1d28000054a9" -> 16 bytes, mixed-endian as GPT stores them. */
export function parseUuid(text) {
  const hex = text.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`bad uuid: ${text}`);
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  const swap = (a, z) => { for (let i = 0; i < (z - a + 1) >> 1; i++) { const t = b[a + i]; b[a + i] = b[z - i]; b[z - i] = t; } };
  swap(0, 3); swap(4, 5); swap(6, 7);
  return b;
}

/** uuid:<name>=<value> lines in parameter.txt, keyed by partition name. */
export function parseUuidLines(text) {
  const out = new Map();
  for (const m of text.matchAll(/uuid:([^=\s]+)\s*=\s*([0-9a-fA-F-]+)/g)) {
    try { out.set(m[1], parseUuid(m[2])); } catch { /* ignore a malformed line */ }
  }
  return out;
}

/**
 * @param {{name:string,startSector:number,sectors:number|null,grow:boolean}[]} partitions
 * @param {number} diskSectors total device size in 512-byte sectors
 * @param {Map<string,Uint8Array>} uuids
 * @returns {{master: Uint8Array, backup: Uint8Array, backupSector: number}}
 */
export function buildGpt(partitions, diskSectors, uuids = new Map()) {
  if (!diskSectors || diskSectors < 100) throw new Error('implausible disk size');
  const master = new Uint8Array(34 * SECTOR_SIZE);
  const dv = new DataView(master.buffer);

  // 1. protective MBR
  dv.setUint8(446 + 4, 0xee);          // sys_ind
  dv.setUint32(446 + 8, 1, true);      // start_sect
  dv.setUint32(446 + 12, 0xffffffff, true);
  dv.setUint16(510, 0xaa55, true);

  // 2. header at LBA 1
  const h = SECTOR_SIZE;
  master.set(new TextEncoder().encode('EFI PART'), h);
  dv.setUint32(h + 8, 0x00010000, true);          // revision
  dv.setUint32(h + 12, HEADER_SIZE, true);
  dv.setUint32(h + 16, 0, true);                  // header crc, filled below
  dv.setBigUint64(h + 24, 1n, true);              // my_lba
  dv.setBigUint64(h + 32, BigInt(diskSectors - 1), true); // alternate_lba
  dv.setBigUint64(h + 40, 34n, true);             // first usable
  dv.setBigUint64(h + 48, BigInt(diskSectors - 34), true); // last usable
  master.set(randomUuid(), h + 56);               // disk guid
  dv.setBigUint64(h + 72, 2n, true);              // partition entry lba
  dv.setUint32(h + 80, GPT_ENTRIES, true);
  dv.setUint32(h + 84, GPT_ENTRY_SIZE, true);

  // 3. entries from LBA 2
  const base = 2 * SECTOR_SIZE;
  partitions.forEach((p, i) => {
    if (i >= GPT_ENTRIES) throw new Error('too many partitions for one GPT');
    const o = base + i * GPT_ENTRY_SIZE;
    master.set(randomUuid(), o);
    master.set(uuids.get(p.name) || randomUuid(), o + 16);
    const end = p.grow ? diskSectors - 34 : p.startSector + p.sectors - 1;
    if (end >= diskSectors) throw new Error(`partition ${p.name} runs past the end of the device`);
    dv.setBigUint64(o + 32, BigInt(p.startSector), true);
    dv.setBigUint64(o + 40, BigInt(end), true);
    for (let j = 0; j < p.name.length && j < 36; j++) {
      dv.setUint16(o + 56 + j * 2, p.name.charCodeAt(j), true);
    }
  });

  dv.setUint32(h + 88, crc32(master.subarray(base, base + GPT_ENTRIES * GPT_ENTRY_SIZE)), true);
  dv.setUint32(h + 16, crc32(master.subarray(h, h + HEADER_SIZE)), true);

  // 4. backup: 32 sectors of entries, then the header
  const backup = new Uint8Array(33 * SECTOR_SIZE);
  backup.set(master.subarray(base, base + 32 * SECTOR_SIZE), 0);
  backup.set(master.subarray(h, h + SECTOR_SIZE), 32 * SECTOR_SIZE);
  const bh = 32 * SECTOR_SIZE;
  const bdv = new DataView(backup.buffer);
  bdv.setBigUint64(bh + 24, BigInt(diskSectors - 1), true);              // my_lba
  bdv.setBigUint64(bh + 32, 1n, true);                                   // alternate_lba
  bdv.setBigUint64(bh + 72, BigInt(diskSectors - 34) + 1n, true);        // entry lba
  bdv.setUint32(bh + 16, 0, true);
  bdv.setUint32(bh + 16, crc32(backup.subarray(bh, bh + HEADER_SIZE)), true);

  return { master, backup, backupSector: diskSectors - 33 };
}
