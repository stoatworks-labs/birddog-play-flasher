// A read/write ext2 driver, just large enough to inject a few files into the
// PLAY's factory rootfs.
//
// The factory rootfs.img is plain ext2: `dir_index filetype` and nothing else.
// No journal, no extents, no metadata_csum, no 64bit, no sparse_super. That is
// what makes this tractable — there is no checksum anywhere to get wrong, and
// nothing to replay. It also means every group carries a superblock backup,
// which e2fsck does not compare on a normal pass, so only the primary copy and
// the primary group descriptors are maintained here.
//
// Nothing is ever buffered wholesale: the image is read through a Blob and
// every modification lands in an overlay of 1 KiB blocks. The flasher applies
// that overlay while streaming the partition to USB, so a 2.4 GB rootfs is
// patched without ever existing in memory.
//
// Deliberate limits, all enforced rather than assumed:
//   - files created here must fit in the 12 direct block pointers (12 KiB at
//     1 KiB blocks), so no indirect block trees are ever built;
//   - in-place rewrites may not grow past the blocks a file already owns.

const EXT2_SUPER_MAGIC = 0xef53;
const ROOT_INO = 2;
const INDEX_FL = 0x1000;

export const S_IFDIR = 0x4000;
export const S_IFREG = 0x8000;
export const S_IFLNK = 0xa000;

const FT_REG = 1;
const FT_DIR = 2;
const FT_LNK = 7;

const roundUp4 = (n) => (n + 3) & ~3;

export class Ext2 {
  constructor(blob, sb, groups) {
    this.blob = blob;
    this.sb = sb;
    this.groups = groups;
    /** @type {Map<number, Uint8Array>} block number -> replacement contents */
    this.overlay = new Map();
  }

  static async open(blob) {
    const head = new Uint8Array(await blob.slice(1024, 2048).arrayBuffer());
    const dv = new DataView(head.buffer);
    if (dv.getUint16(56, true) !== EXT2_SUPER_MAGIC) throw new Error('not an ext2 filesystem');

    const logBlockSize = dv.getUint32(24, true);
    const sb = {
      inodesCount: dv.getUint32(0, true),
      blocksCount: dv.getUint32(4, true),
      freeBlocks: dv.getUint32(12, true),
      freeInodes: dv.getUint32(16, true),
      firstDataBlock: dv.getUint32(20, true),
      blockSize: 1024 << logBlockSize,
      blocksPerGroup: dv.getUint32(32, true),
      inodesPerGroup: dv.getUint32(40, true),
      revLevel: dv.getUint32(76, true),
      firstIno: dv.getUint32(84, true),
      inodeSize: dv.getUint16(88, true),
      featureCompat: dv.getUint32(92, true),
      featureIncompat: dv.getUint32(96, true),
      featureRoCompat: dv.getUint32(100, true),
    };
    if (sb.revLevel === 0) { sb.inodeSize = 128; sb.firstIno = 11; }
    // Anything beyond filetype (0x2) in incompat means a layout this driver
    // does not implement — extents, 64bit, meta_bg, and journal recovery all
    // live here. Refuse rather than corrupt.
    if (sb.featureIncompat & ~0x0002) {
      throw new Error(`unsupported ext incompat features 0x${sb.featureIncompat.toString(16)}`);
    }
    if (sb.featureRoCompat & ~0x0003) {
      throw new Error(`unsupported ext ro_compat features 0x${sb.featureRoCompat.toString(16)}`);
    }

    const groupCount = Math.ceil((sb.blocksCount - sb.firstDataBlock) / sb.blocksPerGroup);
    const gdBlock = sb.firstDataBlock + (sb.blockSize === 1024 ? 1 : 0);
    const gdBytes = groupCount * 32;
    const gdRaw = new Uint8Array(await blob.slice(
      gdBlock * sb.blockSize,
      gdBlock * sb.blockSize + Math.ceil(gdBytes / sb.blockSize) * sb.blockSize,
    ).arrayBuffer());
    const gdv = new DataView(gdRaw.buffer);

    const groups = [];
    for (let i = 0; i < groupCount; i++) {
      const o = i * 32;
      groups.push({
        blockBitmap: gdv.getUint32(o + 0, true),
        inodeBitmap: gdv.getUint32(o + 4, true),
        inodeTable: gdv.getUint32(o + 8, true),
        freeBlocks: gdv.getUint16(o + 12, true),
        freeInodes: gdv.getUint16(o + 14, true),
        usedDirs: gdv.getUint16(o + 16, true),
      });
    }

    const fs = new Ext2(blob, sb, groups);
    fs.gdBlock = gdBlock;
    fs.gdBlockCount = Math.ceil(gdBytes / sb.blockSize);
    return fs;
  }

  // ---- block access -------------------------------------------------------

  async readBlock(n) {
    const cached = this.overlay.get(n);
    if (cached) return cached;
    const off = n * this.sb.blockSize;
    const buf = await this.blob.slice(off, off + this.sb.blockSize).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Get a writable copy of a block, registered in the overlay. */
  async dirtyBlock(n) {
    let b = this.overlay.get(n);
    if (!b) {
      b = new Uint8Array(await this.readBlock(n));
      this.overlay.set(n, b);
    }
    return b;
  }

  putBlock(n, bytes) {
    if (bytes.length !== this.sb.blockSize) throw new Error('block write must be a whole block');
    this.overlay.set(n, bytes);
  }

  // ---- inodes -------------------------------------------------------------

  inodeLocation(ino) {
    const g = Math.floor((ino - 1) / this.sb.inodesPerGroup);
    const idx = (ino - 1) % this.sb.inodesPerGroup;
    const byteOff = idx * this.sb.inodeSize;
    return {
      group: g,
      block: this.groups[g].inodeTable + Math.floor(byteOff / this.sb.blockSize),
      offset: byteOff % this.sb.blockSize,
    };
  }

  async readInode(ino) {
    const loc = this.inodeLocation(ino);
    const blk = await this.readBlock(loc.block);
    const dv = new DataView(blk.buffer, blk.byteOffset + loc.offset, this.sb.inodeSize);
    const blocks = [];
    for (let i = 0; i < 15; i++) blocks.push(dv.getUint32(40 + i * 4, true));
    return {
      ino,
      mode: dv.getUint16(0, true),
      uid: dv.getUint16(2, true),
      size: dv.getUint32(4, true),
      atime: dv.getUint32(8, true),
      ctime: dv.getUint32(12, true),
      mtime: dv.getUint32(16, true),
      gid: dv.getUint16(24, true),
      links: dv.getUint16(26, true),
      blocks512: dv.getUint32(28, true),
      flags: dv.getUint32(32, true),
      block: blocks,
    };
  }

  async writeInode(inode) {
    const loc = this.inodeLocation(inode.ino);
    const blk = await this.dirtyBlock(loc.block);
    const dv = new DataView(blk.buffer, blk.byteOffset + loc.offset, this.sb.inodeSize);
    dv.setUint16(0, inode.mode, true);
    dv.setUint16(2, inode.uid, true);
    dv.setUint32(4, inode.size, true);
    dv.setUint32(8, inode.atime, true);
    dv.setUint32(12, inode.ctime, true);
    dv.setUint32(16, inode.mtime, true);
    dv.setUint32(20, 0, true);            // dtime — a live inode must have none
    dv.setUint16(24, inode.gid, true);
    dv.setUint16(26, inode.links, true);
    dv.setUint32(28, inode.blocks512, true);
    dv.setUint32(32, inode.flags, true);
    for (let i = 0; i < 15; i++) dv.setUint32(40 + i * 4, inode.block[i] || 0, true);
  }

  /** Block numbers holding a file's data, following one level of indirection. */
  async dataBlocks(inode) {
    const perBlock = this.sb.blockSize / 4;
    const out = [];
    for (let i = 0; i < 12 && inode.block[i]; i++) out.push(inode.block[i]);
    if (inode.block[12]) {
      const ind = await this.readBlock(inode.block[12]);
      const dv = new DataView(ind.buffer, ind.byteOffset, ind.byteLength);
      for (let i = 0; i < perBlock; i++) {
        const b = dv.getUint32(i * 4, true);
        if (b) out.push(b);
      }
    }
    if (inode.block[13] || inode.block[14]) {
      throw new Error('file uses double/triple indirect blocks — not supported');
    }
    return out;
  }

  async readFile(inode) {
    if ((inode.mode & 0xf000) === S_IFLNK && inode.size < 60) {
      const raw = new Uint8Array(60);
      new DataView(raw.buffer).setUint32(0, 0, true);
      // fast symlink: target sits in the block pointer array
      const bytes = new Uint8Array(inode.size);
      for (let i = 0; i < inode.size; i++) {
        bytes[i] = (inode.block[i >> 2] >>> ((i % 4) * 8)) & 0xff;
      }
      return bytes;
    }
    const blocks = await this.dataBlocks(inode);
    const out = new Uint8Array(inode.size);
    let done = 0;
    for (const b of blocks) {
      if (done >= inode.size) break;
      const blk = await this.readBlock(b);
      const n = Math.min(this.sb.blockSize, inode.size - done);
      out.set(blk.subarray(0, n), done);
      done += n;
    }
    return out;
  }

  // ---- path resolution ----------------------------------------------------

  async *readDir(inode) {
    const blocks = await this.dataBlocks(inode);
    for (const b of blocks) {
      const blk = await this.readBlock(b);
      const dv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
      let o = 0;
      while (o + 8 <= blk.length) {
        const ino = dv.getUint32(o, true);
        const recLen = dv.getUint16(o + 4, true);
        const nameLen = blk[o + 6];
        const fileType = blk[o + 7];
        if (recLen < 8) break;
        if (ino !== 0) {
          const name = new TextDecoder('latin1').decode(blk.subarray(o + 8, o + 8 + nameLen));
          yield { ino, name, fileType, block: b, offset: o, recLen };
        }
        o += recLen;
      }
    }
  }

  async lookup(dirInode, name) {
    for await (const e of this.readDir(dirInode)) if (e.name === name) return e;
    return null;
  }

  async resolve(path) {
    const parts = path.split('/').filter(Boolean);
    let inode = await this.readInode(ROOT_INO);
    for (const part of parts) {
      const e = await this.lookup(inode, part);
      if (!e) throw new Error(`no such path: ${path} (missing ${part})`);
      inode = await this.readInode(e.ino);
    }
    return inode;
  }

  // ---- allocation ---------------------------------------------------------

  async allocBlock() {
    for (let g = 0; g < this.groups.length; g++) {
      if (!this.groups[g].freeBlocks) continue;
      const bmp = await this.dirtyBlock(this.groups[g].blockBitmap);
      const inGroup = Math.min(
        this.sb.blocksPerGroup,
        this.sb.blocksCount - this.sb.firstDataBlock - g * this.sb.blocksPerGroup,
      );
      for (let i = 0; i < inGroup; i++) {
        if (!(bmp[i >> 3] & (1 << (i & 7)))) {
          bmp[i >> 3] |= 1 << (i & 7);
          this.groups[g].freeBlocks--;
          this.sb.freeBlocks--;
          return this.sb.firstDataBlock + g * this.sb.blocksPerGroup + i;
        }
      }
    }
    throw new Error('no free blocks left in the filesystem');
  }

  async allocInode(isDir) {
    for (let g = 0; g < this.groups.length; g++) {
      if (!this.groups[g].freeInodes) continue;
      const bmp = await this.dirtyBlock(this.groups[g].inodeBitmap);
      for (let i = 0; i < this.sb.inodesPerGroup; i++) {
        const ino = g * this.sb.inodesPerGroup + i + 1;
        if (ino < this.sb.firstIno) continue;
        if (!(bmp[i >> 3] & (1 << (i & 7)))) {
          bmp[i >> 3] |= 1 << (i & 7);
          this.groups[g].freeInodes--;
          this.sb.freeInodes--;
          if (isDir) this.groups[g].usedDirs++;
          return ino;
        }
      }
    }
    throw new Error('no free inodes left in the filesystem');
  }

  // ---- mutation -----------------------------------------------------------

  /**
   * Replace a file's contents without changing its allocation. Used for
   * /etc/rc.local, which owns one 1 KiB block and uses 413 bytes of it: the
   * hook fits in the slack, so not a single bitmap or counter moves.
   */
  async writeFileInPlace(inode, bytes) {
    const blocks = await this.dataBlocks(inode);
    const capacity = blocks.length * this.sb.blockSize;
    if (bytes.length > capacity) {
      throw new Error(`in-place write needs ${bytes.length} bytes, file owns ${capacity}`);
    }
    for (let i = 0; i < blocks.length; i++) {
      const chunk = new Uint8Array(this.sb.blockSize);
      const start = i * this.sb.blockSize;
      if (start < bytes.length) chunk.set(bytes.subarray(start, Math.min(bytes.length, start + this.sb.blockSize)));
      this.putBlock(blocks[i], chunk);
    }
    inode.size = bytes.length;
    inode.mtime = inode.ctime = Math.floor(Date.now() / 1000);
    await this.writeInode(inode);
  }

  /** Insert a directory entry, splitting slack in an existing record. */
  async addDirEntry(dirInode, name, ino, fileType) {
    if (dirInode.flags & INDEX_FL) {
      // An htree directory's leaf blocks are ordinary linear dirent blocks and
      // its root block ends in a fake entry, so dropping the index flag leaves
      // a directory the kernel and e2fsck both read linearly.
      dirInode.flags &= ~INDEX_FL;
      await this.writeInode(dirInode);
    }
    const nameBytes = new TextEncoder().encode(name);
    const need = roundUp4(8 + nameBytes.length);

    const blocks = await this.dataBlocks(dirInode);
    for (const b of blocks) {
      const blk = await this.dirtyBlock(b);
      const dv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
      let o = 0;
      while (o + 8 <= blk.length) {
        const eIno = dv.getUint32(o, true);
        const recLen = dv.getUint16(o + 4, true);
        const nameLen = blk[o + 6];
        if (recLen < 8) break;
        const used = eIno === 0 ? 0 : roundUp4(8 + nameLen);
        if (recLen - used >= need) {
          if (eIno === 0) {
            // whole record is free
            dv.setUint32(o, ino, true);
            dv.setUint16(o + 4, recLen, true);
            blk[o + 6] = nameBytes.length;
            blk[o + 7] = fileType;
            blk.set(nameBytes, o + 8);
          } else {
            dv.setUint16(o + 4, used, true);
            const n = o + used;
            dv.setUint32(n, ino, true);
            dv.setUint16(n + 4, recLen - used, true);
            blk[n + 6] = nameBytes.length;
            blk[n + 7] = fileType;
            blk.set(nameBytes, n + 8);
          }
          return;
        }
        o += recLen;
      }
    }

    // No slack anywhere — give the directory another block.
    const nb = await this.allocBlock();
    const blk = new Uint8Array(this.sb.blockSize);
    const dv = new DataView(blk.buffer);
    dv.setUint32(0, ino, true);
    dv.setUint16(4, this.sb.blockSize, true);
    blk[6] = nameBytes.length;
    blk[7] = fileType;
    blk.set(nameBytes, 8);
    this.putBlock(nb, blk);

    const idx = blocks.length;
    if (idx >= 12) throw new Error('directory needs an indirect block — not supported');
    dirInode.block[idx] = nb;
    dirInode.size += this.sb.blockSize;
    dirInode.blocks512 += this.sb.blockSize / 512;
    await this.writeInode(dirInode);
  }

  async createFile(dirPath, name, bytes, mode = 0o644) {
    const maxDirect = 12 * this.sb.blockSize;
    if (bytes.length > maxDirect) {
      throw new Error(`injected file ${name} is ${bytes.length} bytes; limit is ${maxDirect}`);
    }
    const dir = await this.resolve(dirPath);
    if (await this.lookup(dir, name)) throw new Error(`${dirPath}/${name} already exists`);

    const ino = await this.allocInode(false);
    const now = Math.floor(Date.now() / 1000);
    const blocks = [];
    for (let off = 0; off < bytes.length; off += this.sb.blockSize) {
      const b = await this.allocBlock();
      const chunk = new Uint8Array(this.sb.blockSize);
      chunk.set(bytes.subarray(off, Math.min(bytes.length, off + this.sb.blockSize)));
      this.putBlock(b, chunk);
      blocks.push(b);
    }
    const inode = {
      ino, mode: S_IFREG | mode, uid: 0, gid: 0,
      size: bytes.length, atime: now, ctime: now, mtime: now,
      links: 1, blocks512: blocks.length * (this.sb.blockSize / 512), flags: 0,
      block: [...blocks, ...new Array(15 - blocks.length).fill(0)],
    };
    await this.writeInode(inode);
    await this.addDirEntry(dir, name, ino, FT_REG);
    return inode;
  }

  async createSymlink(dirPath, name, target) {
    const bytes = new TextEncoder().encode(target);
    if (bytes.length >= 60) throw new Error('only fast symlinks (<60 bytes) are supported');
    const dir = await this.resolve(dirPath);
    if (await this.lookup(dir, name)) throw new Error(`${dirPath}/${name} already exists`);

    const ino = await this.allocInode(false);
    const now = Math.floor(Date.now() / 1000);
    const block = new Array(15).fill(0);
    for (let i = 0; i < bytes.length; i++) {
      block[i >> 2] |= bytes[i] << ((i % 4) * 8);
      block[i >> 2] >>>= 0;
    }
    await this.writeInode({
      ino, mode: S_IFLNK | 0o777, uid: 0, gid: 0,
      size: bytes.length, atime: now, ctime: now, mtime: now,
      links: 1, blocks512: 0, flags: 0, block,
    });
    await this.addDirEntry(dir, name, ino, FT_LNK);
    return ino;
  }

  /** Write back the superblock and group descriptors that allocation moved. */
  async flushMetadata() {
    const sbBlockNo = this.sb.blockSize === 1024 ? 1 : 0;
    const sbOffset = this.sb.blockSize === 1024 ? 0 : 1024;
    const sbBlk = await this.dirtyBlock(sbBlockNo);
    const dv = new DataView(sbBlk.buffer, sbBlk.byteOffset, sbBlk.byteLength);
    dv.setUint32(sbOffset + 12, this.sb.freeBlocks, true);
    dv.setUint32(sbOffset + 16, this.sb.freeInodes, true);
    dv.setUint32(sbOffset + 48, Math.floor(Date.now() / 1000), true); // s_wtime
    dv.setUint16(sbOffset + 58, 1, true);                             // s_state = clean

    for (let i = 0; i < this.gdBlockCount; i++) {
      const blk = await this.dirtyBlock(this.gdBlock + i);
      const gdv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength);
      const perBlock = this.sb.blockSize / 32;
      for (let j = 0; j < perBlock; j++) {
        const g = i * perBlock + j;
        if (g >= this.groups.length) break;
        gdv.setUint16(j * 32 + 12, this.groups[g].freeBlocks, true);
        gdv.setUint16(j * 32 + 14, this.groups[g].freeInodes, true);
        gdv.setUint16(j * 32 + 16, this.groups[g].usedDirs, true);
      }
    }
  }

  /** Overlay as byte-offset patches into the partition image. */
  patches() {
    return [...this.overlay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([blockNo, bytes]) => ({ offset: blockNo * this.sb.blockSize, bytes }));
  }
}
