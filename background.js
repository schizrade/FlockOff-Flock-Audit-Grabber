/*
 * FlockOff CSV Grabber — Run orchestration, capture storage, and CSV export.
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

/* Background service worker.
 *
 * Owns the queue, the working tab, everything captured, and the exports.
 * All state lives in chrome.storage.local so a run survives the worker being
 * shut down between events — which Chrome does routinely.
 */

/* The library keeps every row ever collected, keyed by a fingerprint of its own
 * contents, so re-running a portal adds only what is genuinely new. These are
 * plain scripts rather than ES modules on purpose: one copy serves both this
 * worker and library.html, which loads them with <script src>. Importing them
 * here runs them for their effect on globalThis. */
import "./lib/csv.js";
import "./lib/xlsx.js";
import "./lib/store.js";

const RUN_KEY = "flockRun";
const DATA_KEY = "flockData";

const DEFAULT_OPTS = {
  itemTimeoutMs: 6 * 60 * 1000,   // ceiling per agency, including a hand-solved check
  controlTimeoutMs: 30000,        // how long to wait for one dataset after clicking
  betweenMs: 4000,                // pause between agencies
  retries: 1,
  saveIndividual: true,
  mergeAtEnd: true
};

const blank = () => ({
  runId: null,
  active: false,
  paused: false,
  finished: false,
  tabId: null,
  index: 0,
  items: [],
  opts: { ...DEFAULT_OPTS },
  log: [],
  startedAt: null,
  completedAt: null
});

// --- state ---------------------------------------------------------------
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn).catch((e) => console.error("[flock]", e)));

async function getState() {
  const got = await chrome.storage.local.get(RUN_KEY);
  return got[RUN_KEY] || blank();
}
async function setState(state) {
  await chrome.storage.local.set({ [RUN_KEY]: state });
  try {
    chrome.runtime.sendMessage({ type: "state", state }, () => void chrome.runtime.lastError);
  } catch (e) {}
}
async function getData() {
  const got = await chrome.storage.local.get(DATA_KEY);
  return got[DATA_KEY] || [];
}
async function setData(rows) {
  await chrome.storage.local.set({ [DATA_KEY]: rows });
}

function note(state, msg) {
  const stamp = new Date().toLocaleTimeString();
  state.log.unshift(`${stamp}  ${msg}`);
  if (state.log.length > 300) state.log.length = 300;
}

// --- small helpers -------------------------------------------------------
const slugFromUrl = (url) => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return (parts.pop() || new URL(url).hostname).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  } catch (e) {
    return "agency";
  }
};

const slugify = (s) =>
  (s || "dataset")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\.csv$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "dataset";

const sameTarget = (a, b) => {
  try {
    const x = new URL(a), y = new URL(b);
    const norm = (p) => p.replace(/\/+$/, "");
    return x.hostname === y.hostname && norm(x.pathname) === norm(y.pathname);
  } catch (e) {
    return false;
  }
};

function toDataUrl(text) {
  const bytes = new TextEncoder().encode("\uFEFF" + text); // BOM keeps Excel honest about UTF-8
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:text/csv;charset=utf-8;base64," + btoa(bin);
}

async function save(text, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: toDataUrl(text), filename, conflictAction: "uniquify", saveAs: false },
      (id) => {
        if (chrome.runtime.lastError) console.warn("[flock] save failed", chrome.runtime.lastError.message);
        resolve(id);
      }
    );
  });
}

// --- CSV ------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* handled by \n */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
}

const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (rows) => rows.map((r) => r.map(esc).join(",")).join("\r\n");

// --- run control ----------------------------------------------------------
async function startRun(urls, opts) {
  const state = blank();
  state.runId = `r${Date.now().toString(36)}`;
  state.opts = { ...DEFAULT_OPTS, ...(opts || {}) };
  state.items = urls.map((url) => ({
    url,
    slug: slugFromUrl(url),
    status: "pending",
    attempts: 0,
    datasets: 0,
    detail: "",
    startedAt: null
  }));
  state.active = true;
  state.startedAt = Date.now();
  note(state, `Run started — ${urls.length} portal${urls.length === 1 ? "" : "s"}`);

  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  state.tabId = tab.id;
  await setState(state);
  chrome.alarms.create("watchdog", { periodInMinutes: 0.5 });
  await advance("first");
}

// mode: "first" (start here) | "again" (re-open the current portal) | "next"
async function advance(mode) {
  const state = await getState();
  if (!state.active) return;

  if (mode === "next") state.index += 1;
  if (state.index >= state.items.length) {
    await finish(state);
    return;
  }
  if (state.paused) {
    await setState(state);
    return;
  }

  const item = state.items[state.index];
  item.status = "loading";
  item.attempts += 1;
  item.startedAt = Date.now();
  item.detail = "";
  note(state, `Opening ${item.slug}`);
  await setState(state);

  try {
    await chrome.tabs.update(state.tabId, { url: item.url });
  } catch (e) {
    const tab = await chrome.tabs.create({ url: item.url, active: true });
    const s2 = await getState();
    s2.tabId = tab.id;
    await setState(s2);
  }
}

async function retryOrSkip(reason) {
  const state = await getState();
  if (!state.active) return;
  const item = state.items[state.index];
  if (!item) return;
  if (item.attempts <= state.opts.retries) {
    item.status = "pending";
    item.detail = reason + " — retrying";
    note(state, `${item.slug}: ${reason}, retrying`);
    await setState(state);
    setTimeout(() => serialize(() => advance("again")), 2000);
  } else {
    item.status = "failed";
    item.detail = reason;
    note(state, `${item.slug}: ${reason}`);
    await setState(state);
    setTimeout(() => serialize(() => advance("next")), state.opts.betweenMs);
  }
}

async function finish(state) {
  state.active = false;
  state.finished = true;
  state.completedAt = Date.now();
  chrome.alarms.clear("watchdog");
  const collected = state.items.reduce((n, i) => n + i.datasets, 0);
  note(state, `Run complete — ${collected} file${collected === 1 ? "" : "s"} collected`);

  const failed = state.items.filter((i) => i.status === "failed").length;
  try {
    await FlockStore.recordRun({
      id: state.runId,
      started: state.startedAt ? new Date(state.startedAt).toISOString() : "",
      finished: new Date(state.completedAt).toISOString(),
      portals: state.items.length,
      inserted: state.libraryInserted || 0,
      duplicate: state.libraryDuplicate || 0,
      note: failed ? `${failed} portal${failed === 1 ? "" : "s"} failed` : ""
    });
    note(state, `Library now holds ${state.libraryInserted || 0} new row${(state.libraryInserted || 0) === 1 ? "" : "s"} from this run`);
  } catch (e) {
    note(state, `Could not record the run in the library — ${e.message}`);
  }

  await setState(state);
  if (state.opts.mergeAtEnd) await exportMerged();
}

// --- capture --------------------------------------------------------------
async function storeCapture(msg, senderUrl) {
  const state = await getState();
  const item = state.items[state.index];
  const agencySlug = item ? item.slug : slugFromUrl(senderUrl);
  const agencyUrl = item ? item.url : senderUrl;

  const dataset = slugify(msg.label || msg.name || "dataset");
  const rows = await getData();
  // Only a repeat inside the same run is a duplicate. Data kept from an earlier
  // run must never suppress a fresh capture, or a second run collects nothing.
  const dupe = rows.some(
    (r) =>
      r.runId === state.runId &&
      r.agency === agencySlug &&
      r.dataset === dataset &&
      r.text.length === msg.text.length
  );
  if (dupe) return;

  rows.push({
    runId: state.runId,
    agency: agencySlug,
    agencyUrl,
    dataset,
    name: msg.name || "",
    label: msg.label || "",
    capturedAt: new Date().toISOString(),
    text: msg.text
  });
  await setData(rows);

  // File it into the library too. Wrapped because a storage failure here must
  // never take down a run that is otherwise collecting fine — the merged CSVs
  // are written from chrome.storage.local above and do not depend on this.
  try {
    const added = await FlockStore.ingestCsv({
      agency: agencySlug,
      dataset,
      text: msg.text,
      sourceFile: `${agencySlug}__${dataset}.csv`,
      portalUrl: agencyUrl,
      runId: state.runId
    });
    state.libraryInserted = (state.libraryInserted || 0) + added.inserted;
    state.libraryDuplicate = (state.libraryDuplicate || 0) + added.duplicate;
    if (added.duplicate && !added.inserted) {
      note(state, `${agencySlug}: ${dataset} — already in the library`);
    } else if (added.duplicate) {
      note(state, `${agencySlug}: ${dataset} — ${added.inserted} new rows, ${added.duplicate} already held`);
    }
  } catch (e) {
    note(state, `${agencySlug}: could not file ${dataset} in the library — ${e.message}`);
  }

  if (item) {
    item.datasets += 1;
    item.status = "collecting";
    item.detail = `${item.datasets} file${item.datasets === 1 ? "" : "s"}`;
    note(state, `${agencySlug}: captured ${dataset} (${(msg.text.length / 1024).toFixed(1)} KB)`);
    await setState(state);
  }

  if (state.opts.saveIndividual) {
    await save(msg.text, `Flock/${agencySlug}__${dataset}.csv`);
  }
}

// --- exports --------------------------------------------------------------
async function exportMerged() {
  const rows = await getData();
  if (!rows.length) return { files: 0 };

  // Re-running an agency replaces its earlier pull rather than stacking on top
  // of it, so the merged file holds one current set of rows per agency.
  const newest = new Map();
  for (const r of rows) {
    const key = `${r.agency}|${r.dataset}`;
    const held = newest.get(key);
    if (!held || (r.capturedAt || "") >= (held.capturedAt || "")) newest.set(key, r);
  }

  const byDataset = new Map();
  for (const r of newest.values()) {
    if (!byDataset.has(r.dataset)) byDataset.set(r.dataset, []);
    byDataset.get(r.dataset).push(r);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  let files = 0;

  for (const [dataset, entries] of byDataset) {
    const headers = [];
    const parsed = [];
    for (const e of entries) {
      const table = parseCsv(e.text);
      if (!table.length) continue;
      const head = table[0].map((h) => (h || "").trim());
      for (const h of head) if (h && !headers.includes(h)) headers.push(h);
      parsed.push({ entry: e, head, body: table.slice(1) });
    }
    if (!parsed.length) continue;

    const out = [["agency", "agency_url", "captured_at", ...headers]];
    for (const p of parsed) {
      for (const line of p.body) {
        if (!line.some((v) => (v || "").trim() !== "")) continue;
        const map = {};
        p.head.forEach((h, i) => { map[h] = line[i] === undefined ? "" : line[i]; });
        out.push([p.entry.agency, p.entry.agencyUrl, p.entry.capturedAt, ...headers.map((h) => map[h] ?? "")]);
      }
    }
    await save(toCsv(out), `Flock/merged__${dataset}__${stamp}.csv`);
    files += 1;
  }

  const state = await getState();
  const log = [["agency", "url", "status", "attempts", "files", "detail"]];
  for (const i of state.items) log.push([i.slug, i.url, i.status, i.attempts, i.datasets, i.detail]);
  await save(toCsv(log), `Flock/run-log__${stamp}.csv`);
  files += 1;

  note(state, `Exported ${files} merged file${files === 1 ? "" : "s"} to Downloads/Flock`);
  await setState(state);
  return { files };
}

// --- page events ----------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;

  // From the popup
  if (msg.type === "get-state") {
    (async () => {
      const state = await getState();
      const rows = await getData();
      reply({ state, captured: rows.length, bytes: rows.reduce((n, r) => n + r.text.length, 0) });
    })();
    return true;
  }
  if (msg.type === "start") { serialize(() => startRun(msg.urls, msg.opts)); reply({ ok: true }); return true; }
  if (msg.type === "pause") {
    serialize(async () => { const s = await getState(); s.paused = true; note(s, "Paused"); await setState(s); });
    reply({ ok: true }); return true;
  }
  if (msg.type === "resume") {
    serialize(async () => {
      const s = await getState();
      s.paused = false;
      note(s, "Resumed");
      await setState(s);
      await advance("again");
    });
    reply({ ok: true }); return true;
  }
  if (msg.type === "skip") { serialize(() => retryOrSkip("Skipped by hand")); reply({ ok: true }); return true; }
  if (msg.type === "stop") {
    serialize(async () => {
      const s = await getState();
      s.active = false; s.paused = false; s.finished = true;
      chrome.alarms.clear("watchdog");
      note(s, "Stopped");
      await setState(s);
    });
    reply({ ok: true }); return true;
  }
  if (msg.type === "reset") {
    serialize(async () => {
      chrome.alarms.clear("watchdog");
      const fresh = blank();
      note(fresh, "Ready for a new run");
      await setState(fresh);
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === "export") { serialize(async () => reply(await exportMerged())); return true; }
  if (msg.type === "clear-data") { serialize(async () => { await setData([]); reply({ ok: true }); }); return true; }
  if (msg.type === "focus-tab") {
    (async () => {
      const s = await getState();
      if (s.tabId) {
        try {
          const tab = await chrome.tabs.get(s.tabId);
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(s.tabId, { active: true });
        } catch (e) {}
      }
      reply({ ok: true });
    })();
    return true;
  }

  // From a portal page
  if (!sender.tab) return;
  serialize(async () => {
    const state = await getState();
    if (!state.active || sender.tab.id !== state.tabId) return;
    const item = state.items[state.index];
    if (!item) return;

    switch (msg.type) {
      case "page-ready": {
        if (!sameTarget(msg.url, item.url)) return;
        item.status = "scanning";
        item.startedAt = Date.now();
        await setState(state);
        chrome.tabs.sendMessage(
          sender.tab.id,
          { type: "begin", opts: { controlTimeoutMs: state.opts.controlTimeoutMs, clearanceTimeoutMs: state.opts.itemTimeoutMs } },
          () => void chrome.runtime.lastError
        );
        break;
      }
      case "challenge": {
        item.status = "challenge";
        item.detail = "Security check — solve it in the tab";
        item.startedAt = Date.now(); // the clock restarts while a human is working
        note(state, `${item.slug}: security check, waiting for you`);
        await setState(state);
        break;
      }
      case "cleared": {
        item.status = "scanning";
        item.detail = "Check cleared";
        item.startedAt = Date.now();
        note(state, `${item.slug}: check cleared`);
        await setState(state);
        break;
      }
      case "found": {
        item.status = "collecting";
        item.detail = `${msg.count} dataset${msg.count === 1 ? "" : "s"} found`;
        await setState(state);
        break;
      }
      case "clicking": {
        item.detail = `${msg.index}/${msg.total} · ${msg.label}`;
        await setState(state);
        break;
      }
      case "csv": {
        await storeCapture(msg, sender.tab.url);
        break;
      }
      case "done": {
        if (item.datasets > 0) {
          item.status = "done";
          item.detail = `${item.datasets} file${item.datasets === 1 ? "" : "s"}`;
          note(state, `${item.slug}: done`);
          await setState(state);
          setTimeout(() => serialize(() => advance("next")), state.opts.betweenMs);
        } else {
          await setState(state);
          await retryOrSkip("Clicked, but no CSV came back");
        }
        break;
      }
      case "failed": {
        await setState(state);
        await retryOrSkip(msg.error || "Page did not cooperate");
        break;
      }
    }
  });
});

// Native downloads that slip past the in-page capture still get filed sensibly.
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  (async () => {
    const state = await getState();
    const name = downloadItem.filename || "";
    if (!state.active || name.startsWith("Flock/") || !/\.csv$/i.test(name)) {
      suggest();
      return;
    }
    const item = state.items[state.index];
    const prefix = item ? item.slug : "agency";
    suggest({ filename: `Flock/${prefix}__${name.split(/[\\/]/).pop()}`, conflictAction: "uniquify" });
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "watchdog") return;
  serialize(async () => {
    const state = await getState();
    if (!state.active || state.paused) return;
    const item = state.items[state.index];
    if (!item || !item.startedAt) return;
    if (item.status === "challenge") return; // a human is on it
    if (Date.now() - item.startedAt > state.opts.itemTimeoutMs) {
      await retryOrSkip("Timed out");
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(async () => {
    const state = await getState();
    if (state.active && state.tabId === tabId) {
      state.active = false;
      state.paused = false;
      note(state, "Working tab closed — run stopped");
      chrome.alarms.clear("watchdog");
      await setState(state);
    }
  });
});
