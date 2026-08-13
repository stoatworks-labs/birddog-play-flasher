# AGENTS.md — bringing an LLM up to speed on the BirdDog PLAY recovery flasher

Orientation for an AI assistant (or a new human) picking this project up cold. `CLAUDE.md` holds
the short command reference; this file explains the model and the traps.

---

## 1. What this is

A static web page that flashes a BirdDog PLAY over USB in Rockchip recovery mode, optionally
injecting a `.fw` update package into the image on the way past. Vanilla JS, ES modules, no
framework, no build step, no runtime dependencies.

It is the sibling of `birddog-play-patcher`, which *builds* `.fw` packages. This one *installs*
things, and it rewrites the whole device rather than overlaying a rootfs.

## 2. Layout

```
public/
  index.html   the page, including the operational warnings
  app.js       UI glue only — no protocol logic lives here
  crc.js       CRC-16/CCITT (Rockchip variant) and CRC-32 (GPT)
  rkboot.js    RKBOOT container: the loader entries maskrom wants
  rkfw.js      RKFW/RKAF: the factory .img, parsed lazily through a Blob
  ext2.js      ext2 reader + minimal writer, overlay-based
  gpt.js       partition table built from parameter.txt
  inject.js    where the .fw goes and what gets added to the filesystem
  plan.js      ordered write list, streaming execution, read-back verify
  rockusb.js   WebUSB: maskrom vendor requests and loader-mode CBW/CSW
test/          node --test; CI-safe tests build their own ext2 with mke2fs
```

Every module except `app.js` is DOM-free and network-free, which is what lets the tests drive the
real code in Node.

## 3. Where the truth lives

The research this is built on is in the private `birddog-re` repo: `notes/08-recovery-image.md`
covers the RKFW container and the partition layout, and `tools/rkfw/unpack_rkfw.py` is the
Python original that `rkfw.js` is a port of. The USB protocol constants come from
[rkdeveloptool](https://github.com/rockchip-linux/rkdeveloptool) — `RKComm.h/.cpp`,
`RKDevice.cpp`, `RKScan.cpp` — not from observation.

## 4. Traps

- **The maskrom vendor request puts `0x0471`/`0x0472` in wIndex, with wValue 0.** libusb's
  argument order makes this easy to reverse, and a device sent the wrong one simply does nothing.
- **Inside the CBWCB, `dwAddress` and `usLength` are big-endian** while the CBW around them is
  little-endian. Same failure mode: no error, no write.
- **Mode is `bcdUSB & 1`** — 0 is maskrom, 1 is loader. Not the product ID; the RK3328's PID does
  not even appear in rkdeveloptool's own table.
- **`parameter.txt` is never written raw.** Its RKAF entry claims sector 0, which on a GPT device
  is the protective MBR. The vendor tool turns the mtdparts CMDLINE into a partition table
  instead, and so does `gpt.js`. Writing the file there leaves a device with no table at all.
- **`package-file`, `bootloader` and `backup` have flash address `0xFFFFFFFF` or size 0.** They
  are metadata, not partitions. `rkfw.js` marks them `flashed: false`; anything that writes them
  is a bug.
- **Injected files must stay under 12 KiB.** That keeps them inside the 12 direct block pointers,
  so `ext2.js` never has to build an indirect block tree. `createFile` throws rather than
  silently doing something clever.
- **The injected service must reboot.** `birddog-update-wrapper` stops `BirdDogRunner` and only
  ever restarts it by rebooting. An installer that exits leaves the device with a dark HDMI
  output, looking bricked.
- **`/etc/rc.local` is left alone deliberately.** It runs `/etc/init.d/rcS` and is the most
  load-bearing script on the device. `ext2.js` can rewrite a file in place without touching a
  single bitmap — the capability is tested — but the injection uses a systemd unit instead,
  enabled the same way BirdDog enable their own.

## 5. Why this repo can be public

The same line the patcher draws. A flash needs **no vendor firmware and no vendor key**: the user
brings their own `.img`, and `MiniLoaderAll.bin` is extracted from it in the browser at run time.
Nothing of BirdDog's is redistributed.

`test/policy.test.mjs` enforces this — it fails if any `.img`, `.fw`, `.bin` or `.zip` is
committed, or if any file exceeds 256 KB. If you find yourself wanting to bundle a loader "for
convenience", that is the moment this stops being publishable.

## 6. What is and is not proven

Proven offline, against genuine vendor files:

- the RKFW/RKAF and RKBOOT parsers, against `PLAY_1.0.30.img` and its own loader;
- the ext2 injection — e2fsck accepts the patched 2.4 GB rootfs, and debugfs reads the injected
  files back with the right modes and ownership;
- the GPT, against an independent Python parser (and sgdisk in CI);
- the write plan: no two writes overlap, everything fits the device, the package lands past the
  filesystem and clear of `userdata`.

**Not proven:** anything involving an actual PLAY. No device has been flashed. The USB transport,
the loader handoff, the re-enumeration wait and the first-boot injection are all untested against
hardware. Keep the warning on the page honest until that changes.
