// Testet den Such-Index (search.js) mit ERFUNDENEN Daten (kein Microsoft, Bauregel §6):
//  - Ausschluss gilt auch hier: nichts aus 90_Personal… — auch nicht bei Suche „Personal"/„Gehalt".
//  - Prüfliste: „Teltow" findet das Teltow-Projekt · Filter A08 quer über mehrere Projekte ·
//    „Foerdermittel" findet „Fördermittel" (Umlaut tolerant) · „Muster erkannt: nein" zeigt Altbestand.
// Der Index entsteht ausschließlich über das zentrale Tor (client.walkDrive) → was dort gefiltert
// wird, kann die Suche nicht ausliefern (derselbe Ausschluss wie beim Explorer).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphClient } from "../src/index.js";
import { pickCompanies } from "../src/workspace.js";
import { buildSearchIndex, queryIndex, computeFacets } from "../src/search.js";

// --- Erfundener Ordnerbaum (Graph-Item-Form) ---
const F = (id, name) => ({ id, name, folder: {}, webUrl: "https://x/" + id, lastModifiedDateTime: "2026-01-01T00:00:00Z" });
const D = (id, name) => ({ id, name, file: {}, size: 10, webUrl: "https://x/" + id, lastModifiedDateTime: "2026-01-01T00:00:00Z" });

const NODES = {
  root: [F("group", "nereo.Group"), F("dev", "nereo.development"), F("alt", "Projekte_alt"), F("prs", "90_Personal_VERTRAULICH"), D("ds", ".DS_Store")],
  // nereo.Group → Projekt Teltow mit A08
  group: [F("g_pr", "04_Projekte")],
  g_pr: [F("teltow", "2026-050_TLT_Teltow")],
  teltow: [F("t_an", "02_Analysen")],
  t_an: [F("t_a08", "A08_Nutzung_Varianten")],
  t_a08: [D("tf1", "2026-09-01_2026-050_Analyse_A08_Varianten_v01.pdf"), D("tf2", "Alte Übersicht Fördermittel.xlsx")],
  // nereo.development → ausgeschlossener Personal-Ordner + Projekt Ehningen mit A08 + A01
  dev: [F("d_prs", "90_Personal_VERTRAULICH"), F("d_pr", "04_Projekte")],
  d_prs: [D("geh", "2026-01-01_Gehalt_Mueller_v01.pdf")], // darf NIE auftauchen
  d_pr: [F("ehn", "2026-014_QG20_Ehningen")],
  ehn: [F("e_an", "02_Analysen")],
  e_an: [F("e_a08", "A08_Nutzung_Varianten"), F("e_a01", "A01_Standortanalyse")],
  e_a08: [D("ef1", "2026-08-15_2026-014_Analyse_A08_Varianten_v01.pdf")],
  e_a01: [D("ef2", "2026-07-01_2026-014_Analyse_A01_Standort_v01.pdf")],
  // Inhalte ausgeschlossener/nicht erlaubter Ordner — dürfen NIE erreicht werden:
  prs: [D("s1", "Geheim.pdf")],
  alt: [F("alt_pr", "2000-001_ALT_Irgendwo")],
};

const mkRes = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("login.microsoftonline.com")) return mkRes({ access_token: "tok", expires_in: 3600 });
  const m = u.match(/\/drives\/[^/]+\/(?:items\/([^/?]+)|root)\/children/);
  if (m) return mkRes({ value: NODES[m[1] || "root"] || [] });
  return mkRes({ value: [] });
};

const client = createGraphClient({ tenantId: "t", clientId: "c", clientSecret: "s" });
const DRIVE = "drive1";
const DOCTYPES = new Map([["analyse", "Analyse"]]);

async function buildIndex() {
  const rootKids = await client.listChildren(DRIVE, null); // zentrales Tor filtert 90_Personal…/.DS_Store
  const companies = pickCompanies(rootKids);               // Erlaubnisliste: nereo.Group/.development (Projekte_alt fällt weg)
  return buildSearchIndex(client, { driveId: DRIVE, companies, docTypes: DOCTYPES, maxDepth: 10 });
}

test("Index: nur erlaubte Gesellschaften, nichts Ausgeschlossenes", async () => {
  const rows = await buildIndex();
  assert.ok(rows.length > 0, "Index nicht leer");
  for (const r of rows) {
    assert.ok(!/90[_ ]?personal/i.test(r.path), `Personal-Pfad durchgerutscht: ${r.path}`);
    assert.ok(!/gehalt/i.test(r.name), `Gehalts-Datei durchgerutscht: ${r.name}`);
    assert.ok(r.company === "nereo.Group" || r.company === "nereo.development", `fremde Gesellschaft: ${r.company}`);
    assert.ok(!/projekte_alt/i.test(r.path), `Projekte_alt durchgerutscht: ${r.path}`);
  }
});

test("Suche Personal / Gehalt -> keine Treffer (Bauregel §3)", async () => {
  const rows = await buildIndex();
  assert.equal(queryIndex(rows, { q: "Personal" }).total, 0);
  assert.equal(queryIndex(rows, { q: "Gehalt" }).total, 0);
});

test("Prüfliste: Teltow findet Dateien aus dem Projekt Teltow", async () => {
  const rows = await buildIndex();
  const res = queryIndex(rows, { q: "Teltow" });
  assert.ok(res.total >= 1, "Teltow findet nichts");
  for (const r of res.rows) assert.ok(/teltow/i.test(r.path), `Treffer ohne Teltow-Bezug: ${r.path}`);
});

test("Prüfliste: Filter A08 zeigt Analysen aus mehreren Projekten", async () => {
  const rows = await buildIndex();
  const res = queryIndex(rows, { a: "A08" });
  const projekte = new Set(res.rows.map((r) => r.projektId));
  assert.ok(projekte.has("2026-050") && projekte.has("2026-014"), `A08 nicht projektübergreifend: ${[...projekte]}`);
});

test("Prüfliste: Foerdermittel findet Fördermittel (Umlaut tolerant)", async () => {
  const rows = await buildIndex();
  const res = queryIndex(rows, { q: "Foerdermittel" });
  assert.ok(res.total >= 1 && res.rows.some((r) => /Fördermittel/.test(r.name)), "Umlaut-Toleranz fehlt");
});

test("Prüfliste: Muster erkannt nein zeigt Altbestand, nicht die sauberen Namen", async () => {
  const rows = await buildIndex();
  const nein = queryIndex(rows, { pattern: "nein" });
  assert.ok(nein.rows.some((r) => /Fördermittel/.test(r.name)), "Altbestand fehlt bei nein");
  assert.ok(!nein.rows.some((r) => r.patternOk), "ein sauberer Name als nein markiert");
  const ja = queryIndex(rows, { pattern: "ja" });
  assert.ok(ja.rows.every((r) => r.patternOk), "unsauberer Name als ja markiert");
});

test("computeFacets: Filter-Optionen + Dashboard-Zahl", async () => {
  const rows = await buildIndex();
  const f = computeFacets(rows, [{ code: "A08", name: "Nutzung/Varianten" }]);
  assert.deepEqual(f.companies, ["nereo.Group", "nereo.development"].sort((a, b) => a.localeCompare(b, "de")));
  assert.ok(f.aCodes.some((a) => a.code === "A08" && a.name === "Nutzung/Varianten"));
  assert.ok(f.docTypes.includes("Analyse"));
  assert.ok(f.projekte.some((p) => p.id === "2026-050") && f.projekte.some((p) => p.id === "2026-014"));
  assert.ok(f.patternNo >= 1, "Dashboard-Zahl (nicht nach Konvention) fehlt");
});
