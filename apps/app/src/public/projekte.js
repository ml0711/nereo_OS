// Seite „Projekte" — Übersicht (Kern-Abdeckung + Dokumentzahl je A-Kennung) + Projektseite.
// Nur lesen. Quelle: /api/workspace (Gesellschaft finden) + /api/projekte?full=1 (Übersicht) +
// /api/projekt?full=1 (Detail). Die A-Spalten kommen aus dem live gelesenen Katalog, den der
// Server mitliefert → eine neue Kennung (A18 …) erscheint automatisch als neue Spalte. Der Server
// filtert Ausschlüsse zentral, bevor etwas ankommt. Kein KI-Knopf.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? u : null);
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" }); };
  const fmtTime = (s) => { const d = s ? new Date(s) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); };

  const COMPANY = "nereo.development"; // Aufgabe: Projekte liegen unter nereo.development/04_Projekte
  const S = { catalog: [], projects: [], projektePath: "", seq: 0, view: "list" };

  async function api(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 401) { location.href = "/login"; return null; }
    return r.json().catch(() => null);
  }

  // ---------------- Übersicht ----------------
  const coreClass = (p) => (p.core.total && p.core.filled >= p.core.total ? "ok" : "bad");

  function aCell(p, code, coreSet) {
    const n = p.perCode[code] || 0;
    if (n > 0) return `<td class="pr-a-cell pr-a-has">${n}</td>`;
    // Kernanalyse ohne Dokument → hervorgehoben (weiß, gestrichelter Rand). Sonst nur gedämpft.
    if (coreSet.has(code)) return `<td class="pr-a-cell pr-a-warn" title="Kernanalyse ohne Dokument">–</td>`;
    return `<td class="pr-a-cell pr-a-zero">–</td>`;
  }

  function renderList() {
    const cat = S.catalog;
    const coreSet = new Set(cat.filter((c) => c.core).map((c) => c.code));
    let list = S.projects.slice();
    if ($("#pr-f-core") && $("#pr-f-core").checked) list = list.filter((p) => p.core.total && p.core.filled < p.core.total);
    if ($("#pr-f-old") && $("#pr-f-old").checked) list = list.filter((p) => p.alteStruktur);
    const body = $("#pr-body");
    if (!list.length) { body.innerHTML = `<div class="pr-note">Keine Projekte für diese Auswahl.</div>`; return; }
    const aHead = cat.map((c) => `<th class="pr-a" title="${esc(c.code)} – ${esc(c.name)}${c.core ? " (Kern)" : ""}">${esc(c.code)}</th>`).join("");
    const rows = list.map((p) => {
      const old = p.alteStruktur ? `<span class="pr-badge old">alte Struktur</span>` : "";
      const cells = cat.map((c) => aCell(p, c.code, coreSet)).join("");
      return `<tr data-name="${esc(p.name)}">
        <td><span class="pr-pid">${esc(p.projektId || p.name)}</span>${old}</td>
        <td class="pr-kz">${esc(p.kuerzel || "")}</td>
        <td class="pr-city">${esc(p.stadt || "")}</td>
        <td><span class="pr-core ${coreClass(p)}">${p.core.filled} von ${p.core.total}</span></td>
        ${cells}
        <td class="pr-num">${p.unsortedCount || 0}</td>
        <td class="pr-num">${p.totalFiles || 0}</td>
        <td class="pr-num">${esc(fmtDate(p.lastModified))}</td>
      </tr>`;
    }).join("");
    const shown = list.length !== S.projects.length ? `${list.length} von ${S.projects.length}` : `${list.length}`;
    body.innerHTML = `<div class="pr-scroll"><table class="pr-table"><thead><tr>
        <th>Projekt-ID</th><th>Kürzel</th><th>Stadt</th><th>Kern</th>${aHead}
        <th class="pr-num">Zu prüfen</th><th class="pr-num">Dateien</th><th class="pr-num">Geändert</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="pr-note" style="font-size:12px">${shown} Projekt(e) · schmale Spalten A00…: Dokumente je Analyse (inkl. Unterordner) · <span class="pr-a-warn" style="padding:1px 7px">–</span> = Kernanalyse ohne Dokument</div>`;
  }

  // ---------------- Projektseite (Detail) ----------------
  function docItem(d) {
    const href = safeHref(d.webUrl);
    const open = href ? `<a class="btn ghost d-open" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Öffnen ↗</a>` : "";
    return `<li><span class="d-name">${esc(d.name)}</span><span class="d-date">${esc(d.docDate || fmtDate(d.modified) || "")}</span>${open}</li>`;
  }
  function sectionHtml(a) {
    const kern = a.core ? `<span class="pr-kern">Kern</span>` : "";
    const warn = a.count === 0 && a.core;
    const docs = a.count
      ? `<ul class="pr-doclist">${a.docs.map(docItem).join("")}</ul>`
      : `<div class="pr-empty">Keine Dokumente${warn ? " — Kernanalyse offen" : ""}.</div>`;
    return `<div class="pr-sec ${warn ? "warn" : ""}"><h4><span class="pr-code">${esc(a.code)}</span>${esc(a.name)}${kern}</h4>${docs}</div>`;
  }
  function renderDetail(d) {
    const sp = safeHref(d.webUrl);
    // „Im Datenraum anzeigen": in den Explorer aus Kapitel 09 springen (01_Datenraum, sonst Projektordner).
    const drPath = [S.projektePath, d.name, d.hasDatenraum ? "01_Datenraum" : ""].filter(Boolean).join("/");
    const drHref = "/datenraeume#/" + drPath.split("/").map(encodeURIComponent).join("/");
    const old = d.alteStruktur ? `<span class="pr-badge old">alte Struktur</span>` : "";
    const emptyCore = (d.analysen || []).filter((a) => a.core && a.count === 0);
    const rest = (d.analysen || []).filter((a) => !(a.core && a.count === 0));
    const emptyCoreHtml = emptyCore.length ? `<div class="pr-seclabel">Offene Kernanalysen</div>${emptyCore.map(sectionHtml).join("")}` : "";
    const restHtml = rest.length ? `<div class="pr-seclabel">Analysen</div>${rest.map(sectionHtml).join("")}` : "";
    const unsorted = d.unsorted && d.unsorted.length
      ? `<ul class="pr-doclist">${d.unsorted.map(docItem).join("")}</ul>`
      : `<div class="pr-empty" style="color:var(--mut)">Keine Dateien zu prüfen.</div>`;
    $("#pr-body").innerHTML = `
      <div class="pr-back"><button class="btn ghost" id="pr-back" type="button">← Zurück zur Übersicht</button></div>
      <div class="pr-head"><h3>${esc(d.projektId || d.name)}</h3>${old}
        <span class="pr-sub">${esc([d.kuerzel, d.stadt].filter(Boolean).join(" · "))}</span></div>
      <div class="pr-actions">
        ${sp ? `<a class="btn" href="${esc(sp)}" target="_blank" rel="noopener noreferrer">Ordner in SharePoint öffnen ↗</a>` : ""}
        <a class="btn ghost" href="${esc(drHref)}">Im Datenraum anzeigen</a>
      </div>
      <div class="pr-summary">Kern ${d.core.filled} von ${d.core.total} · ${d.totalFiles} Datei${d.totalFiles === 1 ? "" : "en"} gesamt${d.lastModified ? ` · zuletzt geändert ${esc(fmtDate(d.lastModified))}` : ""}</div>
      ${emptyCoreHtml}${restHtml}
      <div class="pr-seclabel">Zu prüfen (_UNSORTIERT_Pruefen)</div>
      <div class="pr-sec">${unsorted}</div>`;
  }

  // ---------------- Laden ----------------
  async function loadOverview({ refresh = false } = {}) {
    const seq = ++S.seq;
    $("#pr-body").innerHTML = `<div class="pr-note">Lädt … Beim ersten Öffnen werden alle Projektordner in voller Tiefe gezählt — das kann bis zu ~1 Minute dauern. Danach ist es zwischengespeichert und sofort da.</div>`;
    const d = await api("/api/projekte?full=1&path=" + encodeURIComponent(S.projektePath) + (refresh ? "&refresh=1" : ""));
    if (seq !== S.seq) return;
    if (!d) return;
    if (d.error) { $("#pr-body").innerHTML = `<div class="pr-err">${esc(d.error)}</div>`; return; }
    S.catalog = d.catalog || [];
    S.projects = d.projects || [];
    S.view = "list";
    $("#pr-stand").textContent = "Stand: " + fmtTime(d.indexBuiltAt);
    renderList();
  }
  async function loadDetail(name) {
    const seq = ++S.seq;
    $("#pr-body").innerHTML = `<div class="pr-note">Lädt …</div>`;
    const d = await api("/api/projekt?full=1&path=" + encodeURIComponent(S.projektePath + "/" + name));
    if (seq !== S.seq) return;
    if (!d) return;
    if (d.error) { $("#pr-body").innerHTML = `<div class="pr-err">${esc(d.error)}</div>`; return; }
    S.view = "detail";
    renderDetail(d);
    window.scrollTo(0, 0);
  }

  async function boot() {
    const w = await api("/api/workspace");
    if (!w || w.error || !w.root) {
      $("#pr-body").innerHTML = `<div class="pr-err">${esc((w && (w.error || w.reason)) || "Workspace nicht verfügbar.")}</div>`;
      return;
    }
    const comp = (w.nav || []).find((n) => (n.name || "").toLowerCase() === COMPANY.toLowerCase());
    if (!comp) { $("#pr-body").innerHTML = `<div class="pr-err">Gesellschaft „${esc(COMPANY)}" ist nicht sichtbar.</div>`; return; }
    S.projektePath = comp.name + "/04_Projekte";
    loadOverview();
  }

  // Delegierte Klicks: Zeile öffnen, Zurück.
  document.addEventListener("click", (e) => {
    if (e.target.closest("#pr-back")) { e.preventDefault(); S.view = "list"; renderList(); return; }
    const row = e.target.closest("#pr-body .pr-table tbody tr[data-name]");
    if (row) { loadDetail(row.getAttribute("data-name")); return; }
  });
  $("#pr-f-core").addEventListener("change", () => { if (S.view === "list") renderList(); });
  $("#pr-f-old").addEventListener("change", () => { if (S.view === "list") renderList(); });
  $("#pr-reload").addEventListener("click", () => loadOverview({ refresh: true }));

  boot();
})();
