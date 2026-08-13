# BirdDog PLAY recovery flasher

A static web page that flashes a BirdDog PLAY in Rockchip recovery mode over USB, straight from
the browser — and, optionally, **injects a `.fw` update package into the image** so the device
installs it on first boot.

No upload, no server, no vendor key. You supply your own factory `.img`; the loader that gets
pushed over USB is extracted from that file in the browser at run time. That is the only reason
this repo can be public — see [AGENTS.md](AGENTS.md) §5.

> **Nothing here has been run against a PLAY yet.** The image parsing, the filesystem injection
> and the partition table are covered by tests against genuine vendor files. The USB half is
> written from rkdeveloptool's protocol, not from observation.

## What it does

| | |
|---|---|
| **Flash a factory `.img`** | Whole device: bootloader, u-boot, trust, kernel, DTB, rootfs, partition table. This is the brick-recovery path. |
| **Inject a `.fw`** | Parks the package in the unused tail of the rootfs partition and adds a one-shot service that installs it on first boot via the device's own updater. |
| **Verify** | Optional read-back and compare of everything written. |

## Why injection works

A `.fw` is not a partition image — it is a gzip'd tar whose `./update` runs as root **on a booted
device**. In maskrom mode there is no OS to run it, so it cannot simply be flashed. Two facts
from the factory image make the injection clean:

- **The rootfs partition has a 1.26 GiB hole.** `parameter.txt` gives rootfs 7,340,032 sectors
  (3.5 GiB) while `rootfs.img` is 2,399,595,520 bytes (2.235 GiB). Nothing ever grows into it —
  only `userdata:grow` grows, and that is a different partition. The package lives there as raw
  bytes, costing no filesystem space.
- **The rootfs is plain ext2** — `dir_index filetype` and nothing else. No journal, no extents,
  no metadata checksums. So three small files can be added to it correctly from JavaScript, and
  e2fsck agrees.

On first boot the injected service `dd`s the package back off the partition, hands it to
`BirdDogUpdateRunner` exactly as the vendor's own network path does, waits for the updater to
finish, and reboots. It marks itself done **before** installing, so a package that kills the box
cannot reinstall itself on every boot.

## Getting a PLAY into recovery mode

1. Power the unit off.
2. Hold the recovery button while applying power; keep holding for a few seconds.
3. Connect USB. The unit enumerates as vendor `2207`, in either *maskrom* or *loader* mode —
   the page reports which and handles both.

**Windows** needs [Zadig](https://zadig.akeo.ie/) to rebind the device to WinUSB, because
Rockchip's own driver claims it and WebUSB cannot then reach it. macOS needs nothing. Linux
needs a udev rule for `2207:*`.

## Pushing a `.fw` over the network instead

This page deliberately does **not** do the network update, and cannot: an HTTPS page may not
reach a plain-HTTP device on your LAN, and a browser tab cannot serve a file for the device to
fetch. By hand it is two commands, and the API on port 8080 needs no login:

```bash
python3 -m http.server 8000
```

```bash
curl "http://<play-ip>:8080/update?ip=<your-ip>&port=8000&firmware=package.fw"
```

The device fetches the file, writes `/tmp/birddog-update-package`, takes the update lock and
starts `BirdDogUpdateRunner`. Progress streams from `ws://<play-ip>:6789` while it runs.

## Tests

```bash
npm test
```

CI-safe tests build their own ext2 filesystem with `mke2fs` and check the result with `e2fsck`,
`debugfs` and an independent Python GPT parser — no vendor files involved. The end-to-end tests
need real firmware and are skipped unless you point them at your own copies:

```bash
PLAY_IMG=~/Downloads/PLAY_1.0.30.img PLAY_FW=~/fw/BirdDog_PLAY-1.0.34.fw npm test
```

## Deploying

```bash
cf-run npx wrangler deploy
```

Assets only — there is no Worker, because there is nothing for a server to do. Deliberately not
connected to Workers Builds, so pushing a branch cannot publish to production.

## Licence

MIT. Built with AI assistance. Not affiliated with, endorsed by, or supported by BirdDog.
