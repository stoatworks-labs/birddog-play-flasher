// Checksums used by the Rockchip boot protocol and by GPT.
//
// CRC-16/CCITT here is Rockchip's variant: poly 0x1021, init 0x0000, no
// reflection, no final xor. rkdeveloptool appends it BIG-ENDIAN to every
// maskrom vendor request. It is not the same as CRC-16/CCITT-FALSE (init
// 0xFFFF) — a wrong init looks exactly like a corrupt loader, and the device
// answers a bad CRC by silently doing nothing.

const CCITT_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let acc = 0;
    let data = i << 8;
    for (let j = 0; j < 8; j++) {
      acc = ((data ^ acc) & 0x8000) ? (((acc << 1) ^ 0x1021) & 0xffff) : ((acc << 1) & 0xffff);
      data = (data << 1) & 0xffff;
    }
    t[i] = acc;
  }
  return t;
})();

export function crc16ccitt(bytes) {
  let acc = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = ((acc << 8) ^ CCITT_TABLE[((acc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return acc;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

// Standard CRC-32 (zlib/GPT), reflected, init 0xFFFFFFFF, final xor.
export function crc32(bytes, seed = 0) {
  let c = (~seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}
