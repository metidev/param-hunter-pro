// hook.js — runs inside the PAGE's own JS context (MAIN world),
// injected by content.js via a <script src="..."> tag.
// Purpose: capture REAL runtime request parameters (fetch/XHR/SPA routing)
// that static HTML/JS analysis (like the old GAP extension) can never see.
(function () {
  if (window.__paramHunterHooked) return;
  window.__paramHunterHooked = true;

  function post(source, params, extra) {
    if (!params || !params.length) return;
    try {
      window.postMessage(
        { __paramhunter: true, source: source, params: params, extra: extra || null, url: location.href },
        "*"
      );
    } catch (e) {}
  }

  function keysFromQuery(qs) {
    const out = [];
    try {
      const usp = new URLSearchParams(qs);
      for (const k of usp.keys()) out.push(k);
    } catch (e) {}
    return out;
  }

  function collectKeysDeep(obj, out, depth) {
    depth = depth || 0;
    if (depth > 4 || obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => collectKeysDeep(item, out, depth + 1));
      return;
    }
    Object.keys(obj).forEach((k) => {
      out.push(k);
      collectKeysDeep(obj[k], out, depth + 1);
    });
  }

  function keysFromBody(body) {
    const out = [];
    if (!body) return out;
    try {
      if (typeof body === "string") {
        try {
          collectKeysDeep(JSON.parse(body), out);
          return out;
        } catch (e) {}
        if (body.indexOf("=") !== -1) {
          const usp = new URLSearchParams(body);
          for (const k of usp.keys()) out.push(k);
          return out;
        }
      } else if (body instanceof URLSearchParams) {
        for (const k of body.keys()) out.push(k);
      } else if (typeof FormData !== "undefined" && body instanceof FormData) {
        for (const k of body.keys()) out.push(k);
      } else if (typeof body === "object") {
        collectKeysDeep(body, out);
      }
    } catch (e) {}
    return out;
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
        const method = (init && init.method) || (input && input.method) || "GET";
        let u = null;
        try {
          u = new URL(rawUrl, location.href);
        } catch (e) {}
        if (u && u.search) post("fetch-query", keysFromQuery(u.search), { method, url: u.origin + u.pathname });
        const body = init && init.body;
        if (body) post("fetch-body", keysFromBody(body), { method, url: rawUrl });
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // ---------- XMLHttpRequest ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ph_method = method;
    this.__ph_url = url;
    try {
      const u = new URL(url, location.href);
      if (u.search) post("xhr-query", keysFromQuery(u.search), { method, url: u.origin + u.pathname });
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (body) post("xhr-body", keysFromBody(body), { method: this.__ph_method, url: this.__ph_url });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ---------- SPA routing (pushState/replaceState) ----------
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (state, title, url) {
      try {
        if (url) {
          const u = new URL(url, location.href);
          if (u.search) post("spa-route", keysFromQuery(u.search), { url: u.origin + u.pathname });
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ---------- WebSocket URLs ----------
  try {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const NewWS = function (url, protocols) {
        try {
          const u = new URL(url, location.href);
          if (u.search) post("websocket-query", keysFromQuery(u.search), { url: u.href });
        } catch (e) {}
        return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
      };
      NewWS.prototype = OrigWS.prototype;
      Object.setPrototypeOf(NewWS, OrigWS);
      window.WebSocket = NewWS;
    }
  } catch (e) {}

  // ---------- SPA / framework global-state scan ----------
  // Looks for common app-state globals (window.CONFIG, __INITIAL_STATE__, __NEXT_DATA__, etc.)
  // which very often leak internal parameter names that static scanning misses.
  function scanGlobals() {
    try {
      const interesting = [];
      const namePattern = /^(config|settings|env|app|initial|params|options|context|store|state|data)/i;
      Object.keys(window).forEach((k) => {
        if (/^(webkit|chrome|external|on[A-Z]|__ph)/i.test(k)) return;
        if (k.length < 3) return;
        const isAllCaps = /^[A-Z_][A-Z0-9_]*$/.test(k);
        const isDunder = /^__.*__$/.test(k);
        const matchesPattern = namePattern.test(k);
        if (isAllCaps || isDunder || matchesPattern) {
          interesting.push(k);
          try {
            const val = window[k];
            if (val && typeof val === "object") {
              const sub = [];
              collectKeysDeep(val, sub);
              sub.slice(0, 50).forEach((sk) => interesting.push(k + "." + sk));
            }
          } catch (e) {}
        }
      });
      if (interesting.length) post("global-var", interesting, null);
    } catch (e) {}
  }
  window.addEventListener("load", () => setTimeout(scanGlobals, 500));
  setTimeout(scanGlobals, 2500);
})();
