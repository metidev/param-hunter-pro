// background.js — MV3 service worker.
// Aggregates parameter data reported by content scripts, per tab, and keeps
// the toolbar badge updated with a live parameter count.

const dataByTab = {}; // tabId -> { origin, url, store, updatedAt }

function countAll(store) {
  let n = 0;
  Object.values(store).forEach((bucket) => (n += Object.keys(bucket).length));
  return n;
}

function mergeStores(a, b) {
  const out = JSON.parse(JSON.stringify(a || {}));
  Object.keys(b || {}).forEach((bucket) => {
    if (!out[bucket]) out[bucket] = {};
    Object.keys(b[bucket]).forEach((name) => {
      if (!out[bucket][name]) out[bucket][name] = { count: 0, examples: [] };
      out[bucket][name].count += b[bucket][name].count || 0;
      (b[bucket][name].examples || []).forEach((ex) => {
        if (out[bucket][name].examples.length < 5) out[bucket][name].examples.push(ex);
      });
    });
  });
  return out;
}

function updateBadge(tabId, store) {
  const n = countAll(store);
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n > 999 ? "999+" : n) : "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#7c3aed" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "PARAMHUNTER_UPDATE" && sender.tab) {
    const tabId = sender.tab.id;
    const prev = dataByTab[tabId];
    const merged = prev && prev.origin === msg.origin ? mergeStores(prev.store, msg.store) : msg.store;
    dataByTab[tabId] = { origin: msg.origin, url: msg.url, store: merged, updatedAt: Date.now() };
    updateBadge(tabId, merged);
    return; // no response needed
  }

  if (msg && msg.type === "GET_TAB_DATA") {
    sendResponse(dataByTab[msg.tabId] || null);
    return; // sync response
  }

  if (msg && msg.type === "CLEAR_TAB_DATA") {
    delete dataByTab[msg.tabId];
    chrome.action.setBadgeText({ tabId: msg.tabId, text: "" });
    sendResponse({ ok: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete dataByTab[tabId];
});

// Reset accumulated data whenever the user navigates the top frame to a new
// document, so results always reflect the currently loaded page (and its
// same-origin in-page AJAX activity), not stale data from a previous site.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) delete dataByTab[details.tabId];
});
