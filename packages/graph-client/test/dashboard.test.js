// Start-Dashboard — Beweise mit ERFUNDENEN Daten (kein Microsoft, keine echten Personendaten, Bauregel §6).
// Kernaussage der Aufgabe: „die Zielliste zeigt genau so viele Einträge, wie die Kachel sagt." Daher wird
// hier bewiesen, dass die Kachelzahlen aus DENSELBEN Funktionen wie Projekte + Suche entstehen und mit
// ihren Listen übereinstimmen:
//  1. „Dateien zu prüfen": unsortedDocsFromIndex == Summe der unsortedCount der Projektübersicht;
//     ein _UNSORTIERT_Pruefen direkt unter 04_Projekte (kein echtes Projekt) zählt NICHT mit.
//  2. „Projekte mit unvollständigem Kern" == Anzahl Projekte in der Liste „Kernanalysen fehlen".
//  3. „Projekte ohne Änderung seit 30 Tagen": staleProjects (Projekt ohne Datei zählt nicht).
//  4. „Neu in den letzten 7 Tagen" / „Zuletzt geändert": recentlyModified/latestModified nach modified.
//   Ausführen:  npm test
// Hinweis: Test-Texte mit deutschen Anführungszeichen stehen bewusst in EINFACHEN Quotes ('…'),
// damit ein inneres " den String nicht beendet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnalysisCatalog, projectsOverview, unsortedDocsFromIndex, staleProjects } from "../src/projects.js";
import { recentlyModified, latestModified } from "../src/search.js";

// --- Erfundener Analysekatalog: A00 + A05 = Kern, A11 = kein Kern. ---
const CATALOG = parseAnalysisCatalog(`
## 2. Analysekatalog

| Kennung | Analyse | Kern | Bestand | Ordner |
|---|---|---|---|---|
| **A00** | Unternehmensprofil | ✓ | x | \`A00_Unternehmensprofil\` |
| **A05** | Markt und Wettbewerb | ✓ | x | \`A05_Markt\` |
| **A11** | Technik | | x | \`A11_Technik\` |
`);

const PP = "TestGmbH/04_Projekte";
const P1 = "2099-001_TEST_Teststadt";     // Kern komplett (A00+A05), 2x zu pruefen, juengst geaendert
const P2 = "2099-002_OTHER_Anderstadt";   // Kern unvollstaendig (A05 fehlt), 1x zu pruefen, alt (>30 Tage)
const P3 = "2099-003_THIRD_Drittstadt";   // Kern leer (A00+A05 fehlen), keine Datei

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const RECENT = iso(now - 1 * 864e5);      // vor 1 Tag
const RECENT2 = iso(now - 2 * 864e5);
const OLD = iso(now - 60 * 864e5);        // vor 60 Tagen

const row = (path, modified, docDate = null) => ({ name: path.split("/").pop(), path, modified, docDate, webUrl: "https://x/" + path, size: 10 });
const fol = (path) => ({ path, name: path.split("/").pop(), webUrl: "https://x/" + path });

const rows = [
  // P1 — Kern komplett + 2 zu pruefen
  row(`${PP}/${P1}/02_Analysen/A00_Unternehmensprofil/2099-01-01_A00_v01.pdf`, RECENT, "2099-01-01"),
  row(`${PP}/${P1}/02_Analysen/A05_Markt/2099-01-02_A05_v01.pdf`, RECENT2, "2099-01-02"),
  row(`${PP}/${P1}/02_Analysen/_UNSORTIERT_Pruefen/todo1.pdf`, RECENT),
  row(`${PP}/${P1}/02_Analysen/_UNSORTIERT_Pruefen/todo2.pdf`, OLD),
  // P2 — A05 fehlt + 1 zu pruefen, alles alt
  row(`${PP}/${P2}/02_Analysen/A00_Unternehmensprofil/2099-02-01_A00_v01.pdf`, OLD, "2099-02-01"),
  row(`${PP}/${P2}/02_Analysen/_UNSORTIERT_Pruefen/todo3.pdf`, OLD),
  // Falle: _UNSORTIERT_Pruefen DIREKT unter 04_Projekte (kein echtes Projekt) — darf NICHT zaehlen.
  row(`${PP}/_UNSORTIERT_Pruefen/orphan.pdf`, RECENT),
  // P3 — keine Datei (rows leer)
];
const folders = [
  fol(`${PP}/${P1}`), fol(`${PP}/${P1}/02_Analysen`),
  fol(`${PP}/${P2}`), fol(`${PP}/${P2}/02_Analysen`),
  fol(`${PP}/${P3}`), fol(`${PP}/${P3}/02_Analysen`),
];
const INDEX = { rows, folders };

test('„Dateien zu pruefen": Liste == Summe der unsortedCount; Waise unter 04_Projekte zaehlt nicht', () => {
  const overview = projectsOverview({ index: INDEX, projektePath: PP, catalog: CATALOG });
  const summe = overview.reduce((s, p) => s + (p.unsortedCount || 0), 0);
  const liste = unsortedDocsFromIndex({ index: INDEX, projektePath: PP });
  assert.equal(liste.length, 3, "P1(2) + P2(1) = 3");
  assert.equal(liste.length, summe, "Kachelzahl (Liste) == Summe der unsortedCount der Uebersicht");
  assert.ok(!liste.some((d) => d.name === "orphan.pdf"), "Waise (kein echtes Projekt) darf nicht auftauchen");
  assert.ok(liste.every((d) => d.projektId), "jede zu-pruefen-Datei hat eine Projekt-ID");
  // Neueste zuerst (Dokumentdatum, sonst geaendert).
  const keys = liste.map((d) => d.docDate || d.modified);
  assert.deepEqual(keys.slice().sort().reverse(), keys, "absteigend sortiert");
});

test('„Projekte mit unvollstaendigem Kern" == Anzahl Projekte in „Kernanalysen fehlen"', () => {
  const overview = projectsOverview({ index: INDEX, projektePath: PP, catalog: CATALOG });
  const kernIncomplete = overview.filter((p) => p.core.total && p.core.filled < p.core.total);
  const kernFehlen = overview.filter((p) => (p.coreMissing || []).length);
  assert.equal(kernIncomplete.length, 2, "P2 (A05 fehlt) + P3 (A00+A05 fehlen)");
  assert.equal(kernIncomplete.length, kernFehlen.length, "Kachelzahl == Laenge der Liste Kernanalysen-fehlen");
  const byName = Object.fromEntries(overview.map((p) => [p.name, p]));
  assert.deepEqual(byName[P2].coreMissing, ["A05"]);
  assert.deepEqual(byName[P3].coreMissing.slice().sort(), ["A00", "A05"]);
  assert.equal(byName[P1].coreMissing.length, 0);
});

test('„Projekte ohne Aenderung seit 30 Tagen": nur P2 (P1 juengst, P3 ohne Datei)', () => {
  const overview = projectsOverview({ index: INDEX, projektePath: PP, catalog: CATALOG });
  const stale = staleProjects(overview, { now, ms: 30 * 864e5 });
  assert.equal(stale.length, 1, "nur P2");
  assert.equal(stale[0].name, P2);
  const p3 = overview.find((p) => p.name === P3);
  assert.equal(p3.lastModified, null); // ohne Datei kein lastModified -> zaehlt nicht
});

test('„Neu in 7 Tagen" (recentlyModified): Zeitfenster, Sortierung, total vs. Limit', () => {
  const srows = [
    { name: "neu1.pdf", modified: iso(now - 3600e3), webUrl: "https://x/1", projektId: "2099-001" }, // vor 1 h
    { name: "neu2.pdf", modified: iso(now - 2 * 864e5), webUrl: "https://x/2" },                     // vor 2 Tagen
    { name: "alt.pdf", modified: OLD },                                                              // vor 60 Tagen
    { name: "kaputt.pdf", modified: null },                                                          // ohne Datum
  ];
  const r = recentlyModified(srows, { sinceMs: now - 7 * 864e5 });
  assert.equal(r.total, 2, "nur neu1 + neu2 im 7-Tage-Fenster");
  assert.deepEqual(r.rows.map((x) => x.name), ["neu1.pdf", "neu2.pdf"], "neueste zuerst");
  const r1 = recentlyModified(srows, { sinceMs: now - 7 * 864e5, limit: 1 });
  assert.equal(r1.total, 2); // Kachel zeigt die Gesamtzahl ...
  assert.equal(r1.rows.length, 1); // ... die Liste ist begrenzt
});

test('„Zuletzt geaendert" (latestModified): die N neuesten nach modified, absteigend', () => {
  const srows = [
    { name: "b.pdf", modified: iso(now - 5 * 864e5) },
    { name: "a.pdf", modified: iso(now - 1 * 864e5) },
    { name: "c.pdf", modified: iso(now - 9 * 864e5) },
  ];
  const top2 = latestModified(srows, 2);
  assert.deepEqual(top2.map((x) => x.name), ["a.pdf", "b.pdf"]);
  assert.equal(latestModified(srows, 10).length, 3, "nicht mehr als vorhanden");
});
