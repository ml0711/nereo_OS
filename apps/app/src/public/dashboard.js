// Seite „Dashboard" (Startseite) — KPI-Kacheln mit Handlungsaussage + zwei feste Listen.
// Vasco-Regel: kein Barometer ohne Handlungsaussage — jede Kachel sagt, was zu tun ist, und führt
// per Klick dorthin. Alle Zahlen kommen aus /api/dashboard (dieselben Funktionen wie Projekte + Suche),
// nichts wird hier doppelt berechnet. Kachel „Dateien zu prüfen" / „Neu in 7 Tagen" klappen die Liste
// direkt auf (dafür gibt es keine eigene gefilterte Seite); die anderen springen auf Projekte/Suche.
// Fehlt ein Wert (Index nicht verfügbar), zeigt die Kachel „–" mit Grund — keine erfundenen Werte.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeHref = (u) => (/^https?:\/\//i.test(String(u || "")) ? u : null);
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" }); };
  const fmtTime = (s) => { const d = s ? new Date(s) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); };

  const S = { data: null };

  async function api(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 401) { location.href = "/login"; return null; }
    return r.json().catch(() => null);
  }

  // ---------------- Kachel-Definitionen (Reihenfolge wie in der Aufgabe) ----------------
  // block: aus welchem Datenblock die Zahl kommt · count: liest die Zahl · href ODER panel: Ziel des Klicks.
  const TILES = [
    { key: "kern",    block: "projects", label: "Projekte mit unvollständigem Kern",   action: "Kernanalysen ohne Dokument vervollständigen", count: (p) => p.kernIncompleteCount, href: "/projekte#kern", warn: true },
    { key: "pruefen", block: "projects", label: "Dateien zu prüfen",                    action: "Dateien einsortieren",                        count: (p) => p.zuPruefenTotal,      panel: "pruefen",       warn: true },
    { key: "neu7",    block: "search",   label: "Neu in den letzten 7 Tagen",           action: "zuletzt geänderte Dateien ansehen",           count: (s) => s.neu7Total,           panel: "neu7" },
    { key: "muster",  block: "search",   label: "Nicht nach Konvention benannt",        action: "Dateinamen prüfen und umbenennen",            count: (s) => s.patternNoCount,      href: "/datenraeume?pattern=nein", warn: true },
    { key: "stale",   block: "projects", label: "Projekte ohne Änderung seit 30 Tagen", action: "nachfassen",                                  count: (p) => p.stale30Count,        href: "/projekte#stale", warn: true },
  ];
  const blockOf = (t) => (t.block === "projects" ? S.data.projects : S.data.search);
  const blockErrText = (which) => (which === "projects" ? "Projektdaten nicht verfügbar" : "Datei-Index nicht verfügbar");

  function kpiHtml(t) {
    const block = blockOf(t);
    const err = !block || block.error;
    const inner = err
      ? `<div class="db-num dash">–</div><div class="db-label">${esc(t.label)}</div><div class="db-hint">${esc(blockErrText(t.block))}</div>`
      : `<div class="db-num">${Number(t.count(block) || 0)}</div><div class="db-label">${esc(t.label)}</div><div class="db-action">${esc(t.action)} →</div>`;
    const warn = !err && t.warn && Number(t.count(block) || 0) > 0 ? " warn" : "";
    if (t.href) return `<a class="db-kpi${warn}" href="${esc(t.href)}">${inner}</a>`;
    return `<div class="db-kpi${warn}" data-panel="${esc(t.panel)}" role="button" tabindex="0" aria-label="${esc(t.label)}">${inner}</div>`;
  }

  // ---------------- Bausteine ----------------
  function fileTable(rows, dateLabel, dateOf) {
    const body = rows.map((r) => {
      const href = safeHref(r.webUrl);
      const open = href ? `<a class="btn ghost db-open" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Öffnen ↗</a>` : "";
      return `<tr>
        <td><div class="db-name"><span class="db-ico">•</span><b>${esc(r.name)}</b></div></td>
        <td class="db-num-c">${esc(r.projektId || "")}</td>
        <td class="db-num-c">${esc(dateOf(r))}</td>
        <td class="db-col-r">${open}</td></tr>`;
    }).join("");
    return `<table class="db-table"><thead><tr>
        <th>Name</th><th>Projekt</th><th>${esc(dateLabel)}</th><th></th>
      </tr></thead><tbody>${body}</tbody></table>`;
  }
  const errBox = (block) => `<div class="db-err">Nicht verfügbar: ${esc((block && block.error) || "unbekannt")}</div>`;
  const head = (title, count, panel) =>
    `<div class="db-h"><h3>${esc(title)}</h3><span class="db-count">${esc(count)}</span>` +
    (panel ? `<button class="btn ghost db-close" type="button" data-close="${esc(panel)}">Schließen</button>` : "") +
    `</div>`;

  // ---------------- Aufklappbare Listen (Kachel 2 + 3) ----------------
  function renderPanel(which) {
    if (which === "pruefen") {
      const p = S.data.projects, el = $("#db-panel-pruefen");
      if (!p || p.error) { el.innerHTML = head("Dateien zu prüfen", "", "pruefen") + errBox(p); return; }
      const rows = p.zuPruefen || [];
      const cap = p.zuPruefenTotal > rows.length ? ` · erste ${rows.length} gezeigt` : "";
      el.innerHTML = head("Dateien zu prüfen", `${p.zuPruefenTotal} Datei(en) in _UNSORTIERT_Pruefen${cap}`, "pruefen")
        + (rows.length ? fileTable(rows, "Dokumentdatum", (r) => r.docDate || fmtDate(r.modified) || "") : `<div class="db-empty">Nichts zu prüfen.</div>`);
      return;
    }
    const s = S.data.search, el = $("#db-panel-neu7");
    if (!s || s.error) { el.innerHTML = head("Neu in den letzten 7 Tagen", "", "neu7") + errBox(s); return; }
    const rows = s.neu7 || [];
    const cap = s.neu7Total > rows.length ? ` · erste ${rows.length} gezeigt` : "";
    el.innerHTML = head("Neu in den letzten 7 Tagen", `${s.neu7Total} Datei(en)${cap}`, "neu7")
      + (rows.length ? fileTable(rows, "Geändert", (r) => fmtDate(r.modified)) : `<div class="db-empty">Keine Dateien in den letzten 7 Tagen.</div>`);
  }

  function togglePanel(which) {
    const el = $("#db-panel-" + which);
    if (!el) return;
    const wasHidden = el.hidden;
    $("#db-panel-pruefen").hidden = true;
    $("#db-panel-neu7").hidden = true;
    document.querySelectorAll(".db-kpi.active").forEach((k) => k.classList.remove("active"));
    if (wasHidden) {
      renderPanel(which);
      el.hidden = false;
      const tile = document.querySelector('.db-kpi[data-panel="' + which + '"]');
      if (tile) tile.classList.add("active");
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // ---------------- Feste Listen ----------------
  function renderZuletzt() {
    const s = S.data.search, el = $("#db-zuletzt");
    const inner = (!s || s.error)
      ? errBox(s)
      : (s.zuletzt && s.zuletzt.length ? fileTable(s.zuletzt, "Geändert", (r) => fmtDate(r.modified)) : `<div class="db-empty">Keine Dateien.</div>`);
    el.innerHTML = `<div class="db-h"><h3>Zuletzt geändert</h3><span class="db-count">10 neueste</span></div>` + inner;
  }
  function renderKernFehlen() {
    const p = S.data.projects, el = $("#db-kernfehlen");
    if (!p || p.error) { el.innerHTML = `<div class="db-h"><h3>Kernanalysen fehlen</h3></div>` + errBox(p); return; }
    const list = p.kernFehlen || [];
    const inner = list.length
      ? `<ul class="db-kf">` + list.map((k) => {
          const codes = (k.missing || []).map((m) => `<span class="db-code" title="${esc(m.name)}">${esc(m.code)}</span>`).join("");
          return `<li><span class="db-kf-pid"><a href="/projekte#kern">${esc(k.projektId || k.name)}</a></span><span class="db-kf-codes">${codes}</span></li>`;
        }).join("") + `</ul>`
      : `<div class="db-empty">Bei allen Projekten sind die Kernanalysen mit Dokumenten belegt.</div>`;
    el.innerHTML = `<div class="db-h"><h3>Kernanalysen fehlen</h3><span class="db-count">${list.length} Projekt(e)</span></div>` + inner;
  }

  // ---------------- Rendern + Laden ----------------
  function render() {
    $("#db-stand").textContent = "Stand: " + fmtTime(S.data.generatedAt);
    $("#db-kpis").innerHTML = TILES.map(kpiHtml).join("");
    $("#db-panel-pruefen").hidden = true;
    $("#db-panel-neu7").hidden = true;
    renderZuletzt();
    renderKernFehlen();
  }

  async function load({ refresh = false } = {}) {
    $("#db-kpis").innerHTML = `<div class="db-note">Lädt … Beim ersten Öffnen werden alle Projektordner in voller Tiefe gezählt und der Datei-Index aufgebaut — das kann bis zu ~1 Minute dauern. Danach ist es zwischengespeichert und sofort da.</div>`;
    const d = await api("/api/dashboard" + (refresh ? "?refresh=1" : ""));
    if (!d) return;
    if (d.error) { $("#db-kpis").innerHTML = `<div class="db-err">${esc(d.error)}</div>`; return; }
    S.data = d;
    render();
  }

  // Delegierte Klicks: Panel-Kachel auf/zu, Schließen-Knopf.
  document.addEventListener("click", (e) => {
    const close = e.target.closest(".db-close[data-close]");
    if (close) {
      const w = close.getAttribute("data-close");
      const el = $("#db-panel-" + w); if (el) el.hidden = true;
      const tile = document.querySelector('.db-kpi[data-panel="' + w + '"]'); if (tile) tile.classList.remove("active");
      return;
    }
    const tile = e.target.closest(".db-kpi[data-panel]");
    if (tile) { e.preventDefault(); togglePanel(tile.getAttribute("data-panel")); return; }
  });
  // Panel-Kacheln auch per Tastatur (Enter/Leertaste) — sie sind role="button".
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tile = e.target.closest(".db-kpi[data-panel]");
    if (tile) { e.preventDefault(); togglePanel(tile.getAttribute("data-panel")); }
  });
  $("#db-reload").addEventListener("click", () => load({ refresh: true }));

  load();
})();
