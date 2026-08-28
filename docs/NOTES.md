# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*PUBLIC-able browser WebUSB flasher for BirdDog PLAY recovery mode, with .fw injection into the .img; built 2026-08-13, nothing run on hardware*

`~/Projects/birddog-play-flasher` — static page, WebUSB, flashes a factory `.img` to a PLAY in
Rockchip recovery mode and can **inject a `.fw` into the image** so it self-installs on first
boot. Sibling to [birddog play patcher](https://github.com/stoatworks-labs/birddog-play-patcher/blob/main/docs/NOTES.md) (`birddog-play-patcher`) (which *builds* `.fw`). Built 2026-08-13.
**LIVE as beta** at `birddog-play-flasher.stoatworks-labs.com` (+ the workers.dev URL, kept
alive with an explicit `workers_dev = true` since a route otherwise silently disables it —
it 404s for ~10s after deploy, then comes up). Assets-only Worker, no Worker script at all.
**PUBLIC at `github.com/stoatworks-labs/birddog-play-flasher`**, CI green.
- `gh auth status` labels the keyring account **`allansargeant`** but `gh api user` returns login
  **`stoatworks-labs`** (id 8385907) — same token, misleading label. Don't conclude you're on the
  wrong account.
- `gh repo create --push` pushes to **`master`**; the fleet and every CI trigger use `main`.
  Rename + `gh repo edit --default-branch main` + delete the remote master, or CI never fires.
- **`node --test "glob"` only self-expands from Node 21.** Quoted, it passes locally (Node 26)
  and fails on CI's Node 20. Leave the glob unquoted so the shell expands it.

**Shape was forced by mixed content, not preference.** An https page cannot fetch
`http://192.168.x.x` or open `ws://`, and a browser tab cannot listen on a port — so the
**network `.fw` push is impossible from a hosted page** and was dropped (README documents the
manual two-command procedure instead). WebUSB only needs a secure context, so the USB half is
fine hosted. User chose hosted-static-USB-only over a local CLI.

**The injection trick — no big ext2 writes needed:**
- rootfs PARTITION is 7,340,032 sectors (3.5 GiB) but `rootfs.img` is 2,399,595,520 B
  (4,686,710 sectors) → **~1.26 GiB hole nothing ever touches** (only `userdata:grow` grows).
  The 43.5 MB `.fw` goes there raw, 1 MiB-aligned, at partition-relative sector 4,687,872.
- **Factory rootfs is plain ext2** — features are ONLY `dir_index filetype`. No journal, no
  extents, no metadata_csum, no sparse_super, 1 KiB blocks, 128-byte inodes. That is what makes
  a JS writer viable. Keeping injected files **under 12 KiB = direct blocks only**, no indirect
  trees. Only the primary superblock + group descriptors are updated (e2fsck doesn't compare
  backups).
- Only 3 files added (script + systemd unit + `multi-user.target.wants` symlink) = **19-20
  patched blocks** on a 2.4 GB image. `/etc/rc.local` deliberately NOT touched (it runs
  `/etc/init.d/rcS`); the in-place-rewrite capability exists and is tested but is unused.

**Verified offline against real vendor files** (`~/Downloads/PLAY_1.0.30.img` + the 1.0.34 `.fw`):
parsers, GPT (independent Python parser checks both CRCs), no-overlap write plan, and **e2fsck
accepts the patched 2.4 GB rootfs** with debugfs reading the files back at 0755 root-owned.
**Proven against a real PLAY on 2026-08-15** (1733be7, 21e7e23): the loader push — ENTRY472
was timing out because we claimed the interface before sending vendor control transfers, which
rkdeveloptool never does; the re-enumeration after that push, measured (a write immediately
after a successful `db` found no rockusb device, the same command three seconds later
succeeded); and read-back verification, which was calling good writes corrupt because this
device returns 0xCC fill at and above sector 0x10000 — shown with factory partitions this tool
has never written. **The first-boot install of an injected package is still unproven** — no
device has been seen to boot and apply one. The page says so and AGENTS.md §6 lists it.

**Protocol traps (all from rkdeveloptool source, not observation):**
- maskrom vendor request: `bmRequestType 0x40, bRequest 0x0C`, **wValue 0 and 0x0471/0x0472 in
  wIndex** — libusb's arg order makes this easy to reverse; wrong way round = silent no-op.
- Inside the CBWCB, **`dwAddress` and `usLength` are BIG-endian** while the CBW around them is
  little-endian. Same silent failure.
- Mode is **`bcdUSB & 1`** (0=maskrom, 1=loader), NOT the PID — RK3328's PID isn't even in
  rkdeveloptool's table. VID `0x2207`.
- CRC-16 is poly 0x1021 **init 0x0000** (not CCITT-FALSE), appended big-endian.
- **`parameter.txt` is NEVER written raw** despite its RKAF entry claiming sector 0 — that's the
  protective MBR. Its mtdparts CMDLINE becomes a GPT (master @0, backup @disk-33).
- `package-file`/`bootloader` have flashAddr `0xFFFFFFFF`, `backup` is RESERVED size 0 — all
  metadata, never flashed.
- `DEFAULT_RW_LBA` = 128 sectors (64 KiB) per WRITE_LBA.

**Windows needs Zadig** (Rockchip's driver claims the device, WebUSB needs WinUSB). macOS fine.

Related: [birddog re](https://github.com/stoatworks-labs/birddog-re/blob/main/docs/NOTES.md) (`birddog-re`) (notes/08 = the recovery image), [agents md convention](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_agents_md_convention.md),
**disclaimer scope** (working-practice note, kept in Claude memory).
