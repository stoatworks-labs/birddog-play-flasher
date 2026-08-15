// UI glue. All the real work lives in the modules alongside this file, which is
// what lets the test suite drive the same code in Node without a browser.

import { parseRkfw, readLoader, findPartition, partitionBlob, parseParameter } from './rkfw.js';
import { RockUsb, waitForMode, usbMode, MASKROM, LOADER, RESET, SECTOR_SIZE } from './rockusb.js';
import { buildPlan, runPlan, verifyPlan, findReadCeiling } from './plan.js';
import { readDeviceGpt, buildPartitionPlan, guessPartition } from './partwrite.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

let imgFile = null;
let pkgFile = null;
let fw = null;          // parsed .img
let rk = null;          // connected device
let plan = null;
let abort = null;
let partFiles = [];     // partition-write mode: the chosen files
let deviceParts = null; // the device's own GPT, read after connecting

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

$('parts').addEventListener('change', (e) => {
  partFiles = [...e.target.files];
  if (partFiles.length) {
    log(`${partFiles.length} partition image(s): ${partFiles.map((f) => f.name).join(', ')}`);
    if (!deviceParts) log('connect the device to choose which partition each one goes to');
  }
  renderPartMap();
  refresh();
});

// One row per file: the filename, and which partition it is aimed at. The
// targets come from the device, so this list is empty until one is connected —
// which is the point, rather than an inconvenience.
function renderPartMap() {
  const el = $('partMap');
  if (!partFiles.length) { el.innerHTML = ''; return; }
  if (!deviceParts) {
    el.innerHTML = '<p class="note">Connect a device to read its partition table.</p>';
    return;
  }
  const rows = partFiles.map((f, i) => {
    const guess = guessPartition(f.name, deviceParts);
    const opts = ['<option value="">— do not write —</option>']
      .concat(deviceParts.map((p) => {
        const cap = p.sectors * SECTOR_SIZE;
        const fits = f.size <= cap;
        const sel = p.name === guess ? ' selected' : '';
        return `<option value="${p.name}"${sel}${fits ? '' : ' disabled'}>`
          + `${p.name} — ${fmtBytes(cap)} at sector 0x${p.firstLba.toString(16)}`
          + `${fits ? '' : ' (too small)'}</option>`;
      }));
    return `<tr><td><code>${f.name}</code></td><td class="note">${fmtBytes(f.size)}</td>`
      + `<td><select data-part-for="${i}">${opts.join('')}</select></td></tr>`;
  });
  el.innerHTML = `<table class="partmap"><tbody>${rows.join('')}</tbody></table>`
    + '<p class="hint">Partitions the device needs to be recoverable are refused unless you '
    + 'tick the override below.</p>'
    + '<label class="note"><input type="checkbox" id="allowProtected"> '
    + 'allow writing uboot / trust / recovery</label>';
  el.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', refresh));
}

function partAssignments() {
  const out = [];
  document.querySelectorAll('[data-part-for]').forEach((sel) => {
    if (!sel.value) return;
    const f = partFiles[Number(sel.dataset.partFor)];
    out.push({ partition: sel.value, blob: f, label: f.name });
  });
  return out;
}

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
    await loadDeviceParts();
    refresh();
  } catch (err) {
    if (err.name !== 'NotFoundError') log(`connect failed: ${err.message}`, 'err');
  }
});

// The partition table, read off the device. Only possible in loader mode: a
// maskrom device cannot serve LBA reads until a loader has been pushed into it,
// and the loader comes out of a factory image.
async function loadDeviceParts() {
  deviceParts = null;
  if (!rk || rk.mode !== LOADER) {
    if (partFiles.length) {
      log('partition writing needs loader mode; a maskrom device needs a factory image first.', 'warn');
    }
    renderPartMap();
    return;
  }
  try {
    deviceParts = await readDeviceGpt(rk);
    log(`device partition table: ${deviceParts.map((p) => p.name).join(', ')}`, 'ok');
  } catch (err) {
    // Not fatal — restoring a factory image writes a fresh table anyway, and a
    // blank or damaged one is a normal reason to be holding this tool.
    log(`could not read a partition table: ${err.message}`, 'warn');
    if (partFiles.length) {
      log('without a table there is nothing to aim partition writes at. Restore a factory '
        + 'image first, then write partitions.', 'warn');
    }
  }
  renderPartMap();
}

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
  const assignments = partFiles.length ? partAssignments() : [];
  const partMode = assignments.length > 0;
  const bits = [];

  if (partMode) {
    // Partition mode wins when targets have been chosen: the two are different
    // operations and doing both at once is never what anyone means.
    $('flash').disabled = !rk || abort !== null;
    $('flash').textContent = 'Write partitions';
    bits.push(assignments.map((a) => `${a.label} → ${a.partition}`).join(' · '));
    if (fw) bits.push('the factory image is ignored while partitions are targeted');
  } else {
    $('flash').disabled = !(fw && rk) || abort !== null;
    $('flash').textContent = 'Flash device';
    if (!fw) bits.push('no image chosen');
    if (!rk) bits.push('no device connected');
    if (fw && rk) {
      bits.push(pkgFile
        ? `ready: full image plus ${pkgFile.name} injected`
        : 'ready: full image, nothing injected');
    }
  }
  $('planInfo').innerHTML = `<p class="note">${bits.join(' · ')}</p>`;
}

// ---- flash ----------------------------------------------------------------

$('cancel').addEventListener('click', () => abort?.abort());

$('flash').addEventListener('click', async () => {
  if (partFiles.length && partAssignments().length) {
    await writePartitions();
    return;
  }
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
      const ceiling = await probeReadCeiling();
      const { mismatches, skipped } = await verifyPlan(rk, plan, { readCeiling: ceiling });
      if (mismatches.length) {
        for (const m of mismatches.slice(0, 10)) log(`  mismatch in ${m.op} at byte ${m.byte}`, 'err');
        throw new Error(`${mismatches.length} region(s) did not read back correctly`);
      }
      for (const s2 of skipped) {
        log(`  ${s2.op}: not verified from sector ${s2.startSector ?? s2.fromSector} — above this device's read ceiling`, 'warn');
      }
      log(skipped.length ? 'read-back matches as far as this device can be read'
                         : 'read-back matches', 'ok');
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


/**
 * Ask the device how far it can be read back, using partitions whose content is
 * not ours — a factory partition that reads as fill is the device's limitation,
 * not our write's failure. Returns null when everything probed reads properly.
 */
async function probeReadCeiling() {
  if (!deviceParts) return null;
  // Ascending, so the first fill we hit is the lowest known bad point.
  const probes = deviceParts
    .filter((p) => ['uboot', 'trust', 'misc', 'recovery', 'oem'].includes(p.name))
    .sort((a, b) => a.firstLba - b.firstLba)
    .map((p) => p.firstLba);
  if (!probes.length) return null;
  const ceiling = await findReadCeiling(rk, probes);
  if (ceiling !== null) {
    log(`this device returns fill rather than data at and above sector `
      + `0x${ceiling.toString(16)} — verification cannot see past it`, 'warn');
    log('  (a factory partition that was never written reads as fill there, so this '
      + 'is the device, not the write)', 'warn');
  }
  return ceiling;
}

// ---- partition writing ------------------------------------------------------
//
// The other button restores a whole factory image. This one writes only the
// partitions named, and leaves everything else — including the vendor's
// recovery partition — untouched. That difference is the whole reason it
// exists, so the confirmation says exactly what will be written and where.

async function writePartitions() {
  let plan2;
  try {
    plan2 = buildPartitionPlan(deviceParts, partAssignments(), {
      allowProtected: !!$('allowProtected')?.checked,
    });
  } catch (err) {
    log(err.message, 'err');
    return;
  }

  const summary = plan2.ops
    .map((o) => `  ${o.name}  ←  ${fmtBytes(o.byteLength)}  at sector 0x${o.startSector.toString(16)}`)
    .join('\n');
  const untouched = deviceParts
    .filter((p) => !plan2.ops.some((o) => o.name === p.name))
    .map((p) => p.name).join(', ');
  if (!confirm(
    `Write these partitions?\n\n${summary}\n\n`
    + `Left untouched: ${untouched}\n\n`
    + 'Anything already in those partitions is replaced.',
  )) return;

  abort = new AbortController();
  $('flash').disabled = true;
  $('cancel').hidden = false;
  const started = Date.now();

  try {
    for (const n of plan2.notes) log(`  ${n}`);
    log(`${plan2.ops.length} write(s), ${fmtBytes(plan2.totalSectors * SECTOR_SIZE)} total`);

    let lastOp = null;
    let lastTick = 0;
    await runPlan(rk, plan2, {
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
    log('partitions written', 'ok');

    if ($('verify').checked) {
      log('verifying…');
      const ceiling = await probeReadCeiling();
      const { mismatches, skipped } = await verifyPlan(rk, plan2, { readCeiling: ceiling });
      if (mismatches.length) {
        for (const m of mismatches.slice(0, 10)) log(`  mismatch in ${m.op} at byte ${m.byte}`, 'err');
        throw new Error(`${mismatches.length} region(s) did not read back correctly`);
      }
      for (const s2 of skipped) {
        log(`  ${s2.op}: not verified from sector 0x${s2.fromSector.toString(16)} — above this device's read ceiling`, 'warn');
      }
      log(skipped.length ? 'read-back matches as far as this device can be read'
                         : 'read-back matches', 'ok');
    }

    await rk.resetDevice(RESET.RESET_MSC);
    log(`done in ${Math.round((Date.now() - started) / 1000)}s — the device will reboot.`, 'ok');
    log('If it does not come up, it is still recoverable: the loader and the vendor recovery '
      + 'partition were not written. Put it back in loader mode and restore a factory image.', 'warn');
  } catch (err) {
    log(err.message, 'err');
    log('Partitions may be half written. Nothing that recovers the device was touched — '
      + 'leave it in loader mode and either write again or restore a factory image.', 'warn');
  } finally {
    abort = null;
    $('cancel').hidden = true;
    refresh();
  }
}
