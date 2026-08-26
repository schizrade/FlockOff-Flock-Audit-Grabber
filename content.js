/*
 * FlockOff CSV Grabber — Per-page driver: waits out security checks and clicks the download controls.
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

/* Runs in the extension's isolated world on every transparency portal page.
 * Waits out any security check, finds the download controls, clicks them one at
 * a time, and forwards whatever CSV text the page produces to the background.
 */
(() => {
  if (window.__flockContent) return;
  window.__flockContent = true;

  let running = false;
  let captureCount = 0;
  let currentLabel = "";
  let opts = { controlTimeoutMs: 30000, clearanceTimeoutMs: 240000 };

  const send = (type, payload = {}) => {
    try {
      chrome.runtime.sendMessage({ type, url: location.href, ...payload }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* extension reloaded; the run is over for this page */
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- CSV payloads from the page world -----------------------------------
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__flockCSV !== true) return;
    captureCount += 1;
    send("csv", { name: d.name || "", text: d.text, label: currentLabel, origin: d.origin || "" });
  });

  // --- security check detection -------------------------------------------
  function challengeVisible() {
    if (document.querySelector("#challenge-running, #challenge-form, #cf-challenge-running, #cf-please-wait")) return true;
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
    const title = (document.title || "").toLowerCase();
    if (/just a moment|attention required|checking your browser|verifying you are human/.test(title)) return true;
    const body = document.body ? document.body.innerText || "" : "";
    if (body.length < 1200 && /verify you are human|needs to review the security/i.test(body)) return true;
    return false;
  }

  async function waitForClearance() {
    if (!challengeVisible()) return true;
    send("challenge");
    const deadline = Date.now() + opts.clearanceTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!challengeVisible()) {
        send("cleared");
        await sleep(1500); // let the real page settle
        return true;
      }
    }
    return false;
  }

  // --- finding the download controls --------------------------------------
  const VISIBLE = (el) => {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };

  const textOf = (el) =>
    ((el.innerText || el.textContent || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.title || "")).trim();

  function findControls() {
    const nodes = document.querySelectorAll(
      'a[download], a[href*=".csv" i], button, a[role="button"], [role="button"], [data-testid*="download" i], [data-testid*="export" i]'
    );
    const out = [];
    const claimed = new Set();
    for (const el of nodes) {
      if (!VISIBLE(el)) continue;
      const t = textOf(el);
      const isDownload =
        /(\bdownload\b|\bexport\b|\bcsv\b)/i.test(t) ||
        (el.tagName === "A" && (el.hasAttribute("download") || /\.csv(\?|$)/i.test(el.href || "")));
      if (!isDownload) continue;
      if (/download the app|app store|google play/i.test(t)) continue;
      // Skip a control nested inside one we already took.
      let skip = false;
      for (const prev of out) if (prev.el.contains(el) || el.contains(prev.el)) skip = true;
      if (skip) continue;
      const label = labelFor(el, claimed);
      out.push({ el, label });
    }
    return out;
  }

  function labelFor(el, claimed) {
    let node = el;
    for (let depth = 0; depth < 7 && node; depth += 1) {
      node = node.parentElement;
      if (!node) break;
      const heading = node.querySelector("h1, h2, h3, h4, h5, [class*='title' i], [class*='heading' i]");
      if (heading) {
        const t = (heading.innerText || "").trim().split("\n")[0];
        if (t && t.length < 90 && !claimed.has(t)) {
          claimed.add(t);
          return t;
        }
      }
    }
    // Fall back to the nearest heading above the control in document order.
    const all = [...document.querySelectorAll("h1, h2, h3, h4")].filter(VISIBLE);
    let best = "";
    for (const h of all) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = (h.innerText || "").trim();
    }
    return best || "dataset";
  }

  async function waitForControls(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = findControls();
      if (found.length) return found;
      await sleep(1000);
    }
    return [];
  }

  // --- the run ------------------------------------------------------------
  async function run(config) {
    if (running) return;
    running = true;
    opts = { ...opts, ...(config || {}) };
    try {
      send("scanning");
      const cleared = await waitForClearance();
      if (!cleared) {
        send("failed", { error: "Security check was never solved" });
        return;
      }

      const controls = await waitForControls(25000);
      if (!controls.length) {
        send("failed", { error: "No download control found on this page" });
        return;
      }
      send("found", { count: controls.length, labels: controls.map((c) => c.label) });

      let collected = 0;
      for (let i = 0; i < controls.length; i += 1) {
        const { el, label } = controls[i];
        currentLabel = label;
        const before = captureCount;
        send("clicking", { label, index: i + 1, total: controls.length });
        try {
          el.scrollIntoView({ block: "center" });
          await sleep(250);
          el.click();
        } catch (e) {
          continue;
        }
        const deadline = Date.now() + opts.controlTimeoutMs;
        while (captureCount === before && Date.now() < deadline) {
          if (challengeVisible()) await waitForClearance();
          await sleep(400);
        }
        if (captureCount > before) collected += captureCount - before;
        await sleep(1200); // be polite between datasets
      }
      currentLabel = "";
      send("done", { collected, controls: controls.length });
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === "begin") {
      run(msg.opts);
      reply({ ok: true });
    } else if (msg && msg.type === "ping") {
      reply({ ok: true, running, challenge: challengeVisible() });
    }
    return true;
  });

  // Announce readiness once the document has something to look at. The
  // background decides whether this page is part of a run.
  const announce = () => send("page-ready");
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(announce, 400));
  } else {
    setTimeout(announce, 400);
  }
})();
