// nereo OS — Landing (Domain-Root). Bewusst minimal: Markenname + Einstieg.
// KEINE eigene Auth mehr: Login/Session/Dashboard leben ausschließlich in der App
// (app.nereo-os.de). "Anmelden" verlinkt nur dorthin; die App gated sich selbst (OIDC).
// Domain steckt nur in ENV (APP_URL) — beim Domain-Wechsel nichts am Code ändern.
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const {
  APP_URL = "https://app.nereo-os.de", // wohin "Anmelden" führt
  PORT = 3000,
} = process.env;

const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const page = (inner) => `<!doctype html><html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nereo OS</title>
<link rel="icon" href="/nereo_n_black.svg" type="image/svg+xml">
<style>
  @font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('/inter.woff2') format('woff2')}
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;
    font:13px/1.5 'Inter','Helvetica Neue',Arial,sans-serif;letter-spacing:-.005em;
    background:#f7f7f7;color:#111}
  .card{width:min(92vw,400px);padding:40px 36px;border:1px solid #dedede;border-radius:5px;
    background:#fff;text-align:center;box-shadow:0 8px 26px rgba(0,0,0,.055)}
  .brand{display:flex;flex-direction:row;align-items:baseline;justify-content:center;gap:10px;margin:0 0 6px}
  .brand-logo{height:28px;width:auto;max-width:55%;display:block}
  .brand-os{color:#666;font-size:48px;font-weight:300;line-height:1;text-transform:uppercase;letter-spacing:.01em}
  .muted{color:#666;margin:14px 0 24px;font-size:14px}
  .btn{display:block;width:100%;padding:13px 16px;border-radius:5px;border:1px solid #000;cursor:pointer;
    background:#000;color:#fff;font-weight:600;text-decoration:none;font-size:14px}
  .btn:hover{text-decoration:underline;text-decoration-color:#06eddb;text-underline-offset:3px}
</style></head><body><div class="card">
<p class="brand"><img class="brand-logo" src="/logo_black.svg" alt="nereo"><span class="brand-os">OS</span></p>${inner}</div></body></html>`;

const app = express();
app.set("trust proxy", 1); // hinter Traefik (TLS terminiert dort)

app.get("/healthz", (_req, res) =>
  res.json({ service: "nereo-os-landing", status: "ok" }));

// LogTo-Sign-in bezieht /logo.svg. Login bleibt (Bauregel §1) UNVERÄNDERT → alte Wortmarke.
app.get("/logo.svg", (_req, res) => {
  res.set("content-type", "image/svg+xml; charset=utf-8");
  res.set("cache-control", "public, max-age=3600");
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="184" height="44" viewBox="0 0 184 44">` +
    `<text x="2" y="32" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="30" font-weight="700" letter-spacing="-0.02em" fill="#e7e9ee">nereo` +
    `<tspan fill="#06eddb">·</tspan>OS</text></svg>`);
});

// Landing-/Design-Assets (heller Grund): schwarzes Logo, Tab-Symbol, Inter (self-hosted, kein Google).
app.get("/logo_black.svg", (_req, res) => {
  res.set("content-type", "image/svg+xml; charset=utf-8");
  res.set("cache-control", "public, max-age=3600");
  res.send(readFileSync(resolve(__dir, "logo_black.svg"), "utf8"));
});
app.get("/nereo_n_black.svg", (_req, res) => {
  res.set("content-type", "image/svg+xml; charset=utf-8");
  res.set("cache-control", "public, max-age=3600");
  res.send(readFileSync(resolve(__dir, "nereo_n_black.svg"), "utf8"));
});
app.get("/inter.woff2", (_req, res) => {
  res.set("content-type", "font/woff2");
  res.set("cache-control", "public, max-age=31536000, immutable");
  res.send(readFileSync(resolve(__dir, "inter.woff2")));
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
