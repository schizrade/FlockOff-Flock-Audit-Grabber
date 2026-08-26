/*
 * FlockOff CSV Grabber — CSV parsing and serialising.
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

// CSV parsing and serialising. Handles quoted delimiters, embedded newlines,
// doubled quotes, and CRLF. Exposes globalThis.FlockCsv.

(function () {
  'use strict';

  function sniff(text) {
    // Look at the first line outside quotes and pick whichever delimiter
    // appears most. A single-column export has none, and comma is a safe
    // default there.
    let line = '';
    let quoted = false;
    for (let i = 0; i < text.length && i < 8000; i++) {
      const ch = text[i];
      if (ch === '"') quoted = !quoted;
      if (!quoted && (ch === '\n' || ch === '\r')) break;
      line += ch;
    }
    let best = ',';
    let bestCount = 0;
    for (const d of [',', ';', '\t', '|']) {
      let count = 0;
      let q = false;
      for (const ch of line) {
        if (ch === '"') q = !q;
        else if (!q && ch === d) count++;
      }
      if (count > bestCount) { bestCount = count; best = d; }
    }
    return best;
  }

  /** Parse CSV text into { headers, rows, delimiter }. */
  function parse(text, delimiter) {
    if (typeof text !== 'string') return { headers: [], rows: [], delimiter: ',' };
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const d = delimiter || sniff(text);

    const table = [];
    let row = [];
    let field = '';
    let quoted = false;
    let started = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && !started) { quoted = true; started = true; continue; }
      if (ch === d) { row.push(field); field = ''; started = false; continue; }
      if (ch === '\r') { if (text[i + 1] === '\n') i++; row.push(field); table.push(row); row = []; field = ''; started = false; continue; }
      if (ch === '\n') { row.push(field); table.push(row); row = []; field = ''; started = false; continue; }
      field += ch;
      started = true;
    }
    if (field !== '' || row.length) { row.push(field); table.push(row); }

    const meaningful = table.filter((r) => r.some((c) => String(c).trim() !== ''));
    if (!meaningful.length) return { headers: [], rows: [], delimiter: d };

    const headers = meaningful[0].map((h, i) => String(h).trim() || `col_${i + 1}`);
    return { headers, rows: meaningful.slice(1), delimiter: d };
  }

  function quote(value) {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Serialise headers + rows back to CSV text, with a BOM for Excel. */
  function stringify(headers, rows, opts) {
    const bom = (opts && opts.bom === false) ? '' : '\ufeff';
    const lines = [headers.map(quote).join(',')];
    for (const r of rows) {
      const out = [];
      for (let i = 0; i < headers.length; i++) out.push(quote(r[i]));
      lines.push(out.join(','));
    }
    return bom + lines.join('\r\n') + '\r\n';
  }

  /** Cheap check that text is tabular data rather than an HTML error page. */
  function looksLikeCsv(text) {
    if (!text || !text.trim()) return false;
    const head = text.replace(/^\ufeff/, '').trimStart().slice(0, 400).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')
      || head.startsWith('<?xml') || head.startsWith('{') || head.startsWith('[')) return false;
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return false;
    return /[,;\t|]/.test(lines[0]) || lines.length > 1;
  }

  globalThis.FlockCsv = { parse, stringify, sniff, quote, looksLikeCsv };
})();
