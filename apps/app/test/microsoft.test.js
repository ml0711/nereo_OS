// Testet den Microsoft-Zugang je Person mit ERFUNDENEN Daten (kein echtes Microsoft, keine DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { msConfigFromEnv, encrypt, decrypt, accountMatches, createMicrosoftAccess } from "../src/microsoft.js";
import { createGraphClient } from "../../../packages/graph-client/src/index.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const KEY = crypto.randomBytes(32);
const cfg = { clientId: "app", clientSecret: "geheim", tenantId: TENANT, key: KEY, redirectUri: "https://app.example/microsoft/callback" };
const idToken = (c) => "x." + Buffer.from(JSON.stringify(c)).toString("base64url") + ".y";
const memStore = () => { const m = new Map(); return { m, save: async (s, v) => m.set(s, v), load: async (s) => m.get(s) ?? null, remove: async (s) => m.delete(s) }; };
const fakeFetch = (responder) => { const calls = []; const f = async (url, init) => { const p = Object.fromEntries(new URLSearchParams(init.body)); calls.push(p); const [status, body] = responder(p, calls.length); return { ok: status < 400, status, json: async () => body }; }; f.calls = calls; return f; };

test("Einstellung: ohne Schlüssel oder IDs nie „bereit“", () => {
  const ok = { DELEGATED_ACCESS: "1", MS_LOGIN_CLIENT_ID: "a", MS_LOGIN_CLIENT_SECRET: "b", MS_LOGIN_TENANT_ID: TENANT, MS_TOKEN_KEY: KEY.toString("base64") };
  assert.equal(msConfigFromEnv(ok).ready, true);
  assert.equal(msConfigFromEnv({ ...ok, MS_TOKEN_KEY: "" }).ready, false);
  assert.equal(msConfigFromEnv({ ...ok, MS_TOKEN_KEY: crypto.randomBytes(16).toString("base64") }).ready, false);
  assert.equal(msConfigFromEnv({ ...ok, MS_LOGIN_TENANT_ID: "common" }).ready, false);
  assert.equal(msConfigFromEnv({ ...ok, DELEGATED_ACCESS: "0" }).ready, false);
});

test("Verschlüsselung: Rundweg klappt, Manipulation und falscher Schlüssel scheitern", () => {
  const p = encrypt(KEY, "refresh-123");
  assert.notEqual(p.includes("refresh-123"), true);
  assert.equal(decrypt(KEY, p), "refresh-123");
  assert.throws(() => decrypt(crypto.randomBytes(32), p));
  const parts = p.split("."); parts[3] = Buffer.from("anders").toString("base64");
  assert.throws(() => decrypt(KEY, parts.join(".")));
});

test("Konto-Prüfung: nur gleicher Tenant und gleiche E-Mail", () => {
  assert.equal(accountMatches({ tid: TENANT, preferred_username: "Anna@Example.ch" }, { tenantId: TENANT, email: "anna@example.ch" }), true);
  assert.equal(accountMatches({ tid: "99999999-2222-3333-4444-555555555555", preferred_username: "anna@example.ch" }, { tenantId: TENANT, email: "anna@example.ch" }), false);
  assert.equal(accountMatches({ tid: TENANT, preferred_username: "ben@example.ch" }, { tenantId: TENANT, email: "anna@example.ch" }), false);
  assert.equal(accountMatches({ tid: TENANT, preferred_username: "anna@example.ch" }, { tenantId: TENANT, email: "" }), false);
});

test("Verbinden: passendes Konto wird verschlüsselt gespeichert, fremdes nicht", async () => {
  const store = memStore();
  const f = fakeFetch(() => [200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600, id_token: idToken({ tid: TENANT, preferred_username: "anna@example.ch", oid: "o1" }) }]);
  const ms = createMicrosoftAccess({ cfg, store, fetchImpl: f });
  const session = { user: { sub: "sA", email: "anna@example.ch" } };
  const url = new URL(ms.authorizeUrl(session, "/datenraeume"));
  assert.equal(url.searchParams.get("client_id"), "app");
  assert.match(url.searchParams.get("scope"), /Files\.Read\.All/);
  assert.doesNotMatch(url.searchParams.get("scope"), /Write/i, "nur Leserechte");
  const r = await ms.finish(session, { code: "c", state: url.searchParams.get("state") });
  assert.deepEqual(r, { ok: true, next: "/datenraeume" });
  assert.equal(store.m.get("sA").oid, "o1");
  assert.equal(store.m.get("sA").enc.includes("RT1"), false, "nie im Klartext gespeichert");
  assert.equal(f.calls[0].code_verifier.length > 40, true, "PKCE");

  const store2 = memStore();
  const f2 = fakeFetch(() => [200, { access_token: "AT", refresh_token: "RT", id_token: idToken({ tid: TENANT, preferred_username: "ben@example.ch" }) }]);
  const ms2 = createMicrosoftAccess({ cfg, store: store2, fetchImpl: f2 });
  const s2 = { user: { sub: "sA", email: "anna@example.ch" } };
  const st = new URL(ms2.authorizeUrl(s2)).searchParams.get("state");
  assert.deepEqual(await ms2.finish(s2, { code: "c", state: st }), { ok: false, reason: "konto" });
  assert.equal(store2.m.size, 0);
  const s3 = { user: { sub: "sA", email: "anna@example.ch" } };
  ms2.authorizeUrl(s3);
  assert.deepEqual(await ms2.finish(s3, { code: "c", state: "falsch" }), { ok: false, reason: "state" });
});

test("Weiterleitung nach dem Verbinden nur innerhalb der App", () => {
  const ms = createMicrosoftAccess({ cfg, store: memStore(), fetchImpl: async () => ({}) });
  for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
    const s = { user: { sub: "x", email: "x@example.ch" } }; ms.authorizeUrl(s, bad); assert.equal(s.ms.next, "/");
  }
});

test("Zugang erneuern: neuer Schlüssel wird gespeichert, abgelaufener gelöscht", async () => {
  const store = memStore();
  await store.save("sA", { oid: "o1", enc: encrypt(KEY, "RT-alt") });
  let t = 0;
  const f = fakeFetch((p) => p.refresh_token === "RT-alt" ? [200, { access_token: "AT-neu", refresh_token: "RT-neu", expires_in: 3600 }] : [400, { error: "invalid_grant" }]);
  const ms = createMicrosoftAccess({ cfg, store, fetchImpl: f, now: () => t });
  assert.equal(await ms.accessToken("sA"), "AT-neu");
  assert.equal(decrypt(KEY, store.m.get("sA").enc), "RT-neu");
  assert.equal(await ms.accessToken("sA"), "AT-neu"); assert.equal(f.calls.length, 1, "aus dem Zwischenspeicher");
  t = 4 * 3600 * 1000;
  assert.equal(await ms.accessToken("sA"), null, "RT-neu wird abgelehnt → neu verbinden");
  assert.equal(store.m.has("sA"), false);
  assert.equal(await ms.accessToken("niemand"), null);
  await store.save("sB", { enc: encrypt(KEY, "x") }); await ms.forget("sB"); assert.equal(store.m.has("sB"), false);
});

test("Graph-Client je Person: kein Rückfall auf den App-Zugang, Schreiben gesperrt", async () => {
  let asked = 0;
  const c = createGraphClient({}, { tokenProvider: async () => { asked++; return null; } });
  await assert.rejects(c.get("/drives/x/root"), (e) => e.status === 401 && e.reconnect === true);
  assert.equal(asked, 1);
  await assert.rejects(c.mutate("DELETE", "/drives/x/items/y"), (e) => e.status === 403);
});
