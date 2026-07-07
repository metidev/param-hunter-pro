const BUCKET_LABELS = {
  url: "🔗 URL / Query String Parameters",
  form: "📝 Form Fields (GET/POST)",
  "fetch-query": "⚡ fetch() — Query",
  "fetch-body": "⚡ fetch() — Request Body",
  "xhr-query": "📡 XHR — Query",
  "xhr-body": "📡 XHR — Request Body",
  "spa-route": "🧭 SPA Routes (pushState)",
  "websocket-query": "🔌 WebSocket",
  script: "🧩 Extracted from Scripts",
  jsonld: "🗂️ JSON / JSON-LD",
  dataAttr: "🏷️ data-* Attributes",
  meta: "📄 Meta Tags",
  cookie: "🍪 Cookies",
  storage: "💾 localStorage / sessionStorage",
  comment: "💬 HTML Comments",
  "global-var": "🌐 Global Variables (SPA State)",
};

const SENSITIVE_RE = /token|secret|passw(or)?d|pwd|api[_-]?key|auth|session|jwt|csrf|credential|ssn|cvv|card(num)?|otp|private/i;

let currentTabId = null;
let currentData = null;
let activeBucket = "all"; // "all" or a specific bucket key — controls what Copy/Export act on

function isSensitive(name) {
  return SENSITIVE_RE.test(name);
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

function requestData(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_TAB_DATA", tabId }, (resp) => resolve(resp));
  });
}

function countAll(store) {
  let n = 0;
  Object.values(store || {}).forEach((b) => (n += Object.keys(b).length));
  return n;
}

// Returns unique parameter names limited to the currently active scope
// (a single bucket, or every bucket when activeBucket === "all").
// This is what Copy Names / Copy as GAP Format / Export Wordlist all use.
function getScopedNames() {
  const names = [];
  if (!currentData || !currentData.store) return names;
  if (activeBucket === "all") {
    Object.values(currentData.store).forEach((bucket) => Object.keys(bucket).forEach((n) => names.push(n)));
  } else {
    const bucket = currentData.store[activeBucket] || {};
    Object.keys(bucket).forEach((n) => names.push(n));
  }
  return Array.from(new Set(names));
}

function buildGapFormat(names) {
  return names.map((n, i) => `${n}=XNLV${i}`).join("&");
}

function render() {
  const list = document.getElementById("ph-list");
  const empty = document.getElementById("ph-empty");
  const search = document.getElementById("ph-search").value.trim().toLowerCase();
  list.innerHTML = "";

  if (!currentData || !currentData.store || countAll(currentData.store) === 0) {
    list.appendChild(empty);
    empty.style.display = "block";
    document.getElementById("ph-count").textContent = "0";
    return;
  }

  document.getElementById("ph-count").textContent = countAll(currentData.store);

  const buckets = Object.keys(currentData.store).filter((b) => activeBucket === "all" || b === activeBucket);
  let anyShown = false;

  buckets.forEach((bucket) => {
    const entries = Object.entries(currentData.store[bucket]).filter(([name]) =>
      search ? name.toLowerCase().includes(search) : true
    );
    if (!entries.length) return;
    anyShown = true;

    const title = document.createElement("div");
    title.className = "ph-group-title";
    title.textContent = (BUCKET_LABELS[bucket] || bucket) + ` (${entries.length})`;
    list.appendChild(title);

    entries
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([name, info]) => {
        const row = document.createElement("div");
        row.className = "ph-row";

        const nameEl = document.createElement("div");
        nameEl.className = "ph-param-name" + (isSensitive(name) ? " ph-sensitive" : "");
        nameEl.textContent = name;

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.alignItems = "center";
        const countEl = document.createElement("span");
        countEl.className = "ph-badge-count";
        countEl.textContent = info.count;
        right.appendChild(countEl);

        row.appendChild(nameEl);
        row.appendChild(right);
        row.title = info.examples && info.examples[0] ? JSON.stringify(info.examples[0]) : "";
        list.appendChild(row);
      });
  });

  if (!anyShown) {
    list.appendChild(empty);
    empty.textContent = "No parameters match this filter.";
    empty.style.display = "block";
  }
}

function updateScopeHint() {
  const hint = document.getElementById("ph-scope-hint");
  if (activeBucket === "all") {
    hint.innerHTML = 'Scope: <b>All</b> — export/copy actions apply to all categories.';
  } else {
    const label = (BUCKET_LABELS[activeBucket] || activeBucket).replace(/^\S+\s/, "");
    hint.innerHTML = `Scope: <b>${label}</b> — export/copy actions apply only to this category. Select "All" to include everything.`;
  }
}

function renderTabs() {
  const tabsEl = document.getElementById("ph-tabs");
  tabsEl.innerHTML = "";
  const all = document.createElement("div");
  all.className = "ph-tab" + (activeBucket === "all" ? " active" : "");
  all.textContent = "All";
  all.onclick = () => {
    activeBucket = "all";
    renderTabs();
    updateScopeHint();
    render();
  };
  tabsEl.appendChild(all);

  if (!currentData || !currentData.store) return;
  Object.keys(currentData.store).forEach((bucket) => {
    if (!Object.keys(currentData.store[bucket]).length) return;
    const el = document.createElement("div");
    el.className = "ph-tab" + (activeBucket === bucket ? " active" : "");
    const label = BUCKET_LABELS[bucket] || bucket;
    el.textContent = label.split(" ").slice(1).join(" ") || label;
    el.title = label;
    el.onclick = () => {
      activeBucket = bucket;
      renderTabs();
      updateScopeHint();
      render();
    };
    tabsEl.appendChild(el);
  });
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  if (chrome.downloads) {
    chrome.downloads.download({ url, filename, saveAs: true });
  } else {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  }
}

function flashButton(btn, tempText) {
  const orig = btn.textContent;
  btn.textContent = tempText;
  setTimeout(() => (btn.textContent = orig), 1200);
}

async function init() {
  const tab = await getActiveTab();
  if (!tab) return;
  currentTabId = tab.id;
  document.getElementById("ph-origin").textContent = tab.url || "";

  currentData = await requestData(currentTabId);
  renderTabs();
  updateScopeHint();
  render();
}

document.getElementById("ph-search").addEventListener("input", render);

document.getElementById("ph-rescan").addEventListener("click", async () => {
  document.getElementById("ph-empty").textContent = "Rescanning…";
  chrome.tabs.sendMessage(currentTabId, { type: "PARAMHUNTER_RESCAN" }, async () => {
    setTimeout(async () => {
      currentData = await requestData(currentTabId);
      renderTabs();
      updateScopeHint();
      render();
    }, 900);
  });
});

// Copy Names: one unique parameter name per line, limited to current scope.
document.getElementById("ph-copy-names").addEventListener("click", () => {
  const names = getScopedNames();
  navigator.clipboard.writeText(names.join("\n")).then(() => {
    flashButton(document.getElementById("ph-copy-names"), "✅ Copied!");
  });
});

// Copy as GAP Format: param1=XNLV0&param2=XNLV1&... — ready to paste into
// Burp Intruder / Repeater exactly like the classic GAP extension output,
// but scoped to whichever category tab is currently selected.
document.getElementById("ph-copy-gap").addEventListener("click", () => {
  const names = getScopedNames();
  const gapString = buildGapFormat(names);
  navigator.clipboard.writeText(gapString).then(() => {
    flashButton(document.getElementById("ph-copy-gap"), "✅ Copied!");
  });
});

document.getElementById("ph-export-txt").addEventListener("click", () => {
  const names = getScopedNames().sort();
  const suffix = activeBucket === "all" ? "all" : activeBucket;
  download(`paramhunter-wordlist-${suffix}.txt`, names.join("\n"), "text/plain");
});

document.getElementById("ph-clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CLEAR_TAB_DATA", tabId: currentTabId }, () => {
    currentData = null;
    activeBucket = "all";
    renderTabs();
    updateScopeHint();
    render();
  });
});

init();
