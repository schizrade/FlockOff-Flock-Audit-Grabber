/*
 * FlockOff CSV Grabber — Popup logic: URL import, run controls, and the live ledger.
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

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; r(res); }));

let showingRun = false;
// The view follows the person, not the poll loop. It switches itself only on the
// edge where a run starts — never on every tick, or the setup view becomes
// unreachable once a run has finished.
let wasActive = null;

// Accepts a bare list, a JSON-ish block, or anything with URLs buried in it.
function parseUrls(raw) {
  const found = raw.match(/https?:\/\/[^\s"',]+/gi) || [];
  const seen = new Set();
  return found
    .map((u) => u.replace(/[),.;]+$/, ""))
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

function refreshCount() {
  const n = parseUrls($("urls").value).length;
  $("urlCount").textContent = `${n} portal${n === 1 ? "" : "s"}`;
  $("start").disabled = n === 0;
}

function saveList() {
  chrome.storage.local.set({ flockUrls: $("urls").value });
}

function report(text, bad) {
  const el = $("importNote");
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("bad", !!bad);
  clearTimeout(report.timer);
  report.timer = setTimeout(() => { el.hidden = true; }, 8000);
}

// Adds URLs from imported text to whatever is already in the box, skipping ones
// already listed. Returns what happened so the person can see it took.
function addUrls(text) {
  const incoming = parseUrls(text);
  const existing = parseUrls($("urls").value);
  const have = new Set(existing);
  const added = incoming.filter((u) => !have.has(u));
  const merged = [...existing, ...added];
  $("urls").value = merged.join("\n");
  saveList();
  refreshCount();
  return { added: added.length, skipped: incoming.length - added.length, found: incoming.length };
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let added = 0, skipped = 0, found = 0, unreadable = 0;
  for (const file of files) {
    try {
      const r = addUrls(await file.text());
      added += r.added; skipped += r.skipped; found += r.found;
    } catch (e) {
      unreadable += 1;
    }
  }
  if (unreadable) {
    report(`Couldn't read ${unreadable} file${unreadable === 1 ? "" : "s"}. Plain text only.`, true);
  } else if (!found) {
    report("No URLs in that file. Put one full URL per line, starting with https://", true);
  } else {
    report(`Added ${added} portal${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} already listed` : ""}.`);
  }
}

function setView(run) {
  showingRun = run;
  $("setup").hidden = run;
  $("run").hidden = !run;
  $("toggleView").textContent = run ? "Portals" : "Run";
}

function render(res) {
  const state = res.state;
  const items = state.items || [];
  const busy = state.active && !state.paused;
  const attention = items.some((i) => i.status === "challenge");

  const dot = $("statusDot");
  dot.className = "dot" + (attention ? " attention" : busy ? " running" : state.finished ? " done" : "");

  const finishedCount = items.filter((i) => ["done", "failed", "skipped"].includes(i.status)).length;
  $("progressFill").style.width = items.length ? `${(finishedCount / items.length) * 100}%` : "0";

  const files = items.reduce((n, i) => n + (i.datasets || 0), 0);
  const kb = Math.round(res.bytes / 1024);
  $("tally").textContent = files
    ? `${finishedCount}/${items.length} portals · ${files} files · ${kb} KB held`
    : items.length
    ? `${finishedCount}/${items.length} portals · nothing collected yet`
    : "Nothing collected yet";

  const current = items[state.index];
  $("banner").hidden = !attention;
  if (attention) $("bannerText").textContent = `${current ? current.slug : "A portal"} needs a security check solved`;

  const ledger = $("ledger");
  ledger.innerHTML = "";
  items.forEach((item, i) => {
    const li = document.createElement("li");
    if (i === state.index && state.active) li.classList.add("current");
    if (item.status === "challenge") li.classList.add("attention");

    const rail = document.createElement("span");
    rail.className = "rail " + item.status;

    const mid = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.slug;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = item.detail || item.status;
    mid.append(name, detail);

    const files = document.createElement("span");
    files.className = "files";
    files.textContent = item.datasets ? `${item.datasets}` : "";

    li.append(rail, mid, files);
    ledger.append(li);
  });

  $("pause").textContent = state.paused ? "Resume" : "Pause";
  $("pause").disabled = !state.active;
  $("skip").disabled = !state.active;
  $("stop").disabled = !state.active;
  $("export").disabled = res.captured === 0;
  $("clear").disabled = res.captured === 0;
  $("newRun").hidden = state.active;
  $("log").textContent = (state.log || []).join("\n");

  const over = !state.active && items.length > 0;
  $("doneNote").hidden = !over;
  if (over) {
    const failed = items.filter((i) => i.status === "failed").length;
    $("doneNote").textContent = failed
      ? `Run over — ${failed} portal${failed === 1 ? "" : "s"} failed. Start a new run to retry just those.`
      : "Run over. Your files are in Downloads/Flock.";
  }

  if (state.active && wasActive === false) setView(true);   // a run just began
  if (state.active && wasActive === null) setView(true);    // popup opened mid-run
  wasActive = state.active;
}

async function poll() {
  const res = await send({ type: "get-state" });
  if (res) render(res);
}

// --- wiring ---------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  if (new URLSearchParams(location.search).get("view") === "tab") {
    document.body.classList.add("as-tab");
    $("openInTab").hidden = true;
  }
  const saved = await chrome.storage.local.get(["flockUrls", "flockOpts"]);
  $("urls").value = saved.flockUrls || "";
  const o = saved.flockOpts || {};
  if (o.saveIndividual !== undefined) $("saveIndividual").checked = o.saveIndividual;
  if (o.mergeAtEnd !== undefined) $("mergeAtEnd").checked = o.mergeAtEnd;
  if (o.itemTimeoutMin) $("itemTimeout").value = o.itemTimeoutMin;
  if (o.betweenSec !== undefined) $("between").value = o.betweenSec;
  refreshCount();
  poll();
  setInterval(poll, 1200);
});

$("urls").addEventListener("input", () => {
  refreshCount();
  saveList();
});

$("fileInput").addEventListener("change", async (ev) => {
  await importFiles(ev.target.files);
  ev.target.value = ""; // let the same file be picked again
});

// The label is the visible control, so give it keyboard behaviour too.
document.querySelector(".file-btn").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    $("fileInput").click();
  }
});

const dropZone = $("urls");
["dragenter", "dragover"].forEach((type) =>
  dropZone.addEventListener(type, (ev) => {
    ev.preventDefault();
    dropZone.classList.add("dropping");
  })
);
["dragleave", "dragend", "drop"].forEach((type) =>
  dropZone.addEventListener(type, () => dropZone.classList.remove("dropping"))
);
dropZone.addEventListener("drop", async (ev) => {
  const files = ev.dataTransfer && ev.dataTransfer.files;
  if (files && files.length) {
    ev.preventDefault();
    await importFiles(files);
  }
});

$("clearList").addEventListener("click", () => {
  $("urls").value = "";
  saveList();
  refreshCount();
  report("List cleared.");
});

$("openInTab").addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?view=tab") });
  window.close();
});

$("openLibrary").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
  window.close();
});

$("toggleView").addEventListener("click", () => setView(!showingRun));

$("start").addEventListener("click", async () => {
  const urls = parseUrls($("urls").value);
  if (!urls.length) return;
  const opts = {
    saveIndividual: $("saveIndividual").checked,
    mergeAtEnd: $("mergeAtEnd").checked,
    itemTimeoutMs: Math.max(1, Number($("itemTimeout").value) || 6) * 60000,
    betweenMs: Math.max(0, Number($("between").value) || 0) * 1000
  };
  await chrome.storage.local.set({
    flockOpts: {
      saveIndividual: opts.saveIndividual,
      mergeAtEnd: opts.mergeAtEnd,
      itemTimeoutMin: Number($("itemTimeout").value),
      betweenSec: Number($("between").value)
    }
  });
  await send({ type: "start", urls, opts });
  setView(true);
  poll();
});

$("pause").addEventListener("click", async () => {
  const res = await send({ type: "get-state" });
  await send({ type: res.state.paused ? "resume" : "pause" });
  poll();
});
$("newRun").addEventListener("click", async () => {
  await send({ type: "reset" });
  wasActive = false;
  setView(false);
  refreshCount();
  poll();
});
$("skip").addEventListener("click", async () => { await send({ type: "skip" }); poll(); });
$("stop").addEventListener("click", async () => { await send({ type: "stop" }); poll(); });
$("focusTab").addEventListener("click", () => send({ type: "focus-tab" }));
$("export").addEventListener("click", async () => {
  $("export").textContent = "Saving…";
  await send({ type: "export" });
  $("export").textContent = "Save merged CSV";
  poll();
});
$("clear").addEventListener("click", async () => { await send({ type: "clear-data" }); poll(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "state") poll();
});
