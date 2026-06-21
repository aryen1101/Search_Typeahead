/* ============================================================
   Typeahead Search — minimal frontend
   Search box + two ranking options + suggestion dropdown.
   Talks to the backend through the nginx /api proxy.
   ============================================================ */

const API_BASE = location.protocol === "file:" ? "http://localhost:8080" : "/api";
const DEBOUNCE_MS = 140;

const $ = (id) => document.getElementById(id);
const input        = $("searchInput");
const searchBox    = $("searchBox");
const clearBtn     = $("clearBtn");
const searchBtn    = $("searchBtn");
const suggestPanel = $("suggestPanel");
const suggestList  = $("suggestList");
const responseBanner = $("responseBanner");
const trendingChips  = $("trendingChips");

let ranking = "recency";
let items = [];
let activeIndex = -1;
let lastReqId = 0;

// ---- helpers --------------------------------------------------
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function fmt(n) {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function highlight(text, prefix) {
  if (prefix && text.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `<b>${escapeHtml(text.slice(0, prefix.length))}</b>${escapeHtml(text.slice(prefix.length))}`;
  }
  return escapeHtml(text);
}

// ---- suggestions ----------------------------------------------
function openPanel() { suggestPanel.hidden = false; input.setAttribute("aria-expanded", "true"); }
function closePanel() {
  suggestPanel.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
  activeIndex = -1;
}

async function fetchSuggestions(prefix) {
  const reqId = ++lastReqId;
  openPanel();
  suggestList.innerHTML = `<div class="suggest-loading"><span class="spinner"></span> Searching…</div>`;
  try {
    const res = await fetch(`${API_BASE}/suggest?q=${encodeURIComponent(prefix)}&ranking=${ranking}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (reqId !== lastReqId) return;
    renderSuggestions(data.suggestions || [], prefix);
  } catch {
    if (reqId !== lastReqId) return;
    suggestList.innerHTML = `<div class="suggest-empty">⚠️ Could not reach the backend.</div>`;
  }
}

function renderSuggestions(list, prefix) {
  items = list;
  activeIndex = -1;
  if (!list.length) {
    suggestList.innerHTML = `<div class="suggest-empty">No matches for “${escapeHtml(prefix)}”.</div>`;
    openPanel();
    return;
  }
  suggestList.innerHTML = list.map((s, i) => `
    <li id="opt-${i}" class="suggest-item" role="option" data-index="${i}" aria-selected="false">
      <span class="si-icon">🔍</span>
      <span class="si-text">${highlight(s.query, prefix)}</span>
      <span class="si-count">${fmt(s.count)}</span>
    </li>`).join("");
  openPanel();
}

function setActive(idx) {
  const nodes = [...suggestList.querySelectorAll(".suggest-item")];
  if (!nodes.length) return;
  if (activeIndex >= 0) {
    nodes[activeIndex].classList.remove("active");
    nodes[activeIndex].setAttribute("aria-selected", "false");
  }
  activeIndex = (idx + nodes.length) % nodes.length;
  const el = nodes[activeIndex];
  el.classList.add("active");
  el.setAttribute("aria-selected", "true");
  el.scrollIntoView({ block: "nearest" });
  input.setAttribute("aria-activedescendant", el.id);
}

const debouncedFetch = debounce((p) => {
  if (!p.trim()) { closePanel(); return; }
  fetchSuggestions(p.trim());
}, DEBOUNCE_MS);

// ---- search submission ----------------------------------------
async function submitSearch(rawQuery) {
  const query = (rawQuery ?? input.value).trim();
  if (!query) return;
  input.value = query;
  closePanel();
  searchBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    showResponse(`${data.message || "Searched"} — “${query}”`, false);
    setTimeout(loadTrending, 600);   // submitted query may now be trending
  } catch {
    showResponse("Could not submit search — backend unreachable.", true);
  } finally {
    searchBtn.disabled = false;
  }
}
function showResponse(text, isError) {
  responseBanner.hidden = false;
  responseBanner.className = "response-banner" + (isError ? " error" : "");
  responseBanner.innerHTML = `<span>${isError ? "⚠️" : "✅"}</span><span><b>${isError ? "Error" : "Response"}:</b> ${escapeHtml(text)}</span>`;
}

// ---- trending searches ----------------------------------------
async function loadTrending() {
  try {
    const res = await fetch(`${API_BASE}/trending?limit=10`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const list = data.suggestions || [];
    if (!list.length) { trendingChips.innerHTML = `<span class="trending-loading">No trending data yet.</span>`; return; }
    trendingChips.innerHTML = list.map((s, i) => `
      <button class="chip" data-q="${escapeHtml(s.query)}">
        <span class="chip-rank">${i + 1}</span>
        <span>${escapeHtml(s.query)}</span>
        <span class="chip-count">${fmt(s.count)}</span>
      </button>`).join("");
  } catch {
    trendingChips.innerHTML = `<span class="trending-loading">⚠️ Could not load trending.</span>`;
  }
}

// ---- events ---------------------------------------------------
input.addEventListener("input", () => {
  clearBtn.hidden = input.value.length === 0;
  responseBanner.hidden = true;
  debouncedFetch(input.value);
});

input.addEventListener("keydown", (e) => {
  const open = !suggestPanel.hidden && items.length > 0;
  switch (e.key) {
    case "ArrowDown": if (open) { e.preventDefault(); setActive(activeIndex + 1); } break;
    case "ArrowUp":   if (open) { e.preventDefault(); setActive(activeIndex - 1); } break;
    case "Enter":
      e.preventDefault();
      if (open && activeIndex >= 0) submitSearch(items[activeIndex].query);
      else submitSearch();
      break;
    case "Escape": closePanel(); break;
    case "Tab":
      if (open && activeIndex >= 0) { e.preventDefault(); input.value = items[activeIndex].query; closePanel(); }
      break;
  }
});

input.addEventListener("focus", () => { if (input.value.trim() && items.length) openPanel(); });

suggestList.addEventListener("mousemove", (e) => {
  const li = e.target.closest(".suggest-item");
  if (li) setActive(Number(li.dataset.index));
});
suggestList.addEventListener("click", (e) => {
  const li = e.target.closest(".suggest-item");
  if (li) submitSearch(items[Number(li.dataset.index)].query);
});

clearBtn.addEventListener("click", () => {
  input.value = ""; clearBtn.hidden = true; closePanel(); responseBanner.hidden = true; input.focus();
});
searchBtn.addEventListener("click", () => submitSearch());

document.querySelectorAll(".rank-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rank-btn").forEach((b) => {
      b.classList.remove("active"); b.setAttribute("aria-checked", "false");
    });
    btn.classList.add("active"); btn.setAttribute("aria-checked", "true");
    ranking = btn.dataset.ranking;
    if (input.value.trim()) fetchSuggestions(input.value.trim());  // re-rank live
  });
});

trendingChips.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) { input.value = chip.dataset.q; clearBtn.hidden = false; submitSearch(chip.dataset.q); }
});
$("refreshTrending").addEventListener("click", loadTrending);

document.addEventListener("click", (e) => {
  if (!searchBox.contains(e.target) && !suggestPanel.contains(e.target)) closePanel();
});

// ---- init -----------------------------------------------------
loadTrending();
input.focus();
