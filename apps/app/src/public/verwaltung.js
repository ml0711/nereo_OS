// Seite „Verwaltung": lädt Nutzer + Aktivitäten. Alle Werte laufen durch esc().
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = (t) => (t ? new Date(t).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "—");
  const ART = { anmeldung: "Anmeldung", abmeldung: "Abmeldung", seite: "Seite", ordner: "Ordner", projekt: "Projekt", dokument: "Dokument geöffnet", ki: "KI-Aufruf", schreiben: "Schreibaktion", verweigert: "Zugriff verweigert" };
  const PAGE = 100;
  let oldest = null;

  const get = async (u) => {
    const r = await fetch(u);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Daten konnten nicht geladen werden.");
    return d;
  };
  const who = (x) => x.name || x.email || x.sub;

  async function loadUsers() {
    const box = $("#vw-users");
    try {
      const { users, retentionMonths } = await get("/api/verwaltung/nutzer");
      $("#vw-retention").textContent = `Einträge werden nach ${retentionMonths} Monaten automatisch gelöscht.`;
      const sel = $("#vw-f-user");
      for (const u of users) { const o = document.createElement("option"); o.value = u.sub; o.textContent = who(u); sel.append(o); }
      if (!users.length) { box.innerHTML = `<div class="vw-note">Noch keine Einträge.</div>`; return; }
      box.innerHTML = `<div class="vw-wrap"><table class="vw-table"><thead><tr><th>Name</th><th>E-Mail</th><th>Erste Anmeldung</th><th>Letzte Anmeldung</th><th>Zuletzt aktiv</th><th>Anmeldungen</th></tr></thead><tbody>` +
        users.map((u) => `<tr><td>${esc(u.name || "—")}</td><td>${esc(u.email || "—")}</td><td class="nw">${esc(when(u.erste_anmeldung))}</td><td class="nw">${esc(when(u.letzte_anmeldung))}</td><td class="nw">${esc(when(u.letzte_aktivitaet))}</td><td>${esc(u.anmeldungen)}</td></tr>`).join("") +
        `</tbody></table></div>`;
    } catch (e) { box.innerHTML = `<div class="vw-err">${esc(e.message)}</div>`; }
  }

  async function loadLog(append) {
    const box = $("#vw-log"), more = $("#vw-more");
    const q = new URLSearchParams({ limit: PAGE });
    if ($("#vw-f-art").value) q.set("art", $("#vw-f-art").value);
    if ($("#vw-f-user").value) q.set("sub", $("#vw-f-user").value);
    if (append && oldest) q.set("beforeId", oldest);
    try {
      const { entries } = await get("/api/verwaltung/aktivitaeten?" + q);
      const rows = entries.map((x) => `<tr><td class="nw">${esc(when(x.at))}</td><td>${esc(who(x))}</td><td><span class="vw-badge${x.art === "verweigert" ? " bad" : ""}">${esc(ART[x.art] || x.art)}</span></td><td>${esc(x.detail || "")}</td><td class="nw">${esc(x.ip || "")}</td><td class="nw">${esc(x.browser || "")}</td></tr>`).join("");
      if (append) { const t = box.querySelector("tbody"); if (t) t.insertAdjacentHTML("beforeend", rows); }
      else box.innerHTML = entries.length
        ? `<div class="vw-wrap"><table class="vw-table"><thead><tr><th>Zeit</th><th>Person</th><th>Art</th><th>Was</th><th>IP-Adresse</th><th>Browser</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="vw-note">Keine Einträge.</div>`;
      if (entries.length) oldest = entries[entries.length - 1].id;
      more.hidden = entries.length < PAGE;
    } catch (e) { box.innerHTML = `<div class="vw-err">${esc(e.message)}</div>`; more.hidden = true; }
  }

  const reload = () => { oldest = null; loadLog(false); };
  $("#vw-f-art").onchange = reload;
  $("#vw-f-user").onchange = reload;
  $("#vw-more").onclick = () => loadLog(true);
  loadUsers();
  reload();
})();
