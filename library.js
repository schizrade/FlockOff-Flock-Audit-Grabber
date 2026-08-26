/*
 * FlockOff CSV Grabber — Data library page behaviour.
 *
 * SPDX-License-Identifier: CC0-1.0
 *
 * This work is Public Domain and is not subject to
 * copyright protection in the United States (17 U.S.C. 105). To the extent
 * any rights exist outside the United States, they are waived worldwide
 * under the Creative Commons CC0 1.0 Universal Public Domain Dedication.
 *
 * Anyone may use, copy, modify, and redistribute this file, for any purpose,
 * commercial or not, without permission or fee. It comes with no warranty of
 * any kind. Credit is welcome but not required. See the LICENSE file.
 */

(function () {
  'use strict';

  const S = globalThis.FlockStore;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat();

  function say(message, tone) {
    const el = $('status');
    el.textContent = message || '';
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  }

  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 16).replace('T', ' ');
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // chrome.downloads gives a real Save As dialog inside the extension; the
  // anchor fallback keeps the page usable if the permission is missing.
  async function save(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      if (globalThis.chrome && chrome.downloads && chrome.downloads.download) {
        await chrome.downloads.download({ url, filename, saveAs: true });
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  async function withBusy(button, label, work) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      await work();
    } catch (e) {
      say(e && e.message ? e.message : String(e), 'warn');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // ---------------------------------------------------------------- render

  function renderBoard(info) {
    const board = $('board');
    board.textContent = '';
    const names = info.datasets.map((d) => d.name);
    // Dataset columns are capped so a library with two datasets doesn't stretch
    // each cell across half the screen; the agency column absorbs the slack.
    board.style.gridTemplateColumns = `minmax(180px, 1fr) repeat(${names.length + 1}, minmax(92px, 168px))`;

    const head = (text) => {
      const el = document.createElement('div');
      el.className = 'head';
      el.textContent = text;
      return el;
    };
    board.append(head('Agency'), head('Total'));
    names.forEach((n) => board.append(head(n)));

    let peak = 1;
    for (const d of info.datasets) {
      for (const n of Object.values(d.counts || {})) peak = Math.max(peak, n);
    }

    for (const agency of info.agencies) {
      const label = document.createElement('div');
      label.className = 'agency';
      label.textContent = agency.key;
      label.title = agency.key;
      board.append(label);

      const total = document.createElement('div');
      total.className = 'cell';
      total.innerHTML = '<span class="n total"></span>';
      total.querySelector('.n').textContent = nf.format(agency.rows);
      board.append(total);

      for (const name of names) {
        const dataset = info.datasets.find((d) => d.name === name);
        const count = (dataset && dataset.counts && dataset.counts[agency.key]) || 0;
        const cell = document.createElement('div');
        cell.className = count ? 'cell' : 'cell gap';
        cell.title = count
          ? `${agency.key} — ${name}: ${nf.format(count)} rows`
          : `${agency.key} has no ${name} rows yet`;
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = count ? nf.format(count) : '—';
        const fill = document.createElement('span');
        fill.className = 'fill';
        fill.style.width = count ? `${Math.max(2, Math.round((count / peak) * 100))}%` : '100%';
        cell.append(n, fill);
        board.append(cell);
      }
    }
  }

  function renderDatasets(info) {
    const body = $('datasets').querySelector('tbody');
    body.textContent = '';
    for (const d of info.datasets) {
      const tr = document.createElement('tr');
      const cells = [
        ['name', d.name],
        ['num', nf.format(d.rows || 0)],
        ['num', String(Object.entries(d.counts || {}).filter(([, n]) => n > 0).length)],
        ['num', String((d.headers || []).length)],
        ['when', when(d.updated)],
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.append(td);
      }

      const act = document.createElement('td');
      act.className = 'act';
      const remove = document.createElement('button');
      remove.className = 'link';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        if (remove.dataset.armed !== '1') {
          remove.dataset.armed = '1';
          remove.textContent = 'Delete for good?';
          setTimeout(() => {
            if (remove.dataset.armed === '1') { remove.dataset.armed = ''; remove.textContent = 'Delete'; }
          }, 5000);
          return;
        }
        withBusy(remove, 'Deleting…', async () => {
          const removed = await S.deleteDataset(d.name);
          say(`Deleted ${d.name} — ${nf.format(removed)} rows.`);
          await refresh();
        });
      });
      act.append(remove);
      tr.append(act);
      body.append(tr);
    }
  }

  function renderRuns(info) {
    const body = $('runs').querySelector('tbody');
    body.textContent = '';
    for (const r of info.runs) {
      const tr = document.createElement('tr');
      const cells = [
        ['when', when(r.started)],
        ['num', nf.format(r.portals || 0)],
        ['num', nf.format(r.inserted || 0)],
        ['num', nf.format(r.duplicate || 0)],
        ['when', r.note || ''],
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.append(td);
      }
      body.append(tr);
    }
  }

  async function refresh() {
    const info = await S.summary();
    const has = info.totalRows > 0 || info.datasets.length > 0;

    $('tally').innerHTML = has
      ? `<b>${nf.format(info.totalRows)}</b> rows &middot; <b>${info.datasets.length}</b> datasets `
        + `&middot; <b>${info.agencies.length}</b> agencies &middot; last added ${when(info.updated)}`
      : 'Empty.';

    $('empty').hidden = has;
    $('coverage-section').hidden = !has;
    $('datasets-section').hidden = !has;
    $('runs-section').hidden = !info.runs.length;
    for (const id of ['save-workbook', 'save-csvs', 'save-backup']) $(id).disabled = !has;

    if (has) { renderBoard(info); renderDatasets(info); }
    if (info.runs.length) renderRuns(info);
    return info;
  }

  // ---------------------------------------------------------------- import

  // The grabber writes 'agency__dataset.csv'. Anything else is filed under its
  // own name so nothing is silently dropped or mislabelled.
  function splitName(filename) {
    const stem = filename.replace(/\.(csv|tsv|txt)$/i, '');
    if (stem.includes('__')) {
      const [agency, ...rest] = stem.split('__');
      return {
        agency: agency.trim() || 'unknown',
        dataset: rest.join('__').replace(/[\s-]+/g, '_').toLowerCase().trim() || 'data',
      };
    }
    return { agency: stem.trim() || 'unknown', dataset: 'data' };
  }

  async function addFiles(files) {
    const list = [...files].filter((f) => /\.(csv|tsv|txt)$/i.test(f.name));
    if (!list.length) { say('No CSV files in that selection.', 'warn'); return; }

    let inserted = 0;
    let duplicate = 0;
    const skipped = [];
    const runId = 'import-' + Date.now();

    for (const file of list) {
      say(`Reading ${file.name}…`);
      const text = await file.text();
      if (!globalThis.FlockCsv.looksLikeCsv(text)) { skipped.push(file.name); continue; }
      const { agency, dataset } = splitName(file.name);
      const result = await S.ingestCsv({
        agency, dataset, text, sourceFile: file.name, runId,
      });
      if (result.empty) { skipped.push(file.name); continue; }
      inserted += result.inserted;
      duplicate += result.duplicate;
    }

    await S.recordRun({
      id: runId,
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
      portals: list.length - skipped.length,
      inserted,
      duplicate,
      note: 'Added from files' + (skipped.length ? ` — skipped ${skipped.length}` : ''),
    });

    await refresh();
    const parts = [`Added ${nf.format(inserted)} rows from ${list.length - skipped.length} file(s)`];
    if (duplicate) parts.push(`${nf.format(duplicate)} already in the library`);
    if (skipped.length) parts.push(`skipped ${skipped.join(', ')}`);
    say(parts.join(' · '), skipped.length ? 'warn' : undefined);

    if (inserted && !duplicate && list.length > 1) {
      // A re-pull that produces zero duplicates usually means a column changes
      // on every export and is sitting inside the fingerprint.
      say(`${parts.join(' · ')} — if these were re-downloads, check Duplicate matching below.`);
    }
  }

  // --------------------------------------------------------------- settings

  async function loadSettings() {
    const config = await S.getConfig();
    $('ignore').value = (config.keyIgnore || []).join('\n');
  }

  // ------------------------------------------------------------------ wire

  $('save-workbook').addEventListener('click', (e) => withBusy(e.target, 'Building…', async () => {
    say('Building the workbook…');
    const blob = await S.buildWorkbook();
    await save(blob, `flock_library_${stamp()}.xlsx`);
    say('Workbook saved.');
  }));

  $('save-csvs').addEventListener('click', (e) => withBusy(e.target, 'Building…', async () => {
    const blob = await S.buildCsvBundle();
    await save(blob, `flock_csv_${stamp()}.zip`);
    say('CSVs saved.');
  }));

  $('save-backup').addEventListener('click', (e) => withBusy(e.target, 'Building…', async () => {
    const blob = await S.exportBackup();
    await save(blob, `flock_backup_${stamp()}.jsonl`);
    say('Backup saved. Keep this — it restores the library exactly, with no duplicates.');
  }));

  $('pick-csv').addEventListener('click', () => $('file-csv').click());
  $('pick-backup').addEventListener('click', () => $('file-backup').click());

  $('file-csv').addEventListener('change', async (e) => {
    const files = e.target.files;
    e.target.value = '';
    if (files && files.length) await addFiles(files);
  });

  $('file-backup').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    say('Restoring…');
    try {
      const result = await S.importBackup(await file.text());
      await refresh();
      say(`Restored ${nf.format(result.rows)} rows across ${result.datasets} dataset(s)`
        + (result.skipped ? ` · ${nf.format(result.skipped)} already present` : '') + '.');
    } catch (err) {
      say(`Could not read that backup: ${err.message}`, 'warn');
    }
  });

  $('save-ignore').addEventListener('click', (e) => withBusy(e.target, 'Saving…', async () => {
    const lines = $('ignore').value.split('\n').map((s) => s.trim()).filter(Boolean);
    await S.setConfig({ keyIgnore: lines });
    say(`Duplicate matching updated — ${lines.length} column(s) left out of the comparison.`);
  }));

  $('reset-ignore').addEventListener('click', (e) => withBusy(e.target, 'Resetting…', async () => {
    await S.setConfig({ keyIgnore: S.DEFAULT_KEY_IGNORE.slice() });
    await loadSettings();
    say('Reset to the default columns.');
  }));

  $('erase').addEventListener('click', () => {
    $('erase').hidden = true;
    $('erase-confirm').hidden = false;
  });

  $('erase-no').addEventListener('click', () => {
    $('erase-confirm').hidden = true;
    $('erase').hidden = false;
  });

  $('erase-yes').addEventListener('click', (e) => withBusy(e.target, 'Erasing…', async () => {
    await S.wipe();
    $('erase-confirm').hidden = true;
    $('erase').hidden = false;
    await refresh();
    say('Library erased.');
  }));

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    dragDepth++;
    $('dropzone').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropzone').hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) await addFiles(e.dataTransfer.files);
  });

  (async () => {
    try {
      await loadSettings();
      await refresh();
    } catch (err) {
      say(`Could not open the library: ${err.message}`, 'warn');
    }
  })();
})();
