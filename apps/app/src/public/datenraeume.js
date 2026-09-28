// Seite „Datenräume" — Ordner-/Datei-Browser je Gesellschaft.
// Holt Gesellschaften aus /api/workspace und Ebenen aus /api/fs?counts=1 (Server filtert die
// Ausschlüsse zentral, bevor etwas ankommt). Kein KI-Analyse-Knopf (eigener späterer Schritt).
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
  const fmtTime = (s) => { const d = s ? new Date(s) : new Date(); return isNaN(d) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

  const S = { companies: [], path: [], seq: 0 }; // path[0] = Gesellschaft

  async function api(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 401) { location.href = "/login"; return null; }
    return r.json().catch(() => null);
  }

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

  async function boot() {
    const w = await api("/api/workspace");
    if (!w || w.error || !w.root) {
      $("#dr-body").innerHTML = `<div class="dr-err">${esc((w && (w.error || w.reason)) || "Workspace nicht verfügbar.")}</div>`;
      return;
    }
    S.companies = (w.nav || []).map((n) => n.name);
    if (!S.companies.length) { $("#dr-body").innerHTML = `<div class="dr-note">Keine Gesellschaft konfiguriert.</div>`; return; }
    $("#dr-company").innerHTML = S.companies.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    load([S.companies[0]]);
  }

  // Delegierte Klicks: Brotkrumen + Ordner öffnen.
  document.addEventListener("click", (e) => {
    const cr = e.target.closest(".dr-crumbs a[data-i]");
    if (cr) { load(S.path.slice(0, +cr.dataset.i + 1)); return; }
    const row = e.target.closest(".dr-table tbody tr.folder");
    if (row) { load([...S.path, row.getAttribute("data-name")]); return; }
  });
  $("#dr-company").addEventListener("change", (e) => load([e.target.value]));
  $("#dr-reload").addEventListener("click", () => load(S.path, { refresh: true }));

  boot();
})();
