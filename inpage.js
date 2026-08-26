/*
 * FlockOff CSV Grabber — Page-world hooks that capture CSV payloads however the site delivers them.
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

/* Runs in the page's own JavaScript world at document_start.
 *
 * Its only job is to notice CSV data the page produces and hand the text to the
 * content script. It watches every route a site can take to deliver a file:
 * a blob URL on an anchor, a data: URL, a click dispatched programmatically,
 * a direct .csv link, or a fetch/XHR that comes back as CSV.
 *
 * Capturing the text here means the run does not depend on Chrome's download
 * folder, and nothing is lost if a file is saved under a name we can't predict.
 */
(() => {
  if (window.__flockInpage) return;
  window.__flockInpage = true;

  const MAX_BYTES = 80 * 1024 * 1024;
  const seen = new Set();          // payload fingerprints already reported
  const blobRegistry = new Map();  // blob: URL -> Blob

  const post = (name, text, origin) => {
    if (!text || typeof text !== "string") return;
    const fingerprint = (name || "") + "|" + text.length + "|" + text.slice(0, 200);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    window.postMessage({ __flockCSV: true, name: name || "", text, origin: origin || "" }, "*");
  };

  const looksLikeCsv = (text) => {
    if (!text || text.length < 2) return false;
    const head = text.slice(0, 4000);
    if (/^\s*[[{]/.test(head)) return false;   // JSON
    if (/^\s*</.test(head)) return false;      // HTML/XML
    const firstLine = head.split(/\r?\n/)[0] || "";
    return firstLine.includes(",") || firstLine.includes("\t") || firstLine.includes(";");
  };

  const nameFromUrl = (url) => {
    try {
      const path = new URL(url, location.href).pathname;
      const last = path.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(last);
    } catch (e) {
      return "";
    }
  };

  async function readHref(href, name) {
    try {
      if (!href) return;
      if (href.startsWith("blob:")) {
        const blob = blobRegistry.get(href);
        const text = blob ? await blob.text() : await (await fetch(href)).text();
        if (looksLikeCsv(text)) post(name, text, "blob");
        return;
      }
      if (href.startsWith("data:")) {
        const comma = href.indexOf(",");
        if (comma < 0) return;
        const meta = href.slice(5, comma);
        const body = href.slice(comma + 1);
        const text = /;base64/i.test(meta)
          ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))
          : decodeURIComponent(body);
        if (looksLikeCsv(text)) post(name, text, "data");
        return;
      }
      if (/^https?:/i.test(href) && /\.csv(\?|$)|export|download/i.test(href)) {
        const res = await fetch(href, { credentials: "include" });
        if (!res.ok) return;
        const text = await res.text();
        if (looksLikeCsv(text)) post(name || nameFromUrl(href), text, "link");
      }
    } catch (e) {
      /* a failed capture is not worth breaking the page over */
    }
  }

  // --- blob URLs -----------------------------------------------------------
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL(obj);
    try {
      if (obj instanceof Blob && obj.size <= MAX_BYTES) blobRegistry.set(url, obj);
    } catch (e) {}
    return url;
  };
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    // Keep the blob around briefly; pages often revoke immediately after clicking.
    setTimeout(() => blobRegistry.delete(url), 15000);
    return origRevoke(url);
  };

  // --- anchor clicks, however they are triggered ---------------------------
  const fromAnchor = (a) => {
    if (!a || !a.href) return;
    if (a.hasAttribute("download") || /^blob:|^data:/.test(a.href) || /\.csv(\?|$)/i.test(a.href)) {
      readHref(a.href, a.getAttribute("download") || "");
    }
  };

  document.addEventListener(
    "click",
    (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest("a[href]");
      if (a) fromAnchor(a);
    },
    true
  );

  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    fromAnchor(this);
    return origAnchorClick.apply(this, arguments);
  };

  const origDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (ev) {
    try {
      if (ev && ev.type === "click" && this instanceof HTMLAnchorElement) fromAnchor(this);
    } catch (e) {}
    return origDispatch.apply(this, arguments);
  };

  // --- network responses that are already CSV ------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const type = res.headers.get("content-type") || "";
        const disp = res.headers.get("content-disposition") || "";
        if (/csv/i.test(type) || /\.csv/i.test(disp)) {
          res.clone().text().then((t) => {
            if (looksLikeCsv(t)) post(nameFromUrl(res.url), t, "fetch");
          });
        }
      } catch (e) {}
      return res;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__flockUrl = url;
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        const type = this.getResponseHeader("content-type") || "";
        if (/csv/i.test(type) && typeof this.responseText === "string") {
          if (looksLikeCsv(this.responseText)) post(nameFromUrl(this.__flockUrl || ""), this.responseText, "xhr");
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };
})();
