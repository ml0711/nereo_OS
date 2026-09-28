// Seite „Datenräume" — Ordner-/Datei-Browser je Gesellschaft PLUS Suche über den Datei-Index.
// Browser: /api/workspace (Gesellschaften) + /api/fs?counts=1 (Ebene). Suche: /api/search
// (Freitext tolerant über Name+Pfad, Filter Gesellschaft/Projekt/A-Kennung/Dokumenttyp/Muster).
// Der Server filtert die Ausschlüsse zentral, bevor etwas ankommt. Kein KI-Analyse-Knopf.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? u : null);
  const fmtSize = (b) => {
    if (b == null) return "";
    if (b < 1024) return b + " B";
    const u = ["KB", "MB", "GB", "TB"]; let n = b / 1024, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i];
  };
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" }); };
  const fmtTime = (s) => { const d = s ? new Date(s) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); };
  const val = (id) => { const el = $(id); return el ? el.value.trim() : ""; };

  const S = { companies: [], path: [], seq: 0, indexReady: false, facets: null, searchSeq: 0 }; // path[0] = Gesellschaft

  async function api(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 401) { location.href = "/login"; return null; }
    return r.json().catch(() => null);
  }

  // ---------------- Browser (Ausgangsansicht) ----------------
  function renderCrumbs() {
    const el = $("#dr-crumbs"); if (!el) return;
    el.innerHTML = S.path.map((seg, i) => {
      const last = i === S.path.length - 1;
      const part = last ? `<span class="cur">${esc(seg)}</span>` : `<a data-i="${i}">${esc(seg)}</a>`;
      return (i ? `<span class="sep">›</span>` : "") + part;
    }).join("");
  }

  function rowFolder(c) {
    const cnt = c.fileCount != null ? `${c.fileCount} Datei${c.fileCount === 1 ? "" : "en"}` : "";
    return `<tr class="folder" data-name="${esc(c.name)}">
      <td><div class="dr-name"><span class="dr-ico">▸</span><b>${esc(c.name)}</b></div></td>
      <td class="dr-num"></td>
      <td class="dr-num">${esc(fmtDate(c.modified))}</td>
      <td class="dr-num">${esc(cnt)}</td>
      <td></td></tr>`;
  }
  function rowFile(c) {
    const href = safeHref(c.webUrl);
    const open = href ? `<a class="btn ghost dr-open" href="${esc(href)}" target="_blank" rel="noopener noreferrer">In SharePoint öffnen ↗</a>` : "";
    return `<tr class="file">
      <td><div class="dr-name"><span class="dr-ico">•</span><b>${esc(c.name)}</b></div></td>
      <td class="dr-num">${esc(c.docDate || "")}</td>
      <td class="dr-num">${esc(fmtDate(c.modified))}</td>
      <td class="dr-num">${esc(fmtSize(c.size))}</td>
      <td class="dr-col-r">${open}</td></tr>`;
  }

  function renderLevel(d) {
    $("#dr-stand").textContent = "Stand: " + fmtTime(d.fetchedAt);
    renderCrumbs();
    const folders = (d.children || []).filter((c) => c.type === "folder");
    const files = (d.children || []).filter((c) => c.type === "file");
    const body = $("#dr-body");
    if (!folders.length && !files.length) { body.innerHTML = `<div class="dr-note">Dieser Ordner ist leer.</div>`; return; }
    body.innerHTML = `<table class="dr-table"><thead><tr>
        <th>Name</th><th>Dokumentdatum</th><th>Zuletzt geändert</th><th>Größe / Dateien</th><th></th>
      </tr></thead><tbody>${folders.map(rowFolder).join("")}${files.map(rowFile).join("")}</tbody></table>`;
  }

  async function load(pathSegs, { refresh = false } = {}) {
    S.path = pathSegs.slice();
    const seq = ++S.seq;
    $("#dr-body").innerHTML = `<div class="dr-note">Lädt …</div>`;
    renderCrumbs();
    const q = "/api/fs?counts=1&path=" + encodeURIComponent(pathSegs.join("/")) + (refresh ? "&refresh=1" : "");
    const d = await api(q);
    if (seq !== S.seq) return; // jüngster Klick gewinnt
    if (!d) return;
    if (d.error) { $("#dr-body").innerHTML = `<div class="dr-err">${esc(d.error)}</div>`; return; }
    renderLevel(d);
  }

  // ---------------- Suche ----------------
  function isSearchActive() {
    return !!(val("#dr-q") || val("#dr-f-company") || val("#dr-f-projekt") || val("#dr-f-a") || val("#dr-f-doctype") || val("#dr-f-pattern"));
  }
  function searchParams() {
    const p = new URLSearchParams();
    const add = (k, id) => { const v = val(id); if (v) p.set(k, v); };
    add("q", "#dr-q"); add("company", "#dr-f-company"); add("projekt", "#dr-f-projekt");
    add("a", "#dr-f-a"); add("doctype", "#dr-f-doctype"); add("pattern", "#dr-f-pattern");
    return p.toString();
  }
  function toggleClear() { const b = $("#dr-search-clear"); if (b) b.hidden = !isSearchActive(); }
  function showResults() { $("#dr-browser").hidden = true; $("#dr-results").hidden = false; toggleClear(); }
  function showBrowser() { $("#dr-results").hidden = true; $("#dr-browser").hidden = false; toggleClear(); }
  function clearSearchInputs() {
    ["#dr-q", "#dr-f-company", "#dr-f-projekt", "#dr-f-a", "#dr-f-doctype", "#dr-f-pattern"].forEach((id) => { if ($(id)) $(id).value = ""; });
    toggleClear();
  }

  function renderIdxStand(d, note) {
    const el = $("#dr-idx-stand"); if (!el) return;
    if (note === "lädt") { el.textContent = "Index wird aufgebaut …"; return; }
    if (!d) { el.textContent = note ? "Index: " + note : "Index: nicht verfügbar"; return; }
    const f = d.facets || {};
    el.textContent = `Index-Stand: ${fmtTime(d.builtAt)} · ${f.files ?? 0} Dateien · davon ${f.patternNo ?? 0} nicht nach Konvention`;
  }

  // Füllt eine Filter-Liste; die erste Option („…: alle") bleibt erhalten, Auswahl wird beibehalten.
  function fillSel(id, items, mk) {
    const el = $(id); if (!el) return;
    const cur = el.value;
    const first = el.querySelector("option");
    el.innerHTML = "";
    el.appendChild(first);
    for (const it of items) { const o = document.createElement("option"); mk(o, it); el.appendChild(o); }
    if (cur && [...el.options].some((o) => o.value === cur)) el.value = cur;
  }
  function populateFacets(f) {
    if (!f) return;
    fillSel("#dr-f-company", f.companies || [], (o, v) => { o.value = v; o.textContent = v; });
    fillSel("#dr-f-projekt", f.projekte || [], (o, p) => { o.value = p.id; o.textContent = p.label || p.id; });
    fillSel("#dr-f-a", f.aCodes || [], (o, a) => { o.value = a.code; o.textContent = a.name ? `${a.code} – ${a.name}` : a.code; });
    fillSel("#dr-f-doctype", f.docTypes || [], (o, t) => { o.value = t; o.textContent = t; });
  }

  // Baut den Index (Server) einmalig / bei force neu und füllt Filter + Stand. true bei Erfolg.
  async function ensureIndex(force = false) {
    if (S.indexReady && !force) return true;
    renderIdxStand(null, "lädt");
    const d = await api("/api/search?limit=0" + (force ? "&refresh=1" : ""));
    if (!d || d.error) { renderIdxStand(null, (d && d.error) || "nicht verfügbar"); return false; }
    S.facets = d.facets;
    populateFacets(d.facets);
    renderIdxStand(d);
    S.indexReady = true;
    return true;
  }

  const badge = (ok) => (ok ? `<span class="dr-badge ok">ja</span>` : `<span class="dr-badge no">nein</span>`);

  function renderResults(d) {
    const rows = d.rows || [];
    const head = `<div class="dr-reshead">${d.total} Treffer${d.total > rows.length ? ` (erste ${rows.length} gezeigt)` : ""}</div>`;
    const box = $("#dr-results");
    if (!rows.length) { box.innerHTML = head + `<div class="dr-note">Keine Treffer.</div>`; return; }
    const body = rows.map((r) => {
      const href = safeHref(r.webUrl);
      const open = href ? `<a class="btn ghost dr-open" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Öffnen ↗</a>` : "";
      return `<tr>
        <td><div class="dr-name"><span class="dr-ico">•</span><b>${esc(r.name)}</b></div></td>
        <td class="dr-num">${esc(r.docDate || "")}</td>
        <td class="dr-num">${esc(r.projektId || "")}</td>
        <td class="dr-num">${esc(r.aCode || "")}</td>
        <td class="dr-num">${esc(r.docType || "")}</td>
        <td class="dr-num">${badge(r.patternOk)}</td>
        <td class="dr-num">${esc(fmtDate(r.modified))}</td>
        <td><a class="dr-path" data-dir="${esc(r.dirPath)}" title="Im Explorer öffnen">${esc(r.path)}</a></td>
        <td class="dr-col-r">${open}</td></tr>`;
    }).join("");
    box.innerHTML = head + `<table class="dr-table dr-restable"><thead><tr>
        <th>Name</th><th>Dokumentdatum</th><th>Projekt</th><th>A</th><th>Typ</th><th>Muster</th><th>Geändert</th><th>Pfad</th><th></th>
      </tr></thead><tbody>${body}</tbody></table>`;
  }

  async function runSearch() {
    if (!isSearchActive()) { showBrowser(); return; }
    if (!(await ensureIndex())) return;
    const seq = ++S.searchSeq;
    showResults();
    $("#dr-results").innerHTML = `<div class="dr-note">Sucht …</div>`;
    const d = await api("/api/search?" + searchParams());
    if (seq !== S.searchSeq) return; // jüngste Suche gewinnt
    if (!d) return;
    if (d.error) { $("#dr-results").innerHTML = `<div class="dr-err">${esc(d.error)}</div>`; return; }
    renderResults(d);
  }

  // Klick auf den Pfad eines Treffers → Suche leeren + im Browser an die Stelle springen.
  function jumpTo(dir) {
    const segs = dir ? dir.split("/") : [];
    clearSearchInputs();
    showBrowser();
    if (segs.length) {
      const sel = $("#dr-company");
      if (sel && [...sel.options].some((o) => o.value === segs[0])) sel.value = segs[0];
      load(segs);
    }
  }

  // Startadresse aus der Web-Adresse (#/Gesellschaft/…) — so kann eine andere Seite (z. B.
  // „Projekte" → „Im Datenraum anzeigen") direkt in einen Ordner springen. Sonst null.
  function initialPathFromHash() {
    const h = (location.hash || "").replace(/^#\/?/, "");
    if (!h) return null;
    const segs = h.split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } }).filter(Boolean);
    return segs.length ? segs : null;
  }

  // Deep-Link vom Dashboard: Suchparameter in der Web-Adresse (z. B. ?pattern=nein) → Filter setzen
  // und die Trefferliste zeigen (über dem Browser). Nutzt dieselbe Suche wie die Bedienelemente, also
  // stimmt die Trefferzahl mit der Dashboard-Kachel überein. true, wenn eine Suche angewandt wurde.
  async function applySearchQueryFromUrl() {
    const p = new URLSearchParams(location.search);
    const map = { q: "#dr-q", company: "#dr-f-company", projekt: "#dr-f-projekt", a: "#dr-f-a", doctype: "#dr-f-doctype", pattern: "#dr-f-pattern" };
    if (!Object.keys(map).some((k) => p.get(k))) return false;
    if (!(await ensureIndex())) return false; // Index + Filteroptionen bereit (dynamische Selects gefüllt)
    for (const k in map) {
      const v = p.get(k); if (v == null) continue;
      const el = $(map[k]); if (!el) continue;
      if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.value === v)) el.value = v; }
      else el.value = v;
    }
    toggleClear();
    runSearch();
    return true;
  }

  async function boot() {
    const w = await api("/api/workspace");
    if (!w || w.error || !w.root) {
      $("#dr-body").innerHTML = `<div class="dr-err">${esc((w && (w.error || w.reason)) || "Workspace nicht verfügbar.")}</div>`;
      return;
    }
    S.companies = (w.nav || []).map((n) => n.name);
    if (!S.companies.length) { $("#dr-body").innerHTML = `<div class="dr-note">Keine Gesellschaft konfiguriert.</div>`; return; }
    $("#dr-company").innerHTML = S.companies.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    // Browser vorbereiten: Startadresse (nur wenn ihre Gesellschaft bekannt ist) — sonst die erste.
    const initial = initialPathFromHash();
    if (initial && S.companies.includes(initial[0])) {
      $("#dr-company").value = initial[0];
      load(initial);
    } else {
      load([S.companies[0]]);
    }
    // Deep-Link vom Dashboard (?pattern=nein …): Suche über den Browser legen. „Zurücksetzen" zeigt
    // dann den bereits geladenen Browser.
    applySearchQueryFromUrl();
  }

  // Delegierte Klicks: Treffer-Pfad (springen), Brotkrumen, Ordner öffnen (nur im Browser).
  document.addEventListener("click", (e) => {
    const p = e.target.closest(".dr-path[data-dir]");
    if (p) { e.preventDefault(); jumpTo(p.getAttribute("data-dir")); return; }
    const cr = e.target.closest(".dr-crumbs a[data-i]");
    if (cr) { load(S.path.slice(0, +cr.dataset.i + 1)); return; }
    const row = e.target.closest("#dr-browser .dr-table tbody tr.folder");
    if (row) { load([...S.path, row.getAttribute("data-name")]); return; }
  });

  // Browser-Steuerung
  $("#dr-company").addEventListener("change", (e) => load([e.target.value]));
  $("#dr-reload").addEventListener("click", () => load(S.path, { refresh: true }));

  // Such-Steuerung: Freitext (entprellt), Filter (sofort), Zurücksetzen, Index neu aufbauen.
  let _t = null;
  $("#dr-q").addEventListener("input", () => { toggleClear(); clearTimeout(_t); _t = setTimeout(runSearch, 250); });
  $("#dr-q").addEventListener("focus", () => ensureIndex(), { once: true });
  ["#dr-f-company", "#dr-f-projekt", "#dr-f-a", "#dr-f-doctype", "#dr-f-pattern"].forEach((id) => {
    $(id).addEventListener("focus", () => ensureIndex(), { once: true });
    $(id).addEventListener("change", async () => { toggleClear(); await ensureIndex(); runSearch(); });
  });
  $("#dr-search-clear").addEventListener("click", () => { clearSearchInputs(); showBrowser(); });
  $("#dr-idx-reload").addEventListener("click", async () => { S.indexReady = false; await ensureIndex(true); if (isSearchActive()) runSearch(); });

  boot();
})();
