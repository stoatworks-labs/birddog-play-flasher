# Attributions

This tool ships no vendor firmware, and no third-party code beyond the desktop launcher's
(below). It does, however, implement a protocol and two container formats that were
documented by other people's work.

## rkdeveloptool — Rockchip

<https://github.com/rockchip-linux/rkdeveloptool>

The USB protocol in `public/rockusb.js` and the partition table in `public/gpt.js` are
implemented from rkdeveloptool's source (`RKComm.h`, `RKComm.cpp`, `RKDevice.cpp`, `RKScan.cpp`,
`main.cpp`, `crc.cpp`). No code is copied; the constants, the CBW/CSW layout, the maskrom vendor
request and the GPT construction all follow it deliberately, because matching the vendor tool's
behaviour is the point.

rkdeveloptool is distributed under the GNU General Public License v2.

## Rockchip container formats

`RKFW`, `RKAF`, `RKBOOT` and the `RSCE` resource format are Rockchip's. The parsers here were
derived by inspection of a factory image, and the Python original they are ported from lives in
a private research repo.

## ext2

`public/ext2.js` implements the on-disk format described in the ext2 documentation and in
e2fsprogs. The test suite uses `mke2fs`, `e2fsck` and `debugfs` from
[e2fsprogs](https://e2fsprogs.sourceforge.net/) as independent judges of what it writes;
e2fsprogs is not bundled or redistributed here.

## Tauri

The desktop builds ship the launcher in `launcher/`, built on
[Tauri](https://tauri.app) (MIT or Apache-2.0). Its Rust crates are pinned in
`launcher/src-tauri/Cargo.lock`.

## BirdDog

BirdDog is a trademark of its owner. This project is not affiliated with, endorsed by, or
supported by BirdDog, and redistributes none of their software. The firmware images this tool
operates on are supplied by the user.
