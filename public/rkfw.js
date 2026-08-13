// RKFW parser — the Rockchip recovery-mode image (the PLAY's PLAY_1.0.30.img).
//
//   RKFW  ->  loader (MiniLoaderAll.bin)
//         ->  RKAF  ->  partitions (parameter.txt, boot.img, rootfs.img, ...)
//
// Ported from birddog-re tools/rkfw/unpack_rkfw.py. Reads lazily through a
// Blob-like source (a browser File, or Node's fs.openAsBlob) so a 2.4 GB image
// is never held in memory — the flasher streams each partition straight to USB.
//
// A partition whose flashAddr is 0xFFFFFFFF is metadata, not something written
// to a sector: `package-file` and `bootloader` are both marked that way, and
// writing them to sector -1 would be a very bad day.

const NOT_FLASHED = 0xffffffff;

function cstr(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder('latin1').decode(end === -1 ? bytes : bytes.subarray(0, end));
}

async function readAt(source, offset, length) {
  const buf = await source.slice(offset, offset + length).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {Blob|File} source the whole .img
 */
export async function parseRkfw(source) {
  const head = await readAt(source, 0, 0x66);
  if (cstr(head.subarray(0, 4)) !== 'RKFW') throw new Error('not an RKFW image');
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);

  const built = {
    year: dv.getUint16(0x0e, true),
    month: head[0x10], day: head[0x11], hour: head[0x12], minute: head[0x13], second: head[0x14],
  };
  const chip = cstr(head.subarray(0x15, 0x19));
  const loaderOffset = dv.getUint32(0x19, true);
  const loaderSize = dv.getUint32(0x1d, true);
  const imageOffset = dv.getUint32(0x21, true);
  const imageSize = dv.getUint32(0x25, true);

  const afHead = await readAt(source, imageOffset, 0x2000);
  if (cstr(afHead.subarray(0, 4)) !== 'RKAF') throw new Error('inner image is not RKAF');
  const adv = new DataView(afHead.buffer, afHead.byteOffset, afHead.byteLength);

  const model = cstr(afHead.subarray(0x08, 0x08 + 34)).trim();
  const id = cstr(afHead.subarray(0x2a, 0x2a + 30)).trim();
  const manufacturer = cstr(afHead.subarray(0x48, 0x48 + 56)).trim();
  const count = adv.getInt32(0x88, true);
  if (count < 0 || count > 64) throw new Error(`implausible RKAF partition count ${count}`);

  const parts = [];
  for (let i = 0; i < count; i++) {
    const o = 0x8c + i * 112;
    const name = cstr(afHead.subarray(o, o + 32));
    const file = cstr(afHead.subarray(o + 32, o + 92));
    const pos = adv.getUint32(o + 96, true);
    const flashAddr = adv.getUint32(o + 100, true);
    const size = adv.getUint32(o + 108, true);
    parts.push({
      name, file, size,
      flashAddr,                       // destination sector on the eMMC
      offset: imageOffset + pos,       // where the bytes live in the .img
      flashed: flashAddr !== NOT_FLASHED && size > 0,
    });
  }

  return {
    source, chip, built, model, id, manufacturer,
    loader: { offset: loaderOffset, size: loaderSize },
    image: { offset: imageOffset, size: imageSize },
    partitions: parts,
  };
}

export function findPartition(fw, name) {
  return fw.partitions.find((p) => p.name === name);
}

/** The loader blob, read whole — it is ~190 KB. */
export async function readLoader(fw) {
  return readAt(fw.source, fw.loader.offset, fw.loader.size);
}

/** A partition's bytes as a Blob slice, so callers can stream it. */
export function partitionBlob(fw, part) {
  return fw.source.slice(part.offset, part.offset + part.size);
}

/**
 * parameter.txt carries the partition table as an mtdparts CMDLINE. The RKAF
 * records where each image is written, but only this tells us how big each
 * partition is — which is what makes the gap at the end of rootfs (3.5 GiB
 * partition, 2.235 GiB filesystem) visible and therefore usable.
 */
export function parseParameter(text) {
  const out = { raw: text, partitions: [] };
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z_]+):\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  const cmdline = out.CMDLINE || '';
  const mtd = /mtdparts=[^:]*:(.*)$/.exec(cmdline);
  if (mtd) {
    // 0x00020000@0x0000a000(boot)  — size@offset(name), both in 512B sectors.
    // A leading '-' size means "to the end of the device".
    for (const spec of mtd[1].split(',')) {
      const p = /^\s*(-|0x[0-9a-fA-F]+)@(0x[0-9a-fA-F]+)\(([^)]+)\)/.exec(spec);
      if (!p) continue;
      const grow = p[1] === '-';
      out.partitions.push({
        name: p[3].replace(/:grow$/, ''),
        grow: grow || p[3].endsWith(':grow'),
        startSector: parseInt(p[2], 16),
        sectors: grow ? null : parseInt(p[1], 16),
      });
    }
  }
  return out;
}
