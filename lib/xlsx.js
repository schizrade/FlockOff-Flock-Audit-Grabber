/*
 * FlockOff CSV Grabber — XLSX workbook writer and zip builder.
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

// Minimal XLSX writer. No dependencies, no bundled library.
//
// Produces a real OOXML workbook: shared string table, frozen header row,
// autofilter, sized columns, and numeric cells written as numbers so Excel can
// sort and total them. Compression uses the platform CompressionStream and
// falls back to stored (uncompressed) entries if it is unavailable.
//
// Exposes globalThis.FlockXlsx = { build, sheetName, numeric }.

(function () {
  'use strict';

  // ------------------------------------------------------------------ zip

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const utf8 = new TextEncoder();

  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const out = await new Response(cs.readable).arrayBuffer();
      return new Uint8Array(out);
    } catch (e) {
      return null;
    }
  }

  function dosStamp(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ByteSink {
    constructor() { this.parts = []; this.length = 0; }
    push(u8) { this.parts.push(u8); this.length += u8.length; }
    u16(v) { this.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])); }
    u32(v) {
      this.push(new Uint8Array([
        v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF,
      ]));
    }
  }

  // entries: [{ name, data: Uint8Array }]
  async function zip(entries) {
    const stamp = dosStamp(new Date());
    const body = new ByteSink();
    const central = [];

    for (const entry of entries) {
      const nameBytes = utf8.encode(entry.name);
      const raw = entry.data;
      const sum = crc32(raw);

      let method = 0;
      let payload = raw;
      const packed = await deflateRaw(raw);
      if (packed && packed.length < raw.length) { method = 8; payload = packed; }

      const offset = body.length;
      body.push(utf8.encode('PK\x03\x04'));
      body.u16(20); body.u16(0x0800); body.u16(method);
      body.u16(stamp.time); body.u16(stamp.date);
      body.u32(sum); body.u32(payload.length); body.u32(raw.length);
      body.u16(nameBytes.length); body.u16(0);
      body.push(nameBytes);
      body.push(payload);

      central.push({ nameBytes, method, sum, csize: payload.length, usize: raw.length, offset });
    }

    const dir = new ByteSink();
    for (const c of central) {
      dir.push(utf8.encode('PK\x01\x02'));
      dir.u16(20); dir.u16(20); dir.u16(0x0800); dir.u16(c.method);
      dir.u16(stamp.time); dir.u16(stamp.date);
      dir.u32(c.sum); dir.u32(c.csize); dir.u32(c.usize);
      dir.u16(c.nameBytes.length); dir.u16(0); dir.u16(0);
      dir.u16(0); dir.u16(0); dir.u32(0); dir.u32(c.offset);
      dir.push(c.nameBytes);
    }

    const end = new ByteSink();
    end.push(utf8.encode('PK\x05\x06'));
    end.u16(0); end.u16(0);
    end.u16(central.length); end.u16(central.length);
    end.u32(dir.length); end.u32(body.length);
    end.u16(0);

    return new Blob([...body.parts, ...dir.parts, ...end.parts], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // ----------------------------------------------------------------- xml

  // Excel rejects most C0 control characters outright, so they are dropped
  // rather than escaped. Tab, newline and carriage return survive.
  const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

  function esc(s) {
    return String(s)
      .replace(CONTROL, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  const INT_RE = /^-?\d{1,15}$/;
  const FLOAT_RE = /^-?\d{1,15}\.\d+$/;

  // Numeric-looking text becomes a real number, so totals and sorts work.
  // Leading zeros and hyphenated forms stay text: '007' and '25-001' are
  // identifiers, not quantities.
  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (/^-?0\d/.test(s)) return null;
    const plain = s.replace(/,/g, '');
    if (INT_RE.test(plain)) return parseInt(plain, 10);
    if (FLOAT_RE.test(plain)) return parseFloat(plain);
    return null;
  }

  const ILLEGAL_SHEET = /[\[\]:*?/\\]/g;

  function sheetName(raw, used) {
    let clean = String(raw == null ? '' : raw).replace(ILLEGAL_SHEET, '-').trim();
    clean = clean.replace(/^'+|'+$/g, '').slice(0, 31).trim() || 'Sheet';
    if (!used) return clean;
    if (!used.has(clean.toLowerCase())) { used.add(clean.toLowerCase()); return clean; }
    for (let i = 2; i < 5000; i++) {
      const suffix = '_' + i;
      const candidate = clean.slice(0, 31 - suffix.length) + suffix;
      if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
    }
    used.add(clean.toLowerCase());
    return clean;
  }

  const MAX_ROWS = 1048576;   // including the header
  const MAX_COLS = 16384;

  function sheetXml(headers, rows, strings) {
    const width = Math.min(headers.length, MAX_COLS);
    const lastCol = colName(width || 1);
    const out = [];

    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    out.push(`<dimension ref="A1:${lastCol}${rows.length + 1}"/>`);
    out.push('<sheetViews><sheetView workbookViewId="0">');
    out.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    out.push('</sheetView></sheetViews>');
    out.push('<sheetFormatPr defaultRowHeight="15"/>');

    // Column widths from the header plus a sample of rows, so huge sheets
    // still write quickly.
    const sample = rows.slice(0, 200);
    out.push('<cols>');
    for (let c = 0; c < width; c++) {
      let widest = String(headers[c] == null ? '' : headers[c]).length;
      for (const r of sample) {
        const v = r[c];
        if (v != null) widest = Math.max(widest, String(v).length);
      }
      out.push(`<col min="${c + 1}" max="${c + 1}" width="${Math.min(Math.max(widest + 2, 10), 55)}" customWidth="1"/>`);
    }
    out.push('</cols>');

    out.push('<sheetData>');

    const cell = (ref, value, style) => {
      if (value == null || value === '') return;
      const styleAttr = style ? ` s="${style}"` : '';
      const num = numeric(value);
      if (num !== null) { out.push(`<c r="${ref}"${styleAttr}><v>${num}</v></c>`); return; }
      const text = String(value);
      let idx = strings.map.get(text);
      if (idx === undefined) { idx = strings.list.length; strings.list.push(text); strings.map.set(text, idx); }
      strings.count++;
      out.push(`<c r="${ref}"${styleAttr} t="s"><v>${idx}</v></c>`);
    };

    out.push('<row r="1">');
    for (let c = 0; c < width; c++) {
      const ref = colName(c + 1) + '1';
      const text = String(headers[c] == null ? '' : headers[c]);
      let idx = strings.map.get(text);
      if (idx === undefined) { idx = strings.list.length; strings.list.push(text); strings.map.set(text, idx); }
      strings.count++;
      out.push(`<c r="${ref}" s="1" t="s"><v>${idx}</v></c>`);
    }
    out.push('</row>');

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowNum = r + 2;
      out.push(`<row r="${rowNum}">`);
      for (let c = 0; c < width; c++) cell(colName(c + 1) + rowNum, row[c], 0);
      out.push('</row>');
    }

    out.push('</sheetData>');
    if (rows.length) out.push(`<autoFilter ref="A1:${lastCol}${rows.length + 1}"/>`);
    out.push('</worksheet>');
    return out.join('');
  }

  const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2">'
    + '<font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
    + '</fonts>'
    + '<fills count="3">'
    + '<fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E63"/><bgColor indexed="64"/></patternFill></fill>'
    + '</fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  /**
   * Build a workbook.
   *
   * @param {Array<{name:string, headers:string[], rows:Array<Array<*>>}>} sheets
   * @returns {Promise<Blob>}
   */
  async function build(sheets) {
    const used = new Set();
    const prepared = [];

    for (const sheet of sheets) {
      const headers = sheet.headers || [];
      const rows = sheet.rows || [];
      // Oversized datasets are split across numbered sheets rather than
      // silently truncated.
      if (rows.length <= MAX_ROWS - 1) {
        prepared.push({ name: sheetName(sheet.name, used), headers, rows });
      } else {
        const chunk = MAX_ROWS - 1;
        for (let i = 0, n = 1; i < rows.length; i += chunk, n++) {
          prepared.push({
            name: sheetName(`${sheet.name}_${n}`, used),
            headers,
            rows: rows.slice(i, i + chunk),
          });
        }
      }
    }

    if (!prepared.length) prepared.push({ name: 'Empty', headers: ['(no data)'], rows: [] });

    const strings = { list: [], map: new Map(), count: 0 };
    const sheetDocs = prepared.map((s) => sheetXml(s.headers, s.rows, strings));

    const sharedStrings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.count}" uniqueCount="${strings.list.length}">`
      + strings.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
      + '</sst>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + prepared.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';

    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + prepared.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>';

    const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + prepared.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${prepared.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId${prepared.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
      + '</Relationships>';

    const entries = [
      { name: '[Content_Types].xml', data: utf8.encode(contentTypes) },
      { name: '_rels/.rels', data: utf8.encode(rootRels) },
      { name: 'xl/workbook.xml', data: utf8.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8.encode(workbookRels) },
      { name: 'xl/styles.xml', data: utf8.encode(STYLES) },
      { name: 'xl/sharedStrings.xml', data: utf8.encode(sharedStrings) },
    ];
    sheetDocs.forEach((doc, i) => {
      entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8.encode(doc) });
    });

    return zip(entries);
  }

  globalThis.FlockXlsx = { build, sheetName, numeric, zip, MAX_ROWS };
})();
