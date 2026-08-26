/*
 * FlockOff CSV Grabber — The data library: durable storage and workbook export.
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

// The data library.
//
// Every row ever collected lives here, keyed by a fingerprint of its own
// contents, so re-pulling an agency never duplicates what you already have.
// The workbook is a *view* of this store, rebuilt on demand — it is never
// edited in place, and losing it costs nothing.
//
// Requires lib/csv.js. Uses lib/xlsx.js when exporting a workbook.
// Exposes globalThis.FlockStore.

(function () {
  'use strict';

  const DB_NAME = 'flock-library';
  const DB_VERSION = 1;

  const ROWS = 'rows';
  const DATASETS = 'datasets';
  const RUNS = 'runs';
  const META = 'meta';

  const META_COLUMNS = ['agency', 'source_file', 'first_seen', 'run_id'];

  // Columns that change on every export and would otherwise make each re-pull
  // look like a fresh set of rows. Matching ignores case, spaces, underscores
  // and hyphens, so 'Generated At' and 'generated_at' are the same column.
  //
  // Kept deliberately narrow. Excluding a column from the fingerprint means two
  // rows that differ *only* in that column collapse into one, so anything that
  // could plausibly be real data — 'report date', 'run date' — is not here.
  const DEFAULT_KEY_IGNORE = [
    'generated', 'generated at', 'date generated', 'file generated', 'csv generated',
    'exported', 'exported at', 'export date', 'export time', 'date exported',
    'downloaded', 'downloaded at', 'download date', 'date downloaded',
    'retrieved', 'retrieved at', 'timestamp of export',
  ];

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ROWS)) {
          const rows = db.createObjectStore(ROWS, { keyPath: 'id' });
          rows.createIndex('dataset', 'dataset', { unique: false });
          rows.createIndex('agency', 'agency', { unique: false });
          rows.createIndex('dataset_agency', ['dataset', 'agency'], { unique: false });
        }
        if (!db.objectStoreNames.contains(DATASETS)) {
          db.createObjectStore(DATASETS, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(RUNS)) {
          db.createObjectStore(RUNS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(
        'The library is open in another tab. Close it and try again.'));
    });
    return dbPromise;
  }

  function tx(db, names, mode) {
    const t = db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
    return { t, done };
  }

  function get(store, key) {
    return new Promise((resolve, reject) => {
      const r = store.get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function all(store) {
    return new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  }

  // ------------------------------------------------------------ fingerprint

  // 128-bit content hash. Synchronous on purpose: hashing tens of thousands of
  // rows through crypto.subtle would mean tens of thousands of promises for no
  // security benefit — this key is a duplicate check, not a signature.
  function hash128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
      .map((n) => n.toString(16).padStart(8, '0')).join('');
  }

  const normalizeColumn = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

  function makeIgnoreTest(list) {
    const set = new Set((list || []).map(normalizeColumn).filter(Boolean));
    return (column) => set.has(normalizeColumn(column));
  }

  // Sorting the pairs makes the key stable when an agency reorders its columns
  // or adds one that is blank for existing rows.
  function rowKey(dataset, agency, values, ignore) {
    const pairs = [];
    for (const key of Object.keys(values)) {
      const v = values[key];
      if (v == null || String(v).trim() === '') continue;
      if (ignore(key)) continue;
      pairs.push(key + '\u0002' + String(v).trim());
    }
    pairs.sort();
    return hash128(dataset + '\u0000' + agency + '\u0000' + pairs.join('\u0001'));
  }

  // ---------------------------------------------------------------- config

  async function getConfig() {
    const db = await open();
    const { t } = tx(db, [META], 'readonly');
    const stored = await get(t.objectStore(META), 'config');
    return Object.assign({
      keyIgnore: DEFAULT_KEY_IGNORE.slice(),
    }, (stored && stored.v) || {});
  }

  async function setConfig(patch) {
    const current = await getConfig();
    const next = Object.assign({}, current, patch);
    const db = await open();
    const { t, done } = tx(db, [META], 'readwrite');
    t.objectStore(META).put({ k: 'config', v: next });
    await done;
    return next;
  }

  // ---------------------------------------------------------------- ingest

  /**
   * Add one agency's copy of one dataset.
   *
   * @param {object} input
   * @param {string} input.agency     agency key, e.g. 'monrovia-ca-pd'
   * @param {string} input.dataset    dataset name, e.g. 'public_search_audit'
   * @param {string[]} input.headers  column names as published by this agency
   * @param {Array<Array<*>>} input.rows
   * @param {string} [input.sourceFile]
   * @param {string} [input.portalUrl]
   * @param {string} [input.runId]
   * @returns {Promise<{inserted:number, duplicate:number, dataset:string}>}
   */
  async function ingest(input) {
    const agency = String(input.agency || 'unknown').trim() || 'unknown';
    const dataset = String(input.dataset || 'data').trim() || 'data';
    const headers = (input.headers || []).map((h, i) => String(h).trim() || `col_${i + 1}`);
    const rows = input.rows || [];
    const sourceFile = input.sourceFile || '';
    const runId = input.runId || '';
    const seen = new Date().toISOString();

    if (!headers.length) return { inserted: 0, duplicate: 0, dataset };

    const config = await getConfig();
    const ignore = makeIgnoreTest(config.keyIgnore);
    const db = await open();

    let inserted = 0;
    let duplicate = 0;

    // Chunked so a large export does not sit inside one long transaction.
    const CHUNK = 2000;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const slice = rows.slice(start, start + CHUNK);
      const { t, done } = tx(db, [ROWS], 'readwrite');
      const store = t.objectStore(ROWS);

      for (const raw of slice) {
        const values = {};
        let empty = true;
        for (let i = 0; i < headers.length; i++) {
          const v = raw[i];
          if (v == null) continue;
          const s = String(v);
          if (s.trim() !== '') empty = false;
          values[headers[i]] = s;
        }
        if (empty) continue;

        const id = rowKey(dataset, agency, values, ignore);
        const req = store.add({
          id, dataset, agency, added: seen, run: runId, src: sourceFile, v: values,
        });
        req.onsuccess = () => { inserted++; };
        req.onerror = (event) => {
          // ConstraintError means we already hold this row. Swallow it so the
          // transaction survives; anything else is a real failure.
          if (req.error && req.error.name === 'ConstraintError') {
            duplicate++;
            event.preventDefault();
            event.stopPropagation();
          }
        };
      }
      await done;
    }

    // Union this agency's columns into the dataset definition and update counts.
    {
      const { t, done } = tx(db, [DATASETS], 'readwrite');
      const store = t.objectStore(DATASETS);
      const existing = (await get(store, dataset)) || {
        name: dataset, headers: [], counts: {}, rows: 0,
        created: seen, updated: seen, sources: {},
      };
      for (const h of headers) {
        if (!existing.headers.includes(h)) existing.headers.push(h);
      }
      existing.counts[agency] = (existing.counts[agency] || 0) + inserted;
      existing.rows = (existing.rows || 0) + inserted;
      existing.updated = seen;
      if (input.portalUrl) existing.sources[agency] = input.portalUrl;
      store.put(existing);
      await done;
    }

    return { inserted, duplicate, dataset, agency };
  }

  /** Convenience wrapper: ingest raw CSV text. */
  async function ingestCsv(input) {
    const parsed = globalThis.FlockCsv.parse(input.text || '');
    if (!parsed.headers.length) return { inserted: 0, duplicate: 0, dataset: input.dataset, empty: true };
    return ingest(Object.assign({}, input, { headers: parsed.headers, rows: parsed.rows }));
  }

  // ------------------------------------------------------------------ runs

  async function recordRun(entry) {
    const db = await open();
    const { t, done } = tx(db, [RUNS], 'readwrite');
    t.objectStore(RUNS).put(Object.assign({ id: entry.id || String(Date.now()) }, entry));
    await done;
  }

  // ----------------------------------------------------------------- query

  async function summary() {
    const db = await open();
    const { t } = tx(db, [DATASETS, RUNS], 'readonly');
    const datasets = await all(t.objectStore(DATASETS));
    const runs = await all(t.objectStore(RUNS));

    const agencies = new Map();
    for (const d of datasets) {
      for (const [agency, count] of Object.entries(d.counts || {})) {
        const entry = agencies.get(agency) || { key: agency, rows: 0, datasets: [] };
        entry.rows += count;
        if (count > 0) entry.datasets.push(d.name);
        agencies.set(agency, entry);
      }
    }

    datasets.sort((a, b) => a.name.localeCompare(b.name));
    runs.sort((a, b) => String(b.id).localeCompare(String(a.id)));

    return {
      datasets,
      agencies: [...agencies.values()].sort((a, b) => a.key.localeCompare(b.key)),
      runs: runs.slice(0, 100),
      totalRows: datasets.reduce((n, d) => n + (d.rows || 0), 0),
      updated: datasets.reduce((s, d) => (d.updated > s ? d.updated : s), ''),
    };
  }

  /** Read every row of one dataset, aligned to its union column list. */
  async function readDataset(name) {
    const db = await open();
    const { t } = tx(db, [DATASETS, ROWS], 'readonly');
    const def = await get(t.objectStore(DATASETS), name);
    if (!def) return { headers: [], rows: [] };

    const headers = META_COLUMNS.concat(def.headers);
    const rows = [];
    await new Promise((resolve, reject) => {
      const req = t.objectStore(ROWS).index('dataset').openCursor(IDBKeyRange.only(name));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const rec = cursor.value;
        const out = [rec.agency, rec.src || '', rec.added || '', rec.run || ''];
        for (const h of def.headers) out.push(rec.v[h] == null ? '' : rec.v[h]);
        rows.push(out);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    // Stable order, so regenerating the workbook twice produces the same sheet
    // and two exports can be diffed against each other.
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const first = META_COLUMNS.length;
    rows.sort((a, b) => collator.compare(a[0], b[0])
      || collator.compare(String(a[first] ?? ''), String(b[first] ?? ''))
      || collator.compare(String(a[2] ?? ''), String(b[2] ?? '')));

    return { headers, rows, def };
  }

  // ---------------------------------------------------------------- export

  /** Rebuild the whole workbook from the library. Returns a Blob. */
  async function buildWorkbook() {
    const info = await summary();
    const sheets = [];

    sheets.push({
      name: 'Index',
      headers: ['dataset', 'rows', 'agencies', 'columns', 'first collected', 'last updated'],
      rows: info.datasets.map((d) => [
        d.name,
        d.rows || 0,
        Object.entries(d.counts || {}).filter(([, n]) => n > 0).length,
        (d.headers || []).length,
        (d.created || '').slice(0, 19).replace('T', ' '),
        (d.updated || '').slice(0, 19).replace('T', ' '),
      ]),
    });

    // The per-agency view, without fragmenting the data into per-agency tabs:
    // one row per agency, one column per dataset, zeroes where nothing was
    // collected. Gaps are the point of this sheet.
    const datasetNames = info.datasets.map((d) => d.name);
    sheets.push({
      name: 'Coverage',
      headers: ['agency', 'total rows'].concat(datasetNames).concat(['portal']),
      rows: info.agencies.map((a) => {
        const counts = datasetNames.map((n) => {
          const d = info.datasets.find((x) => x.name === n);
          return (d && d.counts && d.counts[a.key]) || 0;
        });
        let portal = '';
        for (const d of info.datasets) {
          if (d.sources && d.sources[a.key]) { portal = d.sources[a.key]; break; }
        }
        return [a.key, a.rows].concat(counts).concat([portal]);
      }),
    });

    if (info.runs.length) {
      sheets.push({
        name: 'Runs',
        headers: ['run', 'started', 'finished', 'portals', 'rows added', 'duplicates skipped', 'notes'],
        rows: info.runs.map((r) => [
          r.id, r.started || '', r.finished || '', r.portals || 0,
          r.inserted || 0, r.duplicate || 0, r.note || '',
        ]),
      });
    }

    for (const d of info.datasets) {
      const { headers, rows } = await readDataset(d.name);
      if (!headers.length) continue;
      sheets.push({ name: d.name, headers, rows });
    }

    return globalThis.FlockXlsx.build(sheets);
  }

  /** One CSV per dataset, as a zip. */
  async function buildCsvBundle() {
    const info = await summary();
    const encoder = new TextEncoder();
    const entries = [];
    for (const d of info.datasets) {
      const { headers, rows } = await readDataset(d.name);
      const name = d.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'data';
      entries.push({
        name: `${name}.csv`,
        data: encoder.encode(globalThis.FlockCsv.stringify(headers, rows)),
      });
    }
    if (!entries.length) entries.push({ name: 'empty.txt', data: encoder.encode('No data collected yet.\n') });
    return globalThis.FlockXlsx.zip(entries);
  }

  // ---------------------------------------------------------------- backup

  /**
   * Newline-delimited JSON of the entire library. This is the thing to keep:
   * IndexedDB dies with the extension, and a backup restores byte-identical
   * fingerprints, so restoring never duplicates anything.
   */
  async function exportBackup() {
    const db = await open();
    const { t } = tx(db, [DATASETS, RUNS, ROWS, META], 'readonly');
    const lines = [JSON.stringify({ t: 'header', format: 'flock-library', version: 1, exported: new Date().toISOString() })];

    for (const d of await all(t.objectStore(DATASETS))) lines.push(JSON.stringify({ t: 'dataset', d }));
    for (const r of await all(t.objectStore(RUNS))) lines.push(JSON.stringify({ t: 'run', r }));
    for (const m of await all(t.objectStore(META))) lines.push(JSON.stringify({ t: 'meta', m }));

    await new Promise((resolve, reject) => {
      const req = t.objectStore(ROWS).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        lines.push(JSON.stringify({ t: 'row', r: cursor.value }));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    return new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
  }

  async function importBackup(text) {
    const db = await open();
    let rows = 0, datasets = 0, runs = 0, skipped = 0;

    const lines = String(text).split('\n').filter((l) => l.trim());
    const rowRecords = [];
    const datasetRecords = [];
    const runRecords = [];
    const metaRecords = [];

    for (const line of lines) {
      let parsed;
      try { parsed = JSON.parse(line); } catch (e) { skipped++; continue; }
      if (parsed.t === 'row' && parsed.r && parsed.r.id) rowRecords.push(parsed.r);
      else if (parsed.t === 'dataset' && parsed.d) datasetRecords.push(parsed.d);
      else if (parsed.t === 'run' && parsed.r) runRecords.push(parsed.r);
      else if (parsed.t === 'meta' && parsed.m) metaRecords.push(parsed.m);
    }

    const CHUNK = 2000;
    for (let start = 0; start < rowRecords.length; start += CHUNK) {
      const { t, done } = tx(db, [ROWS], 'readwrite');
      const store = t.objectStore(ROWS);
      for (const rec of rowRecords.slice(start, start + CHUNK)) {
        const req = store.add(rec);
        req.onsuccess = () => { rows++; };
        req.onerror = (event) => {
          if (req.error && req.error.name === 'ConstraintError') {
            skipped++; event.preventDefault(); event.stopPropagation();
          }
        };
      }
      await done;
    }

    // Dataset counts are recomputed from the rows actually present, so a
    // partial restore over an existing library still reports honest totals.
    {
      const { t, done } = tx(db, [DATASETS, RUNS, META], 'readwrite');
      const dStore = t.objectStore(DATASETS);
      for (const d of datasetRecords) {
        const existing = await get(dStore, d.name);
        if (!existing) { dStore.put(d); datasets++; continue; }
        for (const h of d.headers || []) if (!existing.headers.includes(h)) existing.headers.push(h);
        existing.sources = Object.assign({}, d.sources, existing.sources);
        if (d.created && d.created < existing.created) existing.created = d.created;
        dStore.put(existing);
        datasets++;
      }
      for (const r of runRecords) { t.objectStore(RUNS).put(r); runs++; }
      for (const m of metaRecords) if (m.k !== 'config') t.objectStore(META).put(m);
      await done;
    }

    await recount();
    return { rows, datasets, runs, skipped };
  }

  /** Rebuild every dataset's row counts from the rows themselves. */
  async function recount() {
    const db = await open();
    const tally = new Map();

    {
      const { t } = tx(db, [ROWS], 'readonly');
      await new Promise((resolve, reject) => {
        const req = t.objectStore(ROWS).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          const rec = cursor.value;
          const byAgency = tally.get(rec.dataset) || new Map();
          byAgency.set(rec.agency, (byAgency.get(rec.agency) || 0) + 1);
          tally.set(rec.dataset, byAgency);
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    }

    const { t, done } = tx(db, [DATASETS], 'readwrite');
    const store = t.objectStore(DATASETS);
    for (const def of await all(store)) {
      const byAgency = tally.get(def.name) || new Map();
      def.counts = Object.fromEntries(byAgency);
      def.rows = [...byAgency.values()].reduce((a, b) => a + b, 0);
      store.put(def);
    }
    for (const [name, byAgency] of tally) {
      const def = await get(store, name);
      if (def) continue;
      store.put({
        name,
        headers: [],
        counts: Object.fromEntries(byAgency),
        rows: [...byAgency.values()].reduce((a, b) => a + b, 0),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        sources: {},
      });
    }
    await done;
  }

  // ---------------------------------------------------------------- delete

  async function deleteWhere(indexName, key) {
    const db = await open();
    const { t, done } = tx(db, [ROWS], 'readwrite');
    let removed = 0;
    await new Promise((resolve, reject) => {
      const req = t.objectStore(ROWS).index(indexName).openCursor(IDBKeyRange.only(key));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        cursor.delete();
        removed++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await done;
    return removed;
  }

  async function deleteDataset(name) {
    const removed = await deleteWhere('dataset', name);
    const db = await open();
    const { t, done } = tx(db, [DATASETS], 'readwrite');
    t.objectStore(DATASETS).delete(name);
    await done;
    return removed;
  }

  async function deleteAgency(key) {
    const removed = await deleteWhere('agency', key);
    await recount();
    return removed;
  }

  async function wipe() {
    const db = await open();
    const { t, done } = tx(db, [ROWS, DATASETS, RUNS], 'readwrite');
    t.objectStore(ROWS).clear();
    t.objectStore(DATASETS).clear();
    t.objectStore(RUNS).clear();
    await done;
  }

  globalThis.FlockStore = {
    ingest,
    ingestCsv,
    recordRun,
    summary,
    readDataset,
    buildWorkbook,
    buildCsvBundle,
    exportBackup,
    importBackup,
    recount,
    deleteDataset,
    deleteAgency,
    wipe,
    getConfig,
    setConfig,
    DEFAULT_KEY_IGNORE,
    _rowKey: rowKey,
    _hash128: hash128,
    _makeIgnoreTest: makeIgnoreTest,
  };
})();
