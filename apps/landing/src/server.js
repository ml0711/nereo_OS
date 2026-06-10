// nereo OS — Landing. Einziger Zweck: Login via LogTo (OIDC).
// Authorization-Code-Flow mit PKCE. Confidential Client ("Traditional Web").
// Domain steckt nur in ENV (LANDING_BASE_URL) — beim Domain-Wechsel nichts am Code aendern.
import express from "express";
import cookieSession from "cookie-session";
import crypto from "node:crypto";

const {
  LOGTO_ENDPOINT,                       // z.B. https://auth.nereo-os.de
  LOGTO_APP_ID,
  LOGTO_APP_SECRET,
  LANDING_BASE_URL,                     // oeffentliche URL dieser landing (random sslip.io o. spaeter Root)
  APP_URL = "https://app.nereo-os.de",  // wohin nach Login
  SESSION_SECRET = crypto.randomBytes(16).toString("hex"),
  PORT = 3000,
} = process.env;

const ISSUER = LOGTO_ENDPOINT ? `${LOGTO_ENDPOINT.replace(/\/$/, "")}/oidc` : null;
const REDIRECT_URI = LANDING_BASE_URL ? `${LANDING_BASE_URL.replace(/\/$/, "")}/callback` : null;
const CONFIGURED = Boolean(LOGTO_ENDPOINT && LOGTO_APP_ID && LOGTO_APP_SECRET && LANDING_BASE_URL);

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const page = (inner) => `<!doctype html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nereo OS</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
    font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0b0d10;color:#e7e9ee}
  .card{width:min(92vw,400px);padding:40px 36px;border:1px solid #1d2127;border-radius:16px;
    background:#0f1216;text-align:center}
  .brand{font-weight:700;letter-spacing:-.02em;font-size:30px;margin:0 0 4px}
  .brand span{color:#5b8cff}
  .muted{color:#8a93a3;margin:0 0 26px;font-size:14px}
  h2{margin:.2em 0 1em;font-size:19px;word-break:break-all}
  .btn{display:block;width:100%;padding:13px 16px;border-radius:10px;border:0;cursor:pointer;
    background:#2f6bff;color:#fff;font-weight:600;text-decoration:none;font-size:15px}
  .btn:hover{background:#225aff}
  .link{display:inline-block;margin-top:16px;color:#8a93a3;font-size:13px;text-decoration:none}
  .link:hover{color:#e7e9ee}
  .warn{margin-top:18px;color:#e0a23c;font-size:12.5px}
</style></head><body><div class="card">
<p class="brand">nereo<span>·</span>OS</p>${inner}</div></body></html>`;

const app = express();
app.set("trust proxy", 1); // hinter Traefik (TLS terminiert dort)
app.use(cookieSession({
  name: "nereo", keys: [SESSION_SECRET], maxAge: 7 * 24 * 3600 * 1000,
  sameSite: "lax", secure: true, httpOnly: true,
}));

app.get("/healthz", (_req, res) =>
  res.json({ service: "nereo-os-landing", status: "ok", configured: CONFIGURED }));

app.get("/login", (req, res) => {
  if (!CONFIGURED) return res.status(503).send(page(
    `<p class="muted">Login</p><p class="warn">LogTo-Anbindung noch nicht konfiguriert (LOGTO_APP_ID/SECRET fehlen).</p>`));
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
    if (error) return res.status(400).send(page(`<p class="warn">${esc(error)}: ${esc(error_description)}</p><a class="link" href="/">Zurück</a>`));
    if (!code || !state || state !== req.session.state)
      return res.status(400).send(page(`<p class="warn">Ungültiger State.</p><a class="link" href="/">Zurück</a>`));
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
    if (!r.ok) return res.status(502).send(page(`<p class="warn">Token-Austausch fehlgeschlagen.</p><a class="link" href="/">Zurück</a>`));
    const tok = await r.json();
    // id_token kommt direkt ueber TLS vom Token-Endpoint -> Payload vertrauenswuerdig.
    const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
    req.session.user = { sub: claims.sub, email: claims.email, name: claims.name };
    req.session.pkce = undefined;
    req.session.state = undefined;
    res.redirect("/");
  } catch (e) {
    res.status(500).send(page(`<p class="warn">Login-Fehler.</p><a class="link" href="/">Zurück</a>`));
  }
});

app.get("/logout", (req, res) => {
  req.session = null;
  if (!CONFIGURED) return res.redirect("/");
  const u = new URL(`${ISSUER}/session/end`);
  u.searchParams.set("client_id", LOGTO_APP_ID);
  u.searchParams.set("post_logout_redirect_uri", LANDING_BASE_URL);
  res.redirect(u.toString());
});

app.get("/", (req, res) => {
  res.set("content-type", "text/html; charset=utf-8");
  const user = req.session?.user;
  if (user) {
    return res.send(page(
      `<p class="muted">Eingeloggt als</p><h2>${esc(user.email || user.name || user.sub)}</h2>
       <a class="btn" href="${esc(APP_URL)}">Zur App →</a>
       <a class="link" href="/logout">Abmelden</a>`));
  }
  res.send(page(
    `<p class="muted">Zugang nur für berechtigte Nutzer</p>
     <a class="btn" href="/login">Anmelden</a>${CONFIGURED ? "" : `<p class="warn">Hinweis: LogTo-Client noch nicht hinterlegt.</p>`}`));
});

app.listen(PORT, () => console.log(`nereo OS landing on :${PORT} (configured=${CONFIGURED})`));
