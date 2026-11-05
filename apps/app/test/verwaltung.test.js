// Testet die Seite „Verwaltung“ und die Aufzeichnung mit ERFUNDENEN Daten (kein Microsoft, keine DB).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { isAdmin, retentionMonths, classifyRequest, browserLabel, createRecorder, activityMiddleware, mountVerwaltung, adminNavLink } from "../src/verwaltung.js";

const ADMIN = { sub: "a1", email: "Letzgus@Nereo.ch", name: "Admin" };
const OTHER = { sub: "u1", email: "person@nereo.ch", name: "Person" };
const pageLabel = (p) => ({ "/": "Dashboard", "/verwaltung": "Verwaltung" }[p] ?? null);
const flush = () => new Promise((r) => setTimeout(r, 25));

test("Admin-Prüfung: Groß-/Kleinschreibung egal, fehlende oder fremde Adresse nie Admin", () => {
  assert.equal(isAdmin(ADMIN, {}), true);
  assert.equal(isAdmin({ email: "kienle@nereo.ch" }, {}), true);
  assert.equal(isAdmin(OTHER, {}), false);
  assert.equal(isAdmin({ sub: "x" }, {}), false);
  assert.equal(isAdmin(null, {}), false);
  assert.equal(isAdmin({ email: "letzgus@nereo.ch.evil.example" }, {}), false);
  assert.equal(isAdmin({ email: "x@nereo.ch" }, { ADMIN_EMAILS: "x@nereo.ch" }), true);
  assert.equal(isAdmin(ADMIN, { ADMIN_EMAILS: "x@nereo.ch" }), false);
});

test("Aufbewahrung: Vorgabe 12 Monate, ungültige Werte fallen darauf zurück", () => {
  assert.equal(retentionMonths({}), 12);
  assert.equal(retentionMonths({ ACTIVITY_RETENTION_MONTHS: "6" }), 6);
  for (const v of ["0", "-1", "abc", "1.5"]) assert.equal(retentionMonths({ ACTIVITY_RETENTION_MONTHS: v }), 12);
});

test("Suchbegriffe werden nie aufgezeichnet", () => {
  assert.equal(classifyRequest({ method: "GET", path: "/api/search", status: 200, query: { q: "Gehalt" } }, pageLabel), null);
});

test("Ausgeschlossene Ordner werden nie aufgezeichnet, in jeder Tiefe und Schreibweise", () => {
  for (const p of ["90_Personal", "nereo.Group/90_PERSONAL_x/a", "a/_ZU_LOESCHEN_b", "a\\90_personal\\b", "a/.DS_Store"])
    assert.equal(classifyRequest({ method: "GET", path: "/api/fs", status: 200, query: { path: p } }, pageLabel), null, p);
});

test("Nur erfolgreiche Anfragen zählen, ohne Query-Strings und Inhalte", () => {
  assert.equal(classifyRequest({ method: "GET", path: "/api/fs", status: 404, query: { path: "geheim" } }, pageLabel), null);
  assert.deepEqual(classifyRequest({ method: "GET", path: "/api/fs", status: 200, query: { path: "a/b", refresh: "1" } }, pageLabel), { art: "ordner", detail: "a/b" });
  assert.deepEqual(classifyRequest({ method: "GET", path: "/", status: 200 }, pageLabel), { art: "seite", detail: "Dashboard" });
  assert.deepEqual(classifyRequest({ method: "POST", path: "/api/write/mail", status: 200, query: {} }, pageLabel), { art: "schreiben", detail: "mail (Vorschau)" });
  assert.deepEqual(classifyRequest({ method: "POST", path: "/api/write/mail", status: 200, query: { confirm: "1" } }, pageLabel), { art: "schreiben", detail: "mail (ausgeführt)" });
  assert.equal(classifyRequest({ method: "GET", path: "/dashboard.js", status: 200 }, pageLabel), null);
});

test("Browser-Name ist kurz und enthält nicht den ganzen User-Agent", () => {
  assert.equal(browserLabel("Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120 Safari/537 Edg/120"), "Edge / Windows");
  assert.equal(browserLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Version/17 Safari/605"), "Safari / Mac");
  assert.equal(browserLabel(""), "Unbekannt");
});

test("Aufzeichnung: fasst Wiederholungen zusammen, Anmeldungen immer, Fehler stören nie", async () => {
  const rows = []; let t = 0;
  const rec = createRecorder({ store: { logActivity: async (e) => rows.push(e) }, now: () => t });
  const req = { session: { user: OTHER }, ip: "198.51.100.1", get: () => "" };
  rec(req, "seite", "Dashboard"); rec(req, "seite", "Dashboard");
  t = 31_000; rec(req, "seite", "Dashboard");
  rec(req, "anmeldung", null, { dedupe: false }); rec(req, "anmeldung", null, { dedupe: false });
  rec({ session: null }, "seite", "ohne Nutzer");
  await flush();
  assert.equal(rows.filter((r) => r.art === "seite").length, 2);
  assert.equal(rows.filter((r) => r.art === "anmeldung").length, 2);
  assert.equal(rows[0].email, OTHER.email);

  const errs = [];
  const bad = createRecorder({ store: { logActivity: async () => { throw new Error("DB weg"); } }, onError: (e) => errs.push(e.message) });
  bad(req, "seite", "x");
  await flush();
  assert.deepEqual(errs, ["DB weg"]);
});

test("Menüpunkt nur für Admins", () => {
  assert.equal(adminNavLink(OTHER), "");
  assert.equal(adminNavLink(null), "");
  assert.match(adminNavLink(ADMIN), /\/verwaltung/);
});

// --- Echte HTTP-Prüfung mit Express und vorgetäuschter Session ---
let server, base, currentUser; const logged = [];
const store = {
  logActivity: async (e) => { logged.push(e); },
  loadActivity: async () => [{ id: 1, sub: "u1", art: "seite", detail: "Dashboard" }],
  loadActivityUsers: async () => [{ sub: "u1", email: OTHER.email }],
};
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = currentUser ? { user: currentUser } : {}; next(); });
  const record = createRecorder({ store, dedupeMs: 0 });
  app.use(activityMiddleware(record, pageLabel));
  mountVerwaltung(app, {
    store, record,
    requireAuth: (req, res, next) => req.session.user ? next() : req.path.startsWith("/api/") ? res.status(401).json({ error: "unauthorized" }) : res.redirect("/login"),
    renderPage: (_k, title, main) => `<title>${title}</title>${main}`,
    sendHtml: (res, html) => res.send(html),
    docLimit: (_req, _res, next) => next(),
  });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const call = (p, o = {}) => fetch(base + p, { redirect: "manual", ...o });

test("Nicht angemeldet: keine Daten", async () => {
  currentUser = null;
  assert.equal((await call("/api/verwaltung/nutzer")).status, 401);
  assert.equal((await call("/api/verwaltung/aktivitaeten")).status, 401);
  assert.equal((await call("/verwaltung")).status, 302);
});

test("Angemeldet ohne Admin-Recht: keine Daten, Versuch wird protokolliert", async () => {
  currentUser = OTHER; logged.length = 0;
  for (const p of ["/api/verwaltung/nutzer", "/api/verwaltung/aktivitaeten"]) {
    const r = await call(p);
    assert.equal(r.status, 403);
    assert.equal(JSON.stringify(await r.json()).includes(OTHER.email), false);
  }
  const page = await call("/verwaltung");
  assert.equal(page.status, 404);
  assert.equal((await page.text()).includes("vw-users"), false);
  await flush();
  assert.equal(logged.filter((e) => e.art === "verweigert").length, 3);
});

test("Admin: sieht Seite und Daten", async () => {
  currentUser = ADMIN;
  assert.equal((await call("/verwaltung")).status, 200);
  const u = await (await call("/api/verwaltung/nutzer")).json();
  assert.equal(u.users.length, 1); assert.equal(u.retentionMonths, 12);
  assert.equal((await (await call("/api/verwaltung/aktivitaeten")).json()).entries.length, 1);
});

test("Dokument-Klick: wird gemeldet, ausgeschlossene Namen und Unsinn nicht", async () => {
  currentUser = OTHER; logged.length = 0;
  const post = (body) => call("/api/aktivitaet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ name: "2026-01-01_Vertrag.pdf" })).status, 204);
  for (const b of [{ name: ".DS_Store" }, { name: "90_Personal_Liste.xlsx" }, { name: "" }, { name: 42 }, {}])
    assert.equal((await post(b)).status, 204);
  await flush();
  assert.deepEqual(logged.filter((e) => e.art === "dokument").map((e) => e.detail), ["2026-01-01_Vertrag.pdf"]);
});
