// nereo OS — Landing (Domain-Root). Bewusst minimal: Markenname + Einstieg.
// KEINE eigene Auth mehr: Login/Session/Dashboard leben ausschließlich in der App
// (app.nereo-os.de). "Anmelden" verlinkt nur dorthin; die App gated sich selbst (OIDC).
// Domain steckt nur in ENV (APP_URL) — beim Domain-Wechsel nichts am Code ändern.
import express from "express";

const {
  APP_URL = "https://app.nereo-os.de", // wohin "Anmelden" führt
  PORT = 3000,
} = process.env;

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
  .btn{display:block;width:100%;padding:13px 16px;border-radius:10px;border:0;cursor:pointer;
    background:#2f6bff;color:#fff;font-weight:600;text-decoration:none;font-size:15px}
  .btn:hover{background:#225aff}
</style></head><body><div class="card">
<p class="brand">nereo<span>·</span>OS</p>${inner}</div></body></html>`;

const app = express();
app.set("trust proxy", 1); // hinter Traefik (TLS terminiert dort)

app.get("/healthz", (_req, res) =>
  res.json({ service: "nereo-os-landing", status: "ok" }));

// nereo-Wortmarke als SVG (u.a. fürs LogTo-Sign-in-Logo).
app.get("/logo.svg", (_req, res) => {
  res.set("content-type", "image/svg+xml; charset=utf-8");
  res.set("cache-control", "public, max-age=3600");
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="184" height="44" viewBox="0 0 184 44">` +
    `<text x="2" y="32" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="30" font-weight="700" letter-spacing="-0.02em" fill="#e7e9ee">nereo` +
    `<tspan fill="#5b8cff">·</tspan>OS</text></svg>`);
});

// Schlanker Einstieg: "Anmelden" führt direkt in die App, die sich selbst gated
// und nach dem Login im Dashboard landet.
app.get("/", (_req, res) => {
  res.set("content-type", "text/html; charset=utf-8");
  res.send(page(
    `<p class="muted">Intelligenz- und Bedienschicht über euren Projektdaten</p>
     <a class="btn" href="${esc(APP_URL)}">Anmelden</a>
     <p class="muted" style="margin-top:18px;font-size:12.5px">Zugang nur für berechtigte Nutzer</p>`));
});

app.listen(PORT, () => console.log(`nereo OS landing on :${PORT}`));
