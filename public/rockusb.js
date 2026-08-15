// Rockchip USB transport over WebUSB.
//
// Two protocols behind one device:
//
//   maskrom mode  the SoC's boot ROM. Vendor control transfers only, used to
//                 push the loader (MiniLoaderAll.bin) into SRAM/DRAM.
//   loader mode   the loader answers a USB-mass-storage-shaped protocol
//                 (CBW/CSW) with Rockchip opcodes, including READ_LBA and
//                 WRITE_LBA against the eMMC.
//
// A device is in maskrom mode when bcdUSB has bit 0 clear, and loader mode when
// it is set — that, not the product ID, is how rkdeveloptool tells them apart,
// which is fortunate because the RK3328's PID does not appear in its own table.
//
// Every constant here is taken from rkdeveloptool's source (RKComm.h/.cpp,
// RKDevice.cpp, RKScan.cpp) rather than from observation. Two are easy to get
// wrong and neither fails loudly:
//   - the maskrom vendor request puts 0x0471/0x0472 in wIndex, with wValue 0;
//   - dwAddress and usLength inside the CBWCB are BIG-endian, while the CBW
//     around them is little-endian.

import { crc16ccitt } from './crc.js';
import { parseRkBoot, ENTRY471, ENTRY472 } from './rkboot.js';

export const RK_VENDOR_ID = 0x2207;

export const MASKROM = 'maskrom';
export const LOADER = 'loader';

const CBW_SIGN = 0x43425355; // "USBC"
const CSW_SIGN = 0x53425355; // "USBS"

const OP = {
  TEST_UNIT_READY: 0x00,
  READ_FLASH_ID: 0x01,
  READ_LBA: 0x14,
  WRITE_LBA: 0x15,
  READ_FLASH_INFO: 0x1a,
  READ_CHIP_INFO: 0x1b,
  READ_CAPABILITY: 0xaa,
  DEVICE_RESET: 0xff,
};

// Reset subcodes, from RESET_SUBCODE.
export const RESET = {
  NONE: 0, RESET_MSC: 1, POWEROFF: 2, RESET_MASKROM: 3, DISCONNECT: 4,
};

export const SECTOR_SIZE = 512;
// rkdeveloptool's DEFAULT_RW_LBA. 64 KiB per command — proven in the field, and
// large enough that a 2.4 GB image is not dominated by per-command overhead.
export const SECTORS_PER_TRANSFER = 128;

export function usbMode(device) {
  return (device.usbVersionSubminor & 1) ? LOADER : MASKROM;
}

export class RockUsb {
  constructor(device) {
    this.device = device;
    this.tag = 1;
    this.interfaceNumber = null;
    this.epIn = null;
    this.epOut = null;
  }

  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: RK_VENDOR_ID }] });
    return new RockUsb(device);
  }

  get mode() { return usbMode(this.device); }

  async open() {
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
    for (const iface of this.device.configuration.interfaces) {
      const alt = iface.alternate;
      const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
      const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (inEp && outEp) {
        await this.device.claimInterface(iface.interfaceNumber);
        this.interfaceNumber = iface.interfaceNumber;
        this.epIn = inEp.endpointNumber;
        this.epOut = outEp.endpointNumber;
        return;
      }
    }
    throw new Error('no bulk endpoint pair on this device');
  }

  async close() {
    try {
      if (this.interfaceNumber !== null) await this.device.releaseInterface(this.interfaceNumber);
    } catch { /* the device may already be gone after a reset — that is fine */ }
    try { await this.device.close(); } catch { /* ditto */ }
  }

  // ---- maskrom ------------------------------------------------------------

  /**
   * One maskrom vendor request. Data is CRC16-appended and pushed in 4096-byte
   * chunks. The two padding cases come straight from RKU_DeviceRequest and look
   * arbitrary because they are: they exist so the CRC never lands astride a
   * packet boundary.
   */
  async vendorRequest(wIndex, data) {
    let size = data.length;
    let sendPending = false;
    switch (size % 4096) {
      case 4095: size += 1; break;
      case 4094: sendPending = true; break;
      default: break;
    }
    const buf = new Uint8Array(size + 2);
    buf.set(data, 0);
    const crc = crc16ccitt(buf.subarray(0, size));
    buf[size] = (crc >> 8) & 0xff;
    buf[size + 1] = crc & 0xff;

    for (let sent = 0; sent < buf.length; sent += 4096) {
      const chunk = buf.subarray(sent, Math.min(buf.length, sent + 4096));
      const res = await this.device.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0x0c, value: 0, index: wIndex,
      }, chunk);
      if (res.status !== 'ok' || res.bytesWritten !== chunk.length) {
        throw new Error(`maskrom request 0x${wIndex.toString(16)} failed (${res.status})`);
      }
    }
    if (sendPending) {
      await this.device.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0x0c, value: 0, index: wIndex,
      }, new Uint8Array(1));
    }
  }

  /**
   * Push MiniLoaderAll.bin. ENTRY471 (DDR init) first, then ENTRY472 (the
   * loader proper), honouring each entry's own delay. The device re-enumerates
   * afterwards, so this object is dead once it returns — the caller must ask
   * for the device again in loader mode.
   */
  async downloadBoot(loaderBytes, onProgress = () => {}) {
    const boot = parseRkBoot(loaderBytes);
    const entries = [
      ...boot.entries.filter((e) => e.type === ENTRY471),
      ...boot.entries.filter((e) => e.type === ENTRY472),
    ];
    for (const entry of entries) {
      if (!entry.data.length) continue;
      onProgress(`loader: ${entry.name} (${entry.data.length} bytes)`);
      await this.vendorRequest(entry.type === ENTRY471 ? 0x0471 : 0x0472, entry.data);
      await sleep(Math.max(entry.delayMs || 0, 200));

      // MEASURED ON HARDWARE, 2026-08-15: the maskrom restarts its USB stack
      // once DDR is initialised, so the handle that carried ENTRY471 is dead
      // before ENTRY472 is due. Pushing 472 through it times out, and the whole
      // loader download then fails in a way that reads as a protocol error
      // rather than as the device having simply gone away and come back.
      //
      // Worse, it leaves the maskrom in a state where it will not accept a
      // fresh ENTRY471 either — so the retry also fails, and only a power cycle
      // clears it. That is what made this look like an unrecoverable device
      // rather than a missing re-open.
      if (entry.type === ENTRY471) {
        onProgress('  DDR initialised — waiting for the device to re-enumerate');
        if (!(await this.reacquire())) {
          throw new Error(
            'the device did not come back after DDR init. Power-cycle it, hold the '
            + 'reset button while reconnecting, and try again — nothing has been '
            + 'written to flash.',
          );
        }
        onProgress(`  back as a ${this.mode} device`);
      }
    }
    await sleep(1000);
    return boot;
  }

  /**
   * Re-open this device after it re-enumerates, keeping the same RockUsb.
   * Returns false if it never comes back.
   */
  async reacquire(timeoutMs = 15000) {
    try { await this.device.close(); } catch { /* it has already gone */ }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const devices = await navigator.usb.getDevices();
      const match = devices.find((d) => d.vendorId === RK_VENDOR_ID);
      if (match) {
        // `mode` is a getter over this.device, so swapping the device is the
        // whole update — assigning to this.mode would throw (getter, no setter).
        this.device = match;
        try {
          await this.open();
          return true;
        } catch { /* enumerated but not ready yet */ }
      }
      await sleep(300);
    }
    return false;
  }

  // ---- loader (CBW/CSW) ---------------------------------------------------

  buildCbw(opcode, { transferLength = 0, address = 0, length = 0, subCode = 0, dataIn = false, cbLength = 6 }) {
    const cbw = new Uint8Array(31);
    const dv = new DataView(cbw.buffer);
    const tag = this.tag++ >>> 0;
    dv.setUint32(0, CBW_SIGN, true);
    dv.setUint32(4, tag, true);
    dv.setUint32(8, transferLength, true);
    cbw[12] = dataIn ? 0x80 : 0x00;
    cbw[13] = 0;              // LUN
    cbw[14] = cbLength;
    cbw[15] = opcode;
    cbw[16] = subCode;
    dv.setUint32(17, address, false);   // big-endian
    cbw[21] = 0;
    dv.setUint16(22, length, false);    // big-endian
    return { cbw, tag };
  }

  async readCsw(tag) {
    const res = await this.device.transferIn(this.epIn, 13);
    if (res.status !== 'ok') throw new Error(`CSW read failed (${res.status})`);
    const dv = res.data;
    if (dv.getUint32(0, true) !== CSW_SIGN) throw new Error('bad CSW signature');
    if (dv.getUint32(4, true) !== tag) throw new Error('CSW tag mismatch');
    const status = dv.getUint8(12);
    if (status !== 0) throw new Error(`device reported command failure (status ${status})`);
  }

  async command(opcode, opts = {}) {
    const { cbw, tag } = this.buildCbw(opcode, opts);
    const out = await this.device.transferOut(this.epOut, cbw);
    if (out.status !== 'ok') throw new Error(`CBW write failed (${out.status})`);

    let data = null;
    if (opts.dataIn && opts.transferLength) {
      const res = await this.device.transferIn(this.epIn, opts.transferLength);
      if (res.status !== 'ok') throw new Error(`data read failed (${res.status})`);
      data = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
    } else if (opts.dataOut) {
      const res = await this.device.transferOut(this.epOut, opts.dataOut);
      if (res.status !== 'ok') throw new Error(`data write failed (${res.status})`);
    }

    await this.readCsw(tag);
    return data;
  }

  async testUnitReady() {
    await this.command(OP.TEST_UNIT_READY, { dataIn: true, transferLength: 0, cbLength: 6 });
  }

  /** Flash geometry. uiFlashSize is in 512-byte sectors. */
  async readFlashInfo() {
    const d = await this.command(OP.READ_FLASH_INFO, { dataIn: true, transferLength: 11, cbLength: 6 });
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return {
      sectors: dv.getUint32(0, true),
      blockSize: dv.getUint16(4, true),
      pageSize: d[6],
      eccBits: d[7],
      accessTime: d[8],
      manufCode: d[9],
      flashCS: d[10],
    };
  }

  async readLba(sector, count) {
    return this.command(OP.READ_LBA, {
      dataIn: true, cbLength: 10,
      transferLength: count * SECTOR_SIZE, address: sector, length: count,
    });
  }

  async writeLba(sector, bytes) {
    if (bytes.length % SECTOR_SIZE) throw new Error('LBA writes must be whole sectors');
    const count = bytes.length / SECTOR_SIZE;
    await this.command(OP.WRITE_LBA, {
      cbLength: 10, dataOut: bytes,
      transferLength: bytes.length, address: sector, length: count,
    });
  }

  async resetDevice(subCode = RESET.NONE) {
    await this.command(OP.DEVICE_RESET, { cbLength: 6, subCode });
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for the device to come back in the requested mode after a re-enumeration.
 * WebUSB hands back already-permitted devices through getDevices(), so no second
 * user gesture is needed — but permission is per (vendorId, productId) pair, and
 * maskrom and loader mode expose different product IDs on some SoCs. If the
 * device does not reappear, the caller must prompt for it again.
 */
export async function waitForMode(mode, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const devices = await navigator.usb.getDevices();
    const match = devices.find((d) => d.vendorId === RK_VENDOR_ID && usbMode(d) === mode);
    if (match) return new RockUsb(match);
    await sleep(300);
  }
  return null;
}
