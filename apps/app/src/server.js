// nereo OS — App-Service (Dashboard + JSON-API).
// Gated per OIDC (LogTo): die App ist ihr eigener OIDC-Client + hält die Session.
// Login -> direkt ins Dashboard; Logout im Dashboard. Read-only Graph-Index aus App-Postgres.
// SCHREIBEN nach SharePoint/Outlook über /api/write/* — Guardrails: Kill-Switch
//   (GRAPH_WRITE_ENABLED), Dry-run-Default (confirm=1 führt aus), Audit-Log. Siehe CLAUDE.md §2/§3.

import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractDataRooms, summarizeDataRooms, isDataRoomName } from "../../../packages/graph-client/src/datarooms.js";
import { createGraphClient, graphConfigFromEnv } from "../../../packages/graph-client/src/index.js";
import { loadLatestIndex, loadAnalyses, logWrite, loadWriteAudit, pingDb } from "../../../packages/graph-client/src/index-store.js";
import { resolveRoot, safeRelSegments } from "../../../packages/graph-client/src/workspace.js";
import { resolveCapability, serializeCapability } from "../../../packages/graph-client/src/structure.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../../..");
const INDEX_PATH = resolve(ROOT, ".data/graph-index.json");

const {
  LOGTO_ENDPOINT,
  LOGTO_APP_ID,
  LOGTO_APP_SECRET,
  APP_BASE_URL = "https://app.nereo-os.de",
  SESSION_SECRET = crypto.randomBytes(16).toString("hex"),
  ANALYZE_TRIGGER_SECRET,
  PORT = 3000,
} = process.env;

// Schreib-Kill-Switch (Ops-Guardrail, unabhängig vom Azure-Consent): Writes nur wenn =1.
const GRAPH_WRITE_ENABLED = process.env.GRAPH_WRITE_ENABLED === "1";

const ISSUER = LOGTO_ENDPOINT ? `${LOGTO_ENDPOINT.replace(/\/$/, "")}/oidc` : null;
const REDIRECT_URI = `${APP_BASE_URL.replace(/\/$/, "")}/callback`;
const AUTH_CONFIGURED = Boolean(LOGTO_ENDPOINT && LOGTO_APP_ID && LOGTO_APP_SECRET);

const app = express();
app.set("trust proxy", 1); // hinter Traefik (TLS terminiert dort)
app.use(express.json({ limit: "1mb" })); // JSON-Bodies der /api/write/*-Endpoints
app.use(cookieSession({
  name: "nereo_app", keys: [SESSION_SECRET], maxAge: 7 * 24 * 3600 * 1000,
  sameSite: "lax", secure: true, httpOnly: true,
}));

// Schlanke Security-Header (kein helmet-Dep). Kein CSP: das Dashboard nutzt Inline-
// Styles/Script — strenges CSP würde es brechen (vor Go-Live mit Nonces nachziehen).
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  next();
});

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// Konstantzeit-Vergleich für Secrets (kein Timing-Leak).
function safeEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Dependency-freies In-Memory-Rate-Limit (pro Prozess). Schützt teure Endpoints
// (Claude-Spend bei /analyze, Graph-Writes) vor versehentlichem Hämmern.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now); hits.set(key, arr);
    return true;
  };
}
const keyOf = (req) => req.session?.user?.sub || req.ip || "anon";
const analyzeBudget = rateLimiter({ windowMs: 5 * 60 * 1000, max: 30 });
const writeBudget = rateLimiter({ windowMs: 5 * 60 * 1000, max: 40 });
const navBudget = rateLimiter({ windowMs: 60 * 1000, max: 60 }); // Live-Navigation = Graph-Call-Verstärker
const limit = (budget, msg) => (req, res, next) =>
  budget(keyOf(req)) ? next() : res.status(429).json({ error: msg });

// ---------- Workspace-Navigation (spiegelt die SharePoint-Struktur, CLAUDE.md §1) ----------
// Read-only Graph-Client (Singleton, Token wird intern gecacht). Schreiben läuft NIE hierüber,
// sondern ausschließlich über /api/write/* (graphFor + Guardrails).
let _navClient = null;
function navClient() {
  if (!_navClient) _navClient = createGraphClient(graphConfigFromEnv());
  return _navClient;
}

// Kurzlebiger (Driveelter,Name)->Kind-Cache, damit tiefe Navigation nicht bei JEDEM Klick die
// gesamte Vorfahrenkette neu auflistet (N+1-Verstärker). 45s Staleness ist für Live-Nav ok;
// Miss fällt auf einen echten childByName-Call zurück.
const CHILD_TTL_MS = 45 * 1000;
const _childCache = new Map(); // key `${driveId}|${parentId}|${name}` -> { node, at }
async function cachedChild(client, driveId, parentId, name) {
  const key = `${driveId}|${parentId}|${name}`;
  const hit = _childCache.get(key);
  if (hit && Date.now() - hit.at < CHILD_TTL_MS) return hit.node;
  const node = await client.childByName(driveId, parentId, name);
  _childCache.set(key, { node, at: Date.now() });
  if (_childCache.size > 5000) _childCache.clear(); // simpler Backstop gegen unbegrenztes Wachstum
  return node;
}

// Id-basierter Abstieg von der Wurzel entlang der Pfad-Segmente. Containment by construction:
// es werden NUR Kinder eines bereits aufgelösten Elterns akzeptiert — driveId bleibt server-fix,
// kein client-geliefertes itemId wird je blind gelistet (Schutz gegen Ausbruch aus dem Workspace).
async function descend(client, root, segments) {
  let cur = { id: root.itemId, name: root.name, webUrl: root.webUrl, folder: {} };
  for (const seg of segments) {
    const next = await cachedChild(client, root.driveId, cur.id, seg);
    if (!next) { const e = new Error(`Pfad nicht (mehr) vorhanden: "${seg}".`); e.status = 404; throw e; }
    if (!next.folder) { const e = new Error(`"${seg}" ist kein Ordner.`); e.status = 400; throw e; }
    cur = next;
  }
  return cur;
}

// ---------- OIDC (Authorization-Code + PKCE) ----------
app.get("/login", (req, res) => {
  if (!AUTH_CONFIGURED) return res.status(503).send("Auth nicht konfiguriert.");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  req.session.pkce = verifier;
  req.session.state = state;
  const u = new URL(`${ISSUER}/auth`);
  u.searchParams.set("client_id", LOGTO_APP_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  res.redirect(u.toString());
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`${error}: ${error_description} — <a href="/login">neu anmelden</a>`);
    if (!code || !state || state !== req.session.state)
      return res.status(400).send('Ungültiger State. <a href="/login">neu anmelden</a>');
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: REDIRECT_URI,
      client_id: LOGTO_APP_ID,
      code_verifier: req.session.pkce || "",
    });
    const r = await fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(`${LOGTO_APP_ID}:${LOGTO_APP_SECRET}`).toString("base64"),
      },
      body,
    });
    if (!r.ok) return res.status(502).send('Token-Austausch fehlgeschlagen. <a href="/login">neu</a>');
    const tok = await r.json();
    const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
    req.session.user = { sub: claims.sub, email: claims.email, name: claims.name, username: claims.username };
    // id_token aufheben: LogTo braucht ihn beim Logout als id_token_hint, um die
    // SSO-Session wirklich zu beenden (sonst still re-login -> "trotzdem eingeloggt").
    req.session.idToken = tok.id_token;
    req.session.pkce = undefined;
    req.session.state = undefined;
    res.redirect("/");
  } catch (e) {
    res.status(500).send('Login-Fehler. <a href="/login">neu</a>');
  }
});

app.get("/logout", (req, res) => {
  // id_token VOR dem Leeren der Session sichern — ohne id_token_hint beendet LogTo
  // die SSO-Session nicht zuverlässig, der nächste /login re-authentifiziert still
  // durch und der User landet sofort wieder im Dashboard ("trotzdem eingeloggt").
  const idToken = req.session?.idToken;
  req.session = null;
  if (!AUTH_CONFIGURED) return res.redirect("/");
  const u = new URL(`${ISSUER}/session/end`);
  if (idToken) u.searchParams.set("id_token_hint", idToken);
  u.searchParams.set("client_id", LOGTO_APP_ID);
  u.searchParams.set("post_logout_redirect_uri", APP_BASE_URL);
  res.redirect(u.toString());
});

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  res.redirect("/login");
}

// ---------- public ----------
// status bleibt "ok", solange der Container läuft (Coolify soll ihn nicht wegen
// DB-Problemen neustarten). db-Feld macht den degradierten Zustand (DB-first fällt
// still auf Datei zurück) nach außen sichtbar — fürs Monitoring/Alerting.
app.get("/healthz", async (_req, res) => {
  const db = !process.env.DATABASE_URL ? "n/a" : (await pingDb()) ? "ok" : "down";
  res.json({ service: "nereo-os-app", status: "ok", db, write: GRAPH_WRITE_ENABLED });
});

// ---------- gated: Dashboard + APIs ----------
app.get("/", (req, res) => {
  if (!req.session || !req.session.user) return res.redirect("/login");
  res.set("content-type", "text/html; charset=utf-8");
  res.send(readFileSync(resolve(__dir, "public/dashboard.html"), "utf8"));
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: req.session.user }));

async function loadIndex() {
  if (process.env.DATABASE_URL) {
    try {
      const idx = await loadLatestIndex();
      if (idx) return { index: idx, source: "postgres" };
    } catch (e) { console.error("Postgres-Index nicht lesbar, Fallback Datei:", e.message); }
  }
  try {
    return { index: JSON.parse(readFileSync(INDEX_PATH, "utf8")), source: "file" };
  } catch { return null; }
}

app.get("/api/datarooms", requireAuth, async (req, res) => {
  const loaded = await loadIndex();
  if (!loaded) return res.status(503).json({ error: "Kein Graph-Index (Postgres leer + keine Datei). 'graph:export' + Seed nötig." });
  const { index, source } = loaded;
  const rooms = extractDataRooms(index);
  let analyses = {};
  try { analyses = await loadAnalyses(); } catch (e) { console.error("Analysen nicht lesbar:", e.message); }
  res.json({
    source,
    generatedAt: index.generatedAtMs,
    roles: index.roles,
    summary: summarizeDataRooms(rooms),
    analyzed: Object.keys(analyses).length,
    rooms: rooms.map((r) => ({ ...r, analysis: analyses[r.path] || null })),
  });
});

// KI-Analyse on-demand, GEZIELT (Token-Schutz — kein "alles auf einmal" aus der UI):
//   ?path=<datenraum>   -> genau dieser Datenraum   (eingeloggt ODER Secret)
//   ?project=<projekt>  -> alle Räume des Projekts   (eingeloggt ODER Secret)
//   (ohne Filter)       -> Bulk ALLE — NUR per Secret (curl/cron), nicht aus der Session
// Secret kommt als Header `X-Analyze-Token` (nicht als URL-Query — sonst landet es in
// Proxy-/Access-Logs und Browser-History). Vergleich konstantzeitig.
async function analyzeHandler(req, res) {
  const bySecret = safeEqual(req.get("x-analyze-token"), ANALYZE_TRIGGER_SECRET);
  const bySession = req.session && req.session.user;
  if (!bySecret && !bySession) return res.status(403).json({ error: "forbidden" });
  // CSRF: der kostenpflichtige (Claude-Spend) Session-Pfad darf NICHT per GET laufen — ein
  // SameSite=lax-Cookie würde bei Cross-Site-GET-Navigation mitfahren. GET nur mit Header-Secret
  // (cron/curl; Custom-Header ist cross-site nicht setzbar → CSRF-sicher).
  if (req.method === "GET" && !bySecret) return res.status(405).json({ error: "Analyse bitte per POST aufrufen." });

  // LIVE-Analyse: Datenraum direkt aus der Graph-Struktur bauen (kein gecachter Index nötig) —
  // so erreichbar für neue/umbenannte Datenräume. room.path == cached dataroom_key (gleicher Key).
  if (req.query.live === "1") {
    if (!bySession) return res.status(403).json({ error: "Live-Analyse nur eingeloggt." });
    let segments;
    try { segments = safeRelSegments(req.query.path); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!segments.length) return res.status(400).json({ error: "Live-Analyse braucht ?path=<Datenraum>." });
    try {
      const client = navClient();
      const { root, reason } = await resolveRoot(client);
      if (!root) return res.status(503).json({ error: reason || "Workspace-Wurzel nicht auflösbar." });
      const target = await descend(client, root, segments);
      // Analysierbarkeit prüfen (gleiche Logik wie /api/fs): nur Positionen mit live-room-Strategie
      // (Datenraum per Name/Struktur ODER einzelnes Projekt) — nicht beliebige Ordner, und NICHT
      // der nackte Projekte-/Container-Wurzelordner (sonst Aggregat-Score über alle Projekte).
      const kids = await client.listChildren(root.driveId, target.id);
      const childFolderNames = kids.filter((k) => k.folder).map((k) => k.name);
      const cap = resolveCapability({
        relPath: segments.join("/"), name: target.name, segments, depth: segments.length, isRoot: false, childFolderNames,
      });
      if (cap.analysis?.strategy !== "live-room")
        return res.status(400).json({ error: "An dieser Position ist keine KI-Analyse vorgesehen (kein Datenraum/Projekt)." });
      if (cap.id === "projects" && segments.length <= 1)
        return res.status(400).json({ error: "Bitte ein einzelnes Projekt wählen, nicht den gesamten Projekte-Ordner." });
      const { buildLiveRoom } = await import("../../../packages/graph-client/src/live-room.js");
      const { analyzeLiveRoom } = await import("./analyze.js");
      const room = await buildLiveRoom(client, {
        driveId: root.driveId, itemId: target.id, relPath: segments.join("/"),
        rootName: root.name, name: target.name, owner: root.owner,
      });
      return res.json(await analyzeLiveRoom(room));
    } catch (e) {
      return res.status(e.status || 502).json({ error: e.body ?? e.message });
    }
  }

  const { analyzeOne, analyzeProject, analyzeMissing } = await import("./analyze.js");
  const force = req.query.force === "1";
  if (req.query.path) return res.json(await analyzeOne(String(req.query.path)));
  if (req.query.project) return res.json(await analyzeProject(String(req.query.project), { force }));
  if (!bySecret) return res.status(400).json({ error: "Bulk-Analyse nur per Secret (Header X-Analyze-Token). Nutze ?path= oder ?project= (Token-Schutz)." });
  return res.json(await analyzeMissing({ force }));
}
app.get("/api/datarooms/analyze", limit(analyzeBudget, "Zu viele Analyse-Anfragen — kurz warten."), analyzeHandler);
app.post("/api/datarooms/analyze", limit(analyzeBudget, "Zu viele Analyse-Anfragen — kurz warten."), analyzeHandler);

// GET /api/workspace — die FIXE Wurzel + ihre Top-Level-Kinder als Sidebar-Sektionen.
// Einmal beim Boot der Shell. Degradiert (200 + root:null + candidates) statt zu crashen,
// wenn die Wurzel nicht auflösbar ist — die UI zeigt dann einen Konfig-Hinweis.
app.get("/api/workspace", requireAuth, async (req, res) => {
  let client;
  try { client = navClient(); }
  catch (e) { return res.status(503).json({ error: `Graph nicht konfiguriert: ${e.message}` }); }
  try {
    const { root, reason, candidates } = await resolveRoot(client, { force: req.query.refresh === "1" });
    if (!root) return res.json({ root: null, reason, candidates: candidates ?? [] });
    const kids = await client.listChildren(root.driveId, root.itemId);
    const nav = kids
      .filter((k) => k.folder)
      .map((k) => {
        // Sidebar-Capability namensbasiert (Signal A reicht hier; die ≥3-Kinder-Erkennung
        // für verschachtelte Datenräume passiert erst beim Navigieren in /api/fs).
        const ctx = { relPath: k.name, name: k.name, segments: [k.name], depth: 1, isRoot: false, childFolderNames: [] };
        const cap = serializeCapability(resolveCapability(ctx), { writeEnabled: GRAPH_WRITE_ENABLED });
        return { name: k.name, path: k.name, type: "folder", itemId: k.id, webUrl: k.webUrl ?? null, childCount: k.folder?.childCount ?? null, capability: cap };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    res.json({
      root: { name: root.name, driveId: root.driveId, itemId: root.itemId, webUrl: root.webUrl, owner: root.owner, ownerUpn: root.ownerUpn },
      nav,
      writeEnabled: GRAPH_WRITE_ENABLED,
      cachedAt: root.resolvedAt,
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.body ?? e.message });
  }
});

// GET /api/fs?path=<rel> — Live-Navigation EINER Ebene (spiegelt SharePoint), id-basiert.
// Liefert Kinder + Breadcrumb + die ortsabhängige Capability (View + Aktionen).
app.get("/api/fs", requireAuth, limit(navBudget, "Zu viele Navigations-Anfragen — kurz warten."), async (req, res) => {
  let client, segments;
  try { client = navClient(); }
  catch (e) { return res.status(503).json({ error: `Graph nicht konfiguriert: ${e.message}` }); }
  try { segments = safeRelSegments(req.query.path); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const { root, reason } = await resolveRoot(client);
    if (!root) return res.status(503).json({ error: reason || "Workspace-Wurzel nicht auflösbar." });
    const isRoot = segments.length === 0;
    const target = await descend(client, root, segments);
    const kids = await client.listChildren(root.driveId, target.id);
    const childFolderNames = kids.filter((k) => k.folder).map((k) => k.name);
    const relPath = segments.join("/");
    const ctx = { relPath, name: isRoot ? root.name : target.name, segments, depth: segments.length, isRoot, childFolderNames };
    const cap = serializeCapability(resolveCapability(ctx), { writeEnabled: GRAPH_WRITE_ENABLED });
    const breadcrumb = [{ name: root.name, path: "" }];
    for (let i = 0; i < segments.length; i++) breadcrumb.push({ name: segments[i], path: segments.slice(0, i + 1).join("/") });
    const children = kids
      .map((k) => ({
        name: k.name,
        path: [...segments, k.name].join("/"),
        type: k.folder ? "folder" : "file",
        itemId: k.id,
        webUrl: k.webUrl ?? null,
        size: k.size ?? 0,
        childCount: k.folder?.childCount ?? null,
        modified: k.lastModifiedDateTime ?? null,
        ext: k.file ? (k.name.includes(".") ? k.name.split(".").pop().toLowerCase() : "") : null,
        // Inline-Analyse-Button nur an Ordnern, die schon am Namen als Datenraum erkennbar sind
        // (Struktur-Signal bräuchte einen Extra-Graph-Call pro Kind). Struktur-Datenräume bleiben
        // über die Datenraum-View beim Reinnavigieren analysierbar.
        analyzable: k.folder ? isDataRoomName(k.name) : false,
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "de") : a.type === "folder" ? -1 : 1));
    res.json({
      path: relPath,
      parentPath: isRoot ? null : segments.slice(0, -1).join("/"),
      capability: cap,
      breadcrumb,
      self: { name: isRoot ? root.name : target.name, itemId: target.id, webUrl: isRoot ? root.webUrl : target.webUrl ?? null, driveId: root.driveId },
      // dataroom_key (== gecachter Analyse-Schlüssel), nur an Datenraum-Positionen.
      indexPath: cap.id === "dataroom" ? `/${root.name}/${relPath}`.replace(/\/+$/, "") : null,
      children,
      source: "live",
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.body ?? e.message });
  }
});

// =====================================================================
// SCHREIBEN nach SharePoint / Outlook  —  /api/write/*
// Guardrails (CLAUDE.md §2):
//   1) GRAPH_WRITE_ENABLED=1 muss gesetzt sein (Ops-Kill-Switch).
//   2) Eingeloggt (requireAuth) — der Actor landet im Audit-Log.
//   3) DRY-RUN ist Default: ohne ?confirm=1 wird NICHTS ausgeführt, nur das
//      geplante Kommando zurückgegeben (Mensch-im-Loop-Preview).
//   4) Jede Mutation (auch Dry-run/Fehler) -> graph_write_audit in App-Postgres.
// =====================================================================
function requireWrite(req, res, next) {
  if (!GRAPH_WRITE_ENABLED)
    return res.status(503).json({ error: "Schreibzugriff deaktiviert. GRAPH_WRITE_ENABLED=1 setzen." });
  try { graphConfigFromEnv(); }
  catch (e) { return res.status(503).json({ error: e.message }); }
  next();
}

// Baut den Graph-Client für diesen Request: Actor fürs Audit + dryRun außer confirm=1.
function graphFor(req) {
  const confirm = req.query.confirm === "1" || req.body?.confirm === true || req.body?.confirm === "1";
  const u = req.session?.user ?? {};
  const actor = u.email || u.username || u.sub || "unknown";
  const client = createGraphClient(graphConfigFromEnv(), {
    dryRun: !confirm,
    onWrite: (op) => logWrite({ ...op, actor }).catch((e) => console.error("Audit-Log:", e.message)),
  });
  return { client, confirm };
}

// Einheitliche Ausführung + Antwort. dryRun?-Flag macht im UI klar: Preview vs. echt.
async function runWrite(req, res, fn) {
  const { client, confirm } = graphFor(req);
  try {
    const result = await fn(client);
    res.json({ executed: confirm, dryRun: !confirm, result });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.body ?? e.message, dryRun: !confirm });
  }
}

const W = [requireAuth, requireWrite, limit(writeBudget, "Zu viele Schreib-Aktionen — kurz warten.")];

// --- Ordner / Struktur ---
app.post("/api/write/folder", ...W, (req, res) =>
  runWrite(req, res, (g) => g.createFolder(req.body.driveId, req.body.parentItemId, req.body.name)));
app.patch("/api/write/rename", ...W, (req, res) =>
  runWrite(req, res, (g) => g.renameItem(req.body.driveId, req.body.itemId, req.body.newName)));
app.patch("/api/write/move", ...W, (req, res) =>
  runWrite(req, res, (g) => g.moveItem(req.body.driveId, req.body.itemId, req.body.newParentItemId)));

// --- Löschen (destruktiv -> Papierkorb) ---
app.delete("/api/write/item", ...W, (req, res) =>
  runWrite(req, res, (g) =>
    g.deleteItem(req.body.driveId ?? req.query.driveId, req.body.itemId ?? req.query.itemId)));

// --- SharePoint-Metadaten / Status-Spalten ---
app.patch("/api/write/fields", ...W, (req, res) =>
  runWrite(req, res, (g) =>
    req.body.listId
      ? g.updateListItemFields(req.body.siteId, req.body.listId, req.body.itemId, req.body.fields)
      : g.setDriveItemFields(req.body.driveId, req.body.itemId, req.body.fields)));

// --- Dateien (raw Body, Simple Upload bis 4 MB; Params via Query) ---
app.put("/api/write/upload", ...W, express.raw({ type: "*/*", limit: "4mb" }), (req, res) =>
  runWrite(req, res, (g) =>
    g.uploadFile(req.query.driveId, req.query.parentItemId, req.query.name, req.body, req.query.contentType)));
app.put("/api/write/replace", ...W, express.raw({ type: "*/*", limit: "4mb" }), (req, res) =>
  runWrite(req, res, (g) =>
    g.replaceFile(req.query.driveId, req.query.itemId, req.body, req.query.contentType)));

// --- Outlook: Mail senden (Nachhaken) ---
app.post("/api/write/mail", ...W, (req, res) =>
  runWrite(req, res, (g) => {
    const message = {
      subject: req.body.subject,
      body: { contentType: req.body.html ? "HTML" : "Text", content: req.body.body },
      toRecipients: (req.body.to ?? []).map((address) => ({ emailAddress: { address } })),
    };
    return g.sendMail(req.body.from, message, req.body.saveToSentItems !== false);
  }));

// --- Audit-Log lesen (Transparenz: was hat das Tool geschrieben?) ---
app.get("/api/write/audit", requireAuth, async (req, res) => {
  try { res.json({ entries: await loadWriteAudit(req.query.limit) }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

app.listen(PORT, () =>
  console.log(`nereo OS app listening on :${PORT} (auth=${AUTH_CONFIGURED}, write=${GRAPH_WRITE_ENABLED})`));
