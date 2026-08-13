// UI glue. All the real work lives in the modules alongside this file, which is
// what lets the test suite drive the same code in Node without a browser.

import { parseRkfw, readLoader, findPartition, partitionBlob, parseParameter } from './rkfw.js';
import { RockUsb, waitForMode, usbMode, MASKROM, LOADER, RESET, SECTOR_SIZE } from './rockusb.js';
import { buildPlan, runPlan, verifyPlan } from './plan.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

let imgFile = null;
let pkgFile = null;
let fw = null;          // parsed .img
let rk = null;          // connected device
let plan = null;
let abort = null;

function log(msg, cls = '') {
  const line = document.createElement('div');
  line.className = `line ${cls}`;
  line.textContent = msg;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GiB`
  : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB`
    : `${(n / 1024).toFixed(1)} KiB`);

if (!navigator.usb) {
  $('unsupported').hidden = false;
  $('connect').disabled = true;
}

// ---- files ----------------------------------------------------------------

$('img').addEventListener('change', async (e) => {
  imgFile = e.target.files[0] || null;
  fw = null;
  if (!imgFile) return;
  try {
    fw = await parseRkfw(imgFile);
    const param = parseParameter(new TextDecoder('latin1').decode(
      new Uint8Array(await partitionBlob(fw, findPartition(fw, 'parameter')).arrayBuffer()),
    ));
    log(`image: ${fw.model} ${fw.chip}, built ${fw.built.year}-${String(fw.built.month).padStart(2, '0')}-${String(fw.built.day).padStart(2, '0')}`, 'ok');
    renderImage(fw, param);
  } catch (err) {
    log(`cannot read that image: ${err.message}`, 'err');
    $('imgInfo').innerHTML = '';
  }
  refresh();
});

$('pkg').addEventListener('change', (e) => {
  pkgFile = e.target.files[0] || null;
  if (pkgFile) log(`package: ${pkgFile.name}, ${fmtBytes(pkgFile.size)}`);
  refresh();
});

function renderImage(image, param) {
  const rows = image.partitions.filter((p) => p.flashed && p.name !== 'parameter').map((p) => `
    <tr><td>${p.name}</td><td class="num">${fmtBytes(p.size)}</td><td class="num">${p.flashAddr}</td></tr>`).join('');
  $('imgInfo').innerHTML = `
    <table>
      <tr><th>partition</th><th class="num">size</th><th class="num">sector</th></tr>
      ${rows}
    </table>
    <p class="hint">Partition table: ${param.TYPE}, ${param.partitions.length} entries.</p>`;
}

// ---- device ---------------------------------------------------------------

$('connect').addEventListener('click', async () => {
  try {
    rk = await RockUsb.request();
    await rk.open();
    $('devState').textContent = `${rk.mode} mode`;
    $('devState').classList.add('on');
    $('forget').hidden = false;
    log(`connected: ${rk.device.productName || 'Rockchip device'} in ${rk.mode} mode`, 'ok');
    if (rk.mode === MASKROM) {
      log('maskrom mode — the loader will be pushed from your .img before writing.', 'warn');
    }
    refresh();
  } catch (err) {
    if (err.name !== 'NotFoundError') log(`connect failed: ${err.message}`, 'err');
  }
});

$('forget').addEventListener('click', async () => {
  if (rk) await rk.close();
  rk = null;
  $('devState').textContent = 'not connected';
  $('devState').classList.remove('on');
  $('forget').hidden = true;
  refresh();
});

navigator.usb?.addEventListener('disconnect', (e) => {
  if (rk && e.device === rk.device) {
    log('device disconnected', 'warn');
    $('devState').textContent = 'not connected';
    $('devState').classList.remove('on');
    rk = null;
    refresh();
  }
});

function refresh() {
  $('flash').disabled = !(fw && rk) || abort !== null;
  const bits = [];
  if (!fw) bits.push('no image chosen');
  if (!rk) bits.push('no device connected');
  if (fw && rk) {
    bits.push(pkgFile
      ? `ready: full image plus ${pkgFile.name} injected`
      : 'ready: full image, nothing injected');
  }
  $('planInfo').innerHTML = `<p class="note">${bits.join(' · ')}</p>`;
}

// ---- flash ----------------------------------------------------------------

$('cancel').addEventListener('click', () => abort?.abort());

$('flash').addEventListener('click', async () => {
  if (!confirm('This erases the device completely, including its serial and /userdata. Continue?')) return;

  abort = new AbortController();
  $('flash').disabled = true;
  $('cancel').hidden = false;
  const started = Date.now();

  try {
    // 1. maskrom devices need the loader before they can take LBA writes.
    if (rk.mode === MASKROM) {
      log('pushing loader…');
      const loader = await readLoader(fw);
      await rk.downloadBoot(loader, (m) => log(`  ${m}`));
      await rk.close();
      log('waiting for the device to come back in loader mode…');
      const back = await waitForMode(LOADER, 20000);
      if (!back) throw new Error('device did not reappear in loader mode — reconnect it and try again');
      rk = back;
      await rk.open();
      log('loader running', 'ok');
    }

    // 2. geometry
    const info = await rk.readFlashInfo();
    const diskSectors = info.sectors;
    log(`device reports ${diskSectors} sectors (${fmtBytes(diskSectors * SECTOR_SIZE)})`);

    // 3. plan
    plan = await buildPlan(fw, { diskSectors, packageBlob: pkgFile });
    for (const n of plan.notes) log(`  ${n}`);
    log(`${plan.ops.length} writes, ${fmtBytes(plan.totalSectors * SECTOR_SIZE)} total`);

    // 4. write
    let lastOp = null;
    let lastTick = 0;
    await runPlan(rk, plan, {
      signal: abort.signal,
      onProgress: ({ op, totalDone, totalSectors }) => {
        if (op !== lastOp) { log(`writing ${op.name} → sector ${op.startSector}`); lastOp = op; }
        const pct = (totalDone / totalSectors) * 100;
        $('bar').style.width = `${pct.toFixed(1)}%`;
        if (Date.now() - lastTick > 1000) {
          lastTick = Date.now();
          const mbs = (totalDone * SECTOR_SIZE / (1 << 20)) / ((Date.now() - started) / 1000);
          $('planInfo').innerHTML = `<p class="note">${pct.toFixed(1)}% · ${mbs.toFixed(1)} MB/s</p>`;
        }
      },
    });
    log('all partitions written', 'ok');

    // 5. optional read-back
    if ($('verify').checked) {
      log('verifying…');
      const bad = await verifyPlan(rk, plan, {});
      if (bad.length) {
        for (const m of bad.slice(0, 10)) log(`  mismatch in ${m.op} at byte ${m.byte}`, 'err');
        throw new Error(`${bad.length} region(s) did not read back correctly`);
      }
      log('read-back matches', 'ok');
    }

    await rk.resetDevice(RESET.RESET_MSC);
    log(`done in ${Math.round((Date.now() - started) / 1000)}s — the device will reboot.`, 'ok');
    if (pkgFile) {
      log('First boot installs the injected package and reboots again; give it a few minutes '
        + 'before expecting video.', 'warn');
    }
  } catch (err) {
    log(err.message, 'err');
    log('The device is in an incomplete state. Leave it in recovery mode and flash again — '
      + 'that is what recovers it.', 'warn');
  } finally {
    abort = null;
    $('cancel').hidden = true;
    refresh();
  }
});
