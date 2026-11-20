// Microsoft-Zugang JE PERSON (delegiert): nereo OS liest SharePoint im Namen der angemeldeten Person,
// damit jede Person nur sieht, was sie auch in SharePoint sehen darf.
// Ablauf: normaler Login über LogTo → danach holt die App über die Login-App (Azure, MS_LOGIN_*) einen
// Microsoft-Zugang mit NUR Leserechten. Der Erneuerungs-Schlüssel (refresh token) liegt AES-256-GCM-
// verschlüsselt in der App-Postgres (Tabelle ms_delegated_token), der Schlüssel dazu nur in Coolify (MS_TOKEN_KEY).
// Sicherheitsregeln:
//  · Das Microsoft-Konto muss zum Tenant UND zur angemeldeten E-Mail passen, sonst wird nichts gespeichert.
//  · Fehlt der Zugang oder ist etwas falsch eingestellt: NICHTS anzeigen (kein Rückfall auf den App-Zugang).
//  · Beim Abmelden wird der gespeicherte Zugang gelöscht.
import crypto from "node:crypto";

export const MS_SCOPES = "openid profile email offline_access User.Read Files.Read.All Sites.Read.All";

export function msConfigFromEnv(env = process.env) {
  const enabled = env.DELEGATED_ACCESS === "1";
  const key = env.MS_TOKEN_KEY ? Buffer.from(env.MS_TOKEN_KEY, "base64") : null;
  const cfg = {
    enabled,
    clientId: env.MS_LOGIN_CLIENT_ID || "",
    clientSecret: env.MS_LOGIN_CLIENT_SECRET || "",
    tenantId: env.MS_LOGIN_TENANT_ID || "",
    key,
    redirectUri: `${String(env.APP_BASE_URL || "https://app.nereo-os.de").replace(/\/$/, "")}/microsoft/callback`,
  };
  const problems = [];
  if (!cfg.clientId) problems.push("MS_LOGIN_CLIENT_ID fehlt");
  if (!cfg.clientSecret) problems.push("MS_LOGIN_CLIENT_SECRET fehlt");
  if (!/^[0-9a-f-]{36}$/i.test(cfg.tenantId)) problems.push("MS_LOGIN_TENANT_ID fehlt/ungültig");
  if (!key || key.length !== 32) problems.push("MS_TOKEN_KEY fehlt (32 Byte, base64)");
  cfg.problems = problems;
  cfg.ready = enabled && problems.length === 0;
  return cfg;
}

// ---- Verschlüsselung (AES-256-GCM, zufälliger IV je Eintrag) ----
export function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
export function decrypt(key, packed) {
  const [v, iv, tag, enc] = String(packed).split(".");
  if (v !== "v1") throw new Error("Unbekanntes Format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

const b64url = (b) => Buffer.from(b).toString("base64url");
const claimsOf = (idToken) => JSON.parse(Buffer.from(String(idToken).split(".")[1] || "", "base64url").toString() || "{}");

/** Passt das Microsoft-Konto zur Anmeldung? Tenant exakt, E-Mail exakt (ohne Groß-/Kleinschreibung). */
export function accountMatches(claims, { tenantId, email }) {
  if (!claims || String(claims.tid || "").toLowerCase() !== String(tenantId).toLowerCase()) return false;
  const want = String(email || "").trim().toLowerCase();
  if (!want) return false;
  return [claims.email, claims.preferred_username, claims.upn].some((x) => String(x || "").trim().toLowerCase() === want);
}

/**
 * store: { save(sub, {oid, enc}), load(sub) -> {enc}|null, remove(sub) }
 * fetchImpl: für Tests austauschbar.
 */
export function createMicrosoftAccess({ cfg, store, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map(); // sub -> { token, exp }
  const authority = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0`;

  async function tokenRequest(params) {
    const r = await fetchImpl(`${authority}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: MS_SCOPES, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = j.error; throw e; }
    return j;
  }
  function remember(sub, j) {
    cache.set(sub, { token: j.access_token, exp: now() + ((j.expires_in ?? 3600) - 120) * 1000 });
    if (cache.size > 2000) cache.clear();
  }

  return {
    /** Start: Weiterleitung zu Microsoft. Merkt state + PKCE in der Session. */
    authorizeUrl(session, next = "/") {
      const verifier = b64url(crypto.randomBytes(32));
      const state = b64url(crypto.randomBytes(16));
      session.ms = { state, verifier, next: /^\/(?!\/)/.test(next) ? next : "/" };
      const u = new URL(`${authority}/authorize`);
      for (const [k, v] of Object.entries({
        client_id: cfg.clientId, response_type: "code", redirect_uri: cfg.redirectUri, response_mode: "query",
        scope: MS_SCOPES, state, code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256", login_hint: session.user?.email || "",
      })) if (v) u.searchParams.set(k, v);
      return u.toString();
    },

    /** Rückkehr von Microsoft: prüfen, speichern. Gibt { ok, next } oder { ok:false, reason } zurück. */
    async finish(session, { code, state, error }) {
      const pending = session.ms; session.ms = undefined;
      if (error) return { ok: false, reason: "microsoft" };
      if (!pending || !code || state !== pending.state) return { ok: false, reason: "state" };
      const j = await tokenRequest({ grant_type: "authorization_code", code: String(code), redirect_uri: cfg.redirectUri, code_verifier: pending.verifier });
      const claims = claimsOf(j.id_token);
      if (!accountMatches(claims, { tenantId: cfg.tenantId, email: session.user?.email })) return { ok: false, reason: "konto" };
      if (!j.refresh_token) return { ok: false, reason: "kein-refresh" };
      const sub = session.user.sub;
      await store.save(sub, { oid: claims.oid || null, enc: encrypt(cfg.key, j.refresh_token) });
      remember(sub, j);
      return { ok: true, next: pending.next || "/" };
    },

    /** Gültiger Microsoft-Zugang der Person oder null (dann muss sie sich neu verbinden). */
    async accessToken(sub) {
      if (!sub) return null;
      const hit = cache.get(sub);
      if (hit && now() < hit.exp) return hit.token;
      const row = await store.load(sub);
      if (!row?.enc) return null;
      let refresh;
      try { refresh = decrypt(cfg.key, row.enc); } catch { await store.remove(sub); return null; }
      try {
        const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
        if (j.refresh_token) await store.save(sub, { oid: row.oid ?? null, enc: encrypt(cfg.key, j.refresh_token) });
        remember(sub, j);
        return j.access_token;
      } catch (e) {
        if (e.code === "invalid_grant" || e.code === "interaction_required") { await store.remove(sub); return null; }
        throw e;
      }
    },

    async forget(sub) { cache.delete(sub); if (sub) await store.remove(sub); },
  };
}
