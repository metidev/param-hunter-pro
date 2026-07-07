// content.js — isolated-world content script.
// 1) Injects hook.js into the page's real JS context to catch runtime fetch/XHR params.
// 2) Performs a full static scan of the DOM: forms, links, inline scripts, JSON-LD,
//    data-* attributes, meta tags, cookies, storage, HTML comments and same-origin JS files.
(function () {
  const STORE = {}; // bucket -> { paramName: { count, examples: [] } }

  function addParam(bucket, name, meta) {
    if (!name) return;
    name = String(name).trim();
    if (!name || name.length > 120) return;
    if (!STORE[bucket]) STORE[bucket] = {};
    if (!STORE[bucket][name]) STORE[bucket][name] = { count: 0, examples: [] };
    STORE[bucket][name].count++;
    if (meta && STORE[bucket][name].examples.length < 3) STORE[bucket][name].examples.push(meta);
  }

  function collectKeysDeep(obj, cb, depth) {
    depth = depth || 0;
    if (depth > 5 || obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((i) => collectKeysDeep(i, cb, depth + 1));
      return;
    }
    Object.keys(obj).forEach((k) => {
      cb(k);
      collectKeysDeep(obj[k], cb, depth + 1);
    });
  }

  function injectHook() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("hook.js");
      s.onload = function () {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }
  injectHook();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !data.__paramhunter) return;
    (data.params || []).forEach((p) =>
      addParam(data.source, p, { method: data.extra && data.extra.method, url: data.url })
    );
    flush();
  });

  function scanURL() {
    try {
      const u = new URL(location.href);
      for (const key of u.searchParams.keys()) addParam("url", key, { url: location.href });
    } catch (e) {}
  }

  function scanLinks() {
    document.querySelectorAll("a[href]").forEach((a) => {
      try {
        const u = new URL(a.getAttribute("href"), location.href);
        for (const key of u.searchParams.keys()) addParam("url", key, { url: u.href });
      } catch (e) {}
    });
  }

  function scanForms() {
    document.querySelectorAll("form").forEach((form) => {
      const action = form.getAttribute("action") || location.href;
      let actionUrl = null;
      try {
        actionUrl = new URL(action, location.href);
      } catch (e) {}
      if (actionUrl) {
        for (const key of actionUrl.searchParams.keys()) addParam("url", key, { url: actionUrl.href });
      }
      const method = (form.getAttribute("method") || "GET").toUpperCase();
      form.querySelectorAll("input, select, textarea").forEach((el) => {
        const name = el.getAttribute("name") || el.getAttribute("id");
        if (name)
          addParam("form", name, {
            method,
            url: actionUrl ? actionUrl.href : location.href,
            type: el.getAttribute("type") || el.tagName.toLowerCase(),
          });
      });
    });
    document.querySelectorAll("input[name], select[name], textarea[name]").forEach((el) => {
      if (!el.closest("form")) addParam("form", el.getAttribute("name"), { url: location.href, type: "orphan-input" });
    });
  }

  function scanDataAttrs() {
    document.querySelectorAll("*").forEach((el) => {
      if (!el.attributes) return;
      for (const attr of el.attributes) {
        if (attr.name.indexOf("data-") === 0 && attr.name.length > 5) {
          addParam("dataAttr", attr.name.replace(/^data-/, ""), { tag: el.tagName.toLowerCase() });
        }
      }
    });
  }

  function scanMeta() {
    document.querySelectorAll("meta[name], meta[property]").forEach((m) => {
      const name = m.getAttribute("name") || m.getAttribute("property");
      if (name) addParam("meta", name, null);
    });
  }

  function scanCookiesAndStorage() {
    try {
      document.cookie.split(";").forEach((c) => {
        const name = c.split("=")[0].trim();
        if (name) addParam("cookie", name, null);
      });
    } catch (e) {}
    try {
      for (let i = 0; i < localStorage.length; i++) addParam("storage", "localStorage:" + localStorage.key(i), null);
    } catch (e) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++)
        addParam("storage", "sessionStorage:" + sessionStorage.key(i), null);
    } catch (e) {}
  }

  function scanInlineScripts() {
    const patterns = [
      { re: /["']([a-zA-Z_][a-zA-Z0-9_\-]{1,40})["']\s*:/g, kind: "json-key" },
      { re: /\.getElementById\(\s*["']([^"']+)["']\s*\)/g, kind: "dom-id" },
      { re: /(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]{1,40})\s*=/g, kind: "var-decl" },
      { re: /[?&]([a-zA-Z_][a-zA-Z0-9_\-]{1,40})=/g, kind: "query-like" },
    ];
    document.querySelectorAll("script:not([src])").forEach((scr) => {
      const text = scr.textContent || "";
      if (!text || text.length > 300000) return;
      patterns.forEach((p) => {
        let m;
        let count = 0;
        p.re.lastIndex = 0;
        while ((m = p.re.exec(text)) && count < 500) {
          addParam("script", m[1], { kind: p.kind });
          count++;
        }
      });
    });
    document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((scr) => {
      try {
        const obj = JSON.parse(scr.textContent);
        collectKeysDeep(obj, (k) => addParam("jsonld", k, null));
      } catch (e) {}
    });
  }

  function scanComments() {
    try {
      const html = document.documentElement.outerHTML;
      const re = /<!--([\s\S]{0,300}?)-->/g;
      let m;
      let count = 0;
      while ((m = re.exec(html)) && count < 50) {
        const kv = m[1].match(/[a-zA-Z_][a-zA-Z0-9_\-]{1,40}\s*=/g);
        if (kv) kv.forEach((x) => addParam("comment", x.replace(/\s*=$/, ""), null));
        count++;
      }
    } catch (e) {}
  }

  async function scanExternalScripts() {
    const scripts = Array.from(document.querySelectorAll("script[src]")).slice(0, 30);
    for (const scr of scripts) {
      try {
        const src = new URL(scr.src, location.href).href;
        if (new URL(src).origin !== location.origin) continue; // same-origin only: avoid CORS + third-party noise
        const res = await fetch(src, { credentials: "omit" });
        if (!res.ok) continue;
        const text = await res.text();
        if (text.length > 2000000) continue;
        const reQuery = /[?&]([a-zA-Z_][a-zA-Z0-9_\-]{1,40})=/g;
        const reJson = /["']([a-zA-Z_][a-zA-Z0-9_\-]{1,40})["']\s*:/g;
        let m;
        let count = 0;
        while ((m = reQuery.exec(text)) && count < 300) {
          addParam("script", m[1], { kind: "external-query-like", file: src });
          count++;
        }
        count = 0;
        while ((m = reJson.exec(text)) && count < 300) {
          addParam("script", m[1], { kind: "external-json-key", file: src });
          count++;
        }
      } catch (e) {}
    }
    flush();
  }

  let flushTimer = null;
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({
          type: "PARAMHUNTER_UPDATE",
          origin: location.origin,
          url: location.href,
          store: STORE,
        });
      } catch (e) {}
    }, 150);
  }

  function fullScan() {
    scanURL();
    scanLinks();
    scanForms();
    scanDataAttrs();
    scanMeta();
    scanCookiesAndStorage();
    scanInlineScripts();
    scanComments();
    flush();
    scanExternalScripts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fullScan);
  } else {
    fullScan();
  }
  window.addEventListener("load", () => setTimeout(fullScan, 800));

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "PARAMHUNTER_RESCAN") {
      fullScan();
      sendResponse({ ok: true });
    }
    return true;
  });
})();
