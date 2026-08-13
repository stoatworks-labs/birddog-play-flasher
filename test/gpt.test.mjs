// Checks the generated partition table against an independent parser.
//
// The validator below is Python using zlib.crc32 and struct — a different
// implementation of both the CRC and the field offsets. Our own code agreeing
// with itself would not catch a wrong offset or a byte-order slip, which is
// exactly the class of bug that produces a device with no partition table.
//
// If sgdisk is available (CI installs it) the same image is put in front of it
// too, since a real GPT tool is a harder judge than any test we could write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildGpt, parseUuid } from '../public/gpt.js';
import { parseParameter } from '../public/rkfw.js';

// The PLAY's own parameter.txt, verbatim.
const PARAMETER = `FIRMWARE_VER: 8.1
MACHINE_MODEL: RK3328
MACHINE_ID: 007
MANUFACTURER: RK3328
MAGIC: 0x5041524B
ATAG: 0x00200800
MACHINE: 3328
CHECK_MASK: 0x80
PWR_HLD: 0,0,A,0,1
TYPE: GPT
CMDLINE: mtdparts=rk29xxnand:0x00002000@0x00004000(uboot),0x00002000@0x00006000(trust),0x00002000@0x00008000(misc),0x00020000@0x0000a000(boot),0x00020000@0x0002a000(recovery),0x00010000@0x0004a000(backup),0x00020000@0x0005a000(oem),0x00700000@0x0007a000(rootfs),-@0x0077a000(userdata:grow)
uuid:rootfs=614e0000-0000-4b53-8000-1d28000054a9
`;

const DISK_SECTORS = 15_269_888; // an 8 GB eMMC

const VALIDATOR = `
import struct, sys, zlib
path, disk = sys.argv[1], int(sys.argv[2])
d = open(path, 'rb').read()
S = 512
assert d[510:512] == b'\\x55\\xaa', 'no MBR signature'
assert d[446+4] == 0xEE, 'protective MBR partition is not type EE'
assert struct.unpack_from('<I', d, 446+8)[0] == 1, 'protective MBR does not start at LBA 1'

h = d[S:S+92]
assert h[:8] == b'EFI PART', 'bad GPT signature'
(rev, hsize, hcrc, _r, mylba, altlba, first, last) = struct.unpack_from('<IIIIQQQQ', h, 8)
entlba, nent, entsize, entcrc = struct.unpack_from('<QIII', h, 72)
assert rev == 0x00010000, 'bad revision'
assert hsize == 92, 'bad header size'
assert mylba == 1 and altlba == disk - 1, 'bad lba pointers'
assert first == 34 and last == disk - 34, 'bad usable range'
assert entlba == 2 and nent == 128 and entsize == 128, 'bad entry array geometry'

zeroed = bytearray(h); zeroed[16:20] = b'\\x00' * 4
assert zlib.crc32(bytes(zeroed)) & 0xffffffff == hcrc, 'header crc mismatch'
ents = d[2*S:2*S + nent*entsize]
assert zlib.crc32(ents) & 0xffffffff == entcrc, 'entry array crc mismatch'

out = []
for i in range(nent):
    e = ents[i*entsize:(i+1)*entsize]
    if e[:16] == b'\\x00'*16:
        continue
    start, end = struct.unpack_from('<QQ', e, 32)
    name = e[56:128].decode('utf-16-le').rstrip('\\x00')
    assert end >= start, f'{name}: ends before it starts'
    assert end <= last, f'{name}: runs past the last usable sector'
    out.append((name, start, end, e[16:32].hex()))
for n, s, e, u in out:
    print(f'{n} {s} {e} {u}')
`;

function validate(bytes, disk) {
  const dir = mkdtempSync(join(tmpdir(), 'bdgpt-'));
  const f = join(dir, 'gpt.bin');
  writeFileSync(f, bytes);
  return execFileSync('python3', ['-c', VALIDATOR, f, String(disk)], { stdio: 'pipe' }).toString();
}

test('the generated GPT parses and checksums independently', () => {
  const param = parseParameter(PARAMETER);
  assert.equal(param.TYPE, 'GPT');
  assert.equal(param.partitions.length, 9);

  const { master, backup, backupSector } = buildGpt(param.partitions, DISK_SECTORS,
    new Map([['rootfs', parseUuid('614e0000-0000-4b53-8000-1d28000054a9')]]));

  assert.equal(master.length, 34 * 512);
  assert.equal(backup.length, 33 * 512);
  assert.equal(backupSector, DISK_SECTORS - 33);

  const lines = validate(master, DISK_SECTORS).trim().split('\n');
  assert.equal(lines.length, 9, 'nine partitions survived the round trip');

  const parts = Object.fromEntries(lines.map((l) => {
    const [name, start, end, uuid] = l.split(' ');
    return [name, { start: +start, end: +end, uuid }];
  }));

  assert.deepEqual(parts.uboot, { start: 16384, end: 16384 + 8192 - 1, uuid: parts.uboot.uuid });
  assert.equal(parts.rootfs.start, 499712);
  assert.equal(parts.rootfs.end, 499712 + 7340032 - 1);
  // `:grow` must reach the end of the device, not stop at its declared size.
  assert.equal(parts.userdata.start, 7839744);
  assert.equal(parts.userdata.end, DISK_SECTORS - 34);
  // The uuid from parameter.txt must survive, mixed-endian and all.
  assert.equal(parts.rootfs.uuid, '0000' + '4e61' + '0000' + '534b' + '8000' + '1d28000054a9');
});

test('the backup GPT points the other way and re-checksums', () => {
  const param = parseParameter(PARAMETER);
  const { backup } = buildGpt(param.partitions, DISK_SECTORS);

  const dv = new DataView(backup.buffer, 32 * 512, 92);
  assert.equal(new TextDecoder().decode(new Uint8Array(backup.buffer, 32 * 512, 8)), 'EFI PART');
  assert.equal(dv.getBigUint64(24, true), BigInt(DISK_SECTORS - 1), 'my_lba is the last sector');
  assert.equal(dv.getBigUint64(32, true), 1n, 'alternate_lba points back at the primary');
  assert.equal(dv.getBigUint64(72, true), BigInt(DISK_SECTORS - 33), 'entries sit just after last usable');
});

test('sgdisk accepts the table', { skip: !hasSgdisk() && 'sgdisk not installed' }, () => {
  const param = parseParameter(PARAMETER);
  const { master, backup, backupSector } = buildGpt(param.partitions, DISK_SECTORS);

  const dir = mkdtempSync(join(tmpdir(), 'bdgpt-'));
  const disk = join(dir, 'disk.img');
  writeFileSync(disk, Buffer.alloc(0));
  truncateSync(disk, DISK_SECTORS * 512); // sparse
  const fd = openSync(disk, 'r+');
  writeSync(fd, master, 0, master.length, 0);
  writeSync(fd, backup, 0, backup.length, backupSector * 512);
  closeSync(fd);

  const out = execFileSync('sgdisk', ['-v', disk], { stdio: 'pipe' }).toString();
  assert.match(out, /No problems found/, out);
  const table = execFileSync('sgdisk', ['-p', disk], { stdio: 'pipe' }).toString();
  for (const name of ['uboot', 'trust', 'misc', 'boot', 'recovery', 'backup', 'oem', 'rootfs', 'userdata']) {
    assert.match(table, new RegExp(name), `${name} is listed`);
  }
});

function hasSgdisk() {
  try { execFileSync('sgdisk', ['-V'], { stdio: 'pipe' }); return true; } catch (e) { return e.code !== 'ENOENT'; }
}
