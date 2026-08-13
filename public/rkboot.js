// RKBOOT container parser — the loader blob (MiniLoaderAll.bin) that maskrom
// mode expects over USB.
//
// Layout confirmed against the PLAY's own loader, extracted from the factory
// PLAY_1.0.30.img: header tag "BOOT", header size 0x66, entry size 57, one
// ENTRY471 (the DDR init blob) and one ENTRY472 (the usbplug/miniloader),
// plus two ENTRYLOADER records this tool never uses.
//
// Entry names are UTF-16LE and fixed at 20 code units. Getting the entry
// stride wrong shifts every offset and produces a loader that downloads
// cleanly and then never re-enumerates, so the stride is asserted, not
// assumed.

export const ENTRY471 = 1;
export const ENTRY472 = 2;
export const ENTRYLOADER = 4;

const ENTRY_SIZE = 57;

function utf16le(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * @param {Uint8Array} buf whole MiniLoaderAll.bin
 */
export function parseRkBoot(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (tag !== 'BOOT') throw new Error(`not an RKBOOT blob (tag ${JSON.stringify(tag)})`);

  const headerSize = dv.getUint16(0x04, true);
  const version = dv.getUint32(0x06, true);
  const mergeVersion = dv.getUint32(0x0a, true);
  const release = {
    year: dv.getUint16(0x0e, true),
    month: buf[0x10], day: buf[0x11], hour: buf[0x12], minute: buf[0x13], second: buf[0x14],
  };
  // Four ASCII bytes, stored little-endian as an enum. The PLAY's reads "H223".
  const chip = String.fromCharCode(buf[0x15], buf[0x16], buf[0x17], buf[0x18]);

  const groups = [
    { type: ENTRY471, count: buf[0x19], offset: dv.getUint32(0x1a, true), size: buf[0x1e] },
    { type: ENTRY472, count: buf[0x1f], offset: dv.getUint32(0x20, true), size: buf[0x24] },
    { type: ENTRYLOADER, count: buf[0x25], offset: dv.getUint32(0x26, true), size: buf[0x2a] },
  ];
  const signFlag = buf[0x2b];
  const rc4Flag = buf[0x2c];

  const entries = [];
  for (const g of groups) {
    if (g.count && g.size !== ENTRY_SIZE) {
      throw new Error(`unexpected RKBOOT entry stride ${g.size}, expected ${ENTRY_SIZE}`);
    }
    for (let i = 0; i < g.count; i++) {
      const o = g.offset + i * g.size;
      if (o + g.size > buf.length) throw new Error('RKBOOT entry runs past end of blob');
      const type = dv.getUint32(o + 1, true);
      const name = utf16le(buf.subarray(o + 5, o + 45));
      const dataOffset = dv.getUint32(o + 45, true);
      const dataSize = dv.getUint32(o + 49, true);
      const delayMs = dv.getUint32(o + 53, true);
      if (dataOffset + dataSize > buf.length) throw new Error(`RKBOOT entry ${name} runs past end`);
      entries.push({
        type, name, delayMs,
        data: buf.subarray(dataOffset, dataOffset + dataSize),
      });
    }
  }

  return { headerSize, version, mergeVersion, release, chip, signFlag, rc4Flag, entries };
}

export function entriesOfType(boot, type) {
  return boot.entries.filter((e) => e.type === type);
}
