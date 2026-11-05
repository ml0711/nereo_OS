// Seite „Verwaltung": nur für Admins. Zeigt, wer sich angemeldet hat und was in der App passiert ist.
// Regeln:
//  · Admin-Prüfung IMMER serverseitig (Seite + API). Andere sehen weder Menüpunkt noch Daten.
//  · Suchbegriffe werden NICHT aufgezeichnet (/api/search fehlt bewusst in classifyRequest).
//  · Ausgeschlossene Ordner/Dateien (Bauregel 3) landen nie im Protokoll.
//  · Es werden nie Query-Strings oder Inhalte gespeichert, nur Art + kurze Beschreibung.
//  · Ein Protokollfehler darf nie eine Nutzeranfrage stören.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isExcluded } from "../../../packages/graph-client/src/workspace.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// EINE Stelle für die Admins. Per ENV ADMIN_EMAILS (kommagetrennt) überschreibbar.
const DEFAULT_ADMINS = "letzgus@nereo.ch,kienle@nereo.ch";
export const adminEmails = (env = process.env) =>
  String(env.ADMIN_EMAILS || DEFAULT_ADMINS).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
export const isAdmin = (user, env = process.env) =>
  Boolean(user?.email) && adminEmails(env).includes(String(user.email).trim().toLowerCase());

// Aufbewahrung in Monaten (Vorgabe 12, offen für Mikes Entscheidung). Ungültige Werte -> Vorgabe.
export function retentionMonths(env = process.env) {
  const n = Number(env.ACTIVITY_RETENTION_MONTHS);
  return Number.isInteger(n) && n > 0 ? n : 12;
}

const hasExcludedPart = (p) => String(p ?? "").split(/[\\/]+/).some((seg) => isExcluded(seg));
const clip = (s, n = 500) => String(s ?? "").slice(0, n);

/** Ordnet eine abgeschlossene Anfrage einer Aktivität zu. null = wird nicht aufgezeichnet. */
export function classifyRequest({ method, path, status, query = {} }, pageLabel = () => null) {
  if (status < 200 || status >= 400) return null;
  if (method === "GET") {
    if (path === "/api/fs" || path === "/api/projekt") {
      const p = query.path;
      if (typeof p !== "string" || !p || hasExcludedPart(p)) return null;
      return { art: path === "/api/fs" ? "ordner" : "projekt", detail: clip(p) };
    }
    const label = pageLabel(path);
    if (label) return { art: "seite", detail: clip(label) };
  }
  if (path === "/api/datarooms/analyze") return { art: "ki", detail: "Datenraum-Analyse" };
  if (path.startsWith("/api/write/") && method !== "GET") {
    const confirmed = query.confirm === "1";
    return { art: "schreiben", detail: `${path.slice("/api/write/".length)} (${confirmed ? "ausgeführt" : "Vorschau"})` };
  }
  return null;
}

/** Kurzer, lesbarer Browser-Name statt des kompletten User-Agent. */
export function browserLabel(ua = "") {
  const s = String(ua);
  const b = /Edg\//.test(s) ? "Edge" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "Unbekannt";
  const o = /iPhone|iPad/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Windows/.test(s) ? "Windows" : /Mac OS X/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : "";
  return o ? `${b} / ${o}` : b;
}

/** Baut die Aufzeichnung. dedupeMs fasst gleiche Einträge kurz hintereinander zusammen. */
export function createRecorder({ store, dedupeMs = 30_000, now = () => Date.now(), onError = (e) => console.error("Aktivitäts-Log:", e.message) }) {
  const seen = new Map();
  return function record(req, art, detail = null, { dedupe = true } = {}) {
    const u = req.session?.user;
    if (!u?.sub) return;
    if (dedupe) {
      const key = `${u.sub}|${art}|${detail}`, t = now();
      if (t - (seen.get(key) ?? -Infinity) < dedupeMs) return;
      seen.set(key, t);
      if (seen.size > 5000) seen.clear();
    }
    Promise.resolve()
      .then(() => store.logActivity({
        sub: u.sub, email: u.email ?? null, name: u.name || u.username || null,
        art, detail, ip: req.ip ?? null, browser: browserLabel(req.get?.("user-agent")),
      }))
      .catch(onError);
  };
}

/** Middleware: zeichnet nach Abschluss jeder Anfrage auf, was classifyRequest zulässt. */
export function activityMiddleware(record, pageLabel) {
  return (req, res, next) => {
    const { method, path, query } = req;
    res.on("finish", () => {
      const hit = classifyRequest({ method, path, query, status: res.statusCode }, pageLabel);
      if (hit) record(req, hit.art, hit.detail);
    });
    next();
  };
}

export const VERWALTUNG_MAIN = `<div class="vw">
  <section><h3>Nutzer</h3><p class="vw-note">Alle Personen, die seit dem Start der Aufzeichnung aktiv waren.</p><div id="vw-users"><div class="vw-note">Wird geladen …</div></div></section>
  <section><h3>Aktivitäten</h3>
    <div class="vw-filter">
      <select id="vw-f-art" aria-label="Art filtern"><option value="">Art: alle</option><option value="anmeldung">Anmeldung</option><option value="abmeldung">Abmeldung</option><option value="seite">Seite</option><option value="ordner">Ordner</option><option value="projekt">Projekt</option><option value="dokument">Dokument geöffnet</option><option value="ki">KI-Aufruf</option><option value="schreiben">Schreibaktion</option><option value="verweigert">Zugriff verweigert</option></select>
      <select id="vw-f-user" aria-label="Nutzer filtern"><option value="">Nutzer: alle</option></select>
    </div>
    <div id="vw-log"></div>
    <button class="btn ghost" id="vw-more" hidden>Mehr laden</button>
    <p class="vw-note" id="vw-retention"></p>
  </section>
</div>
<style>
  .vw section{margin-bottom:28px}
  .vw h3{font-size:15px;font-weight:700;color:var(--ink);margin:0 0 4px}
  .vw-note{color:var(--mut);font-size:12px;margin:0 0 10px}
  .vw-filter{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 10px}
  .vw-filter select{padding:7px 9px;border:1px solid var(--line);border-radius:var(--r-list);background:#fff;color:var(--txt);font:inherit}
  .vw-wrap{overflow-x:auto;margin-bottom:10px}
  .vw-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);font-size:12.5px}
  .vw-table thead th{background:var(--ink);color:#fff;text-align:left;font-weight:600;font-size:11.5px;padding:8px 12px;white-space:nowrap}
  .vw-table tbody td{padding:8px 12px;border-top:1px solid var(--line2);vertical-align:top}
  .vw-table .nw{white-space:nowrap}
  .vw-badge{display:inline-block;padding:1px 7px;border-radius:var(--r-list);font-size:11px;background:var(--soft);color:var(--ink);white-space:nowrap}
  .vw-badge.bad{background:#fff;border:1px solid var(--bad);color:var(--bad)}
  .vw-err{color:var(--bad);font-size:13px;padding:6px 0}
</style>
<script src="/verwaltung.js" defer></script>`;

/** Hängt Seite + API ein. renderPage/sendHtml/requireAuth/rateLimit kommen aus server.js. */
export function mountVerwaltung(app, { store, record, requireAuth, renderPage, sendHtml, docLimit }) {
  const denyApi = (req, res, next) => {
    if (isAdmin(req.session?.user)) return next();
    record(req, "verweigert", clip(req.path, 100));
    res.status(403).json({ error: "Keine Berechtigung." });
  };

  app.get("/verwaltung", requireAuth, (req, res) => {
    if (!isAdmin(req.session?.user)) {
      record(req, "verweigert", "/verwaltung");
      return res.status(404).send(renderPage("", "Seite nicht gefunden", `<div class="empty">Diese Seite gibt es nicht.</div>`));
    }
    sendHtml(res, renderPage("verwaltung", "Verwaltung", VERWALTUNG_MAIN));
  });
  app.get("/verwaltung.js", (_req, res) => {
    res.set("content-type", "application/javascript; charset=utf-8");
    res.send(readFileSync(resolve(__dir, "public/verwaltung.js"), "utf8"));
  });

  app.get("/api/verwaltung/nutzer", requireAuth, denyApi, async (_req, res) => {
    try { res.json({ users: await store.loadActivityUsers(), retentionMonths: retentionMonths() }); }
    catch (e) { console.error("Verwaltung:", e.message); res.status(503).json({ error: "Aufzeichnung nicht verfügbar." }); }
  });
  app.get("/api/verwaltung/aktivitaeten", requireAuth, denyApi, async (req, res) => {
    const str = (v) => (typeof v === "string" && v ? v : null);
    try {
      res.json({ entries: await store.loadActivity({
        art: str(req.query.art), sub: str(req.query.sub),
        limit: req.query.limit, beforeId: str(req.query.beforeId),
      }) });
    } catch (e) { console.error("Verwaltung:", e.message); res.status(503).json({ error: "Aufzeichnung nicht verfügbar." }); }
  });

  // Klick auf „In SharePoint öffnen“: Der Link führt direkt zu Microsoft, darum meldet der Browser ihn.
  app.post("/api/aktivitaet", requireAuth, docLimit, (req, res) => {
    const name = req.body?.name;
    if (typeof name === "string" && name.trim() && !hasExcludedPart(name)) record(req, "dokument", clip(name.trim(), 300));
    res.status(204).end();
  });
}

/** Menüpunkt nur für Admins. Füllt den Platzhalter aus navHtml. */
export function adminNavLink(user, active = false) {
  if (!isAdmin(user)) return "";
  return `<a class="${active ? "active" : ""}" href="/verwaltung"><span class="ico">◎</span> Verwaltung</a>`;
}

