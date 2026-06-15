// nereo OS — App-Service (Dashboard + JSON-API).
// Gated per OIDC (LogTo): die App ist ihr eigener OIDC-Client + hält die Session.
// Login -> direkt ins Dashboard; Logout im Dashboard. Read-only Graph-Index aus App-Postgres.
// Siehe ../../CLAUDE.md §2/§3.

import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractDataRooms, summarizeDataRooms } from "../../../packages/graph-client/src/datarooms.js";
import { loadLatestIndex, loadAnalyses } from "../../../packages/graph-client/src/index-store.js";

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

const ISSUER = LOGTO_ENDPOINT ? `${LOGTO_ENDPOINT.replace(/\/$/, "")}/oidc` : null;
const REDIRECT_URI = `${APP_BASE_URL.replace(/\/$/, "")}/callback`;
const AUTH_CONFIGURED = Boolean(LOGTO_ENDPOINT && LOGTO_APP_ID && LOGTO_APP_SECRET);

const app = express();
app.set("trust proxy", 1); // hinter Traefik (TLS terminiert dort)
app.use(cookieSession({
  name: "nereo_app", keys: [SESSION_SECRET], maxAge: 7 * 24 * 3600 * 1000,
  sameSite: "lax", secure: true, httpOnly: true,
}));

const b64url = (buf) => Buffer.from(buf).toString("base64url");

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
    req.session.pkce = undefined;
    req.session.state = undefined;
    res.redirect("/");
  } catch (e) {
    res.status(500).send('Login-Fehler. <a href="/login">neu</a>');
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  if (!AUTH_CONFIGURED) return res.redirect("/");
  const u = new URL(`${ISSUER}/session/end`);
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
app.get("/healthz", (_req, res) => res.json({ service: "nereo-os-app", status: "ok" }));

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

// KI-Analyse triggern: Secret (curl/cron) ODER eingeloggt (Dashboard-Button). Idempotent.
async function analyzeHandler(req, res) {
  const ok = (ANALYZE_TRIGGER_SECRET && req.query.key === ANALYZE_TRIGGER_SECRET) || (req.session && req.session.user);
  if (!ok) return res.status(403).json({ error: "forbidden" });
  const { analyzeMissing } = await import("./analyze.js");
  res.json(await analyzeMissing({ force: req.query.force === "1" }));
}
app.get("/api/datarooms/analyze", analyzeHandler);
app.post("/api/datarooms/analyze", analyzeHandler);

app.listen(PORT, () => console.log(`nereo OS app listening on :${PORT} (auth=${AUTH_CONFIGURED})`));
