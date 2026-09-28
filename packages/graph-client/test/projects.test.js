// Projektseite (App-Instanz) — Beweise mit ERFUNDENEN Daten (kein Microsoft, keine echten Personendaten):
//  1. Dokumentzahl je Analyse zählt den PHYSISCHEN Ort unter 02_Analysen (inkl. Unterordner);
//     eine Datei mit „A08" nur im Namen (z. B. im Datenraum) zählt NICHT als Analyse-Dokument.
//  2. „_UNSORTIERT_Pruefen" wird als „Zu prüfen" gezählt, nie als Analyse.
//  3. Selbstvervollständigung: eine (erfundene) neue Kennung A18 im Katalog erzeugt automatisch
//     eine neue Spalte/einen neuen Abschnitt — OHNE Code-Änderung und ohne den echten Katalog.
//  4. Kern-Abdeckung + „alte Struktur" (kein 02_Analysen) end-to-end über einen Fake-Client.
//   Ausführen:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAnalysisCatalog, filterProjectRows, analysisStatsFromRows, docsByAnalysisFromRows,
  projectsOverview, projectDetail, buildProjectsIndex,
} from "../src/projects.js";

// --- Erfundener Analysekatalog (festes Tabellenformat) — enthält eine ERFUNDENE Kennung A18. ---
const CATALOG_MD = `
## 2. Analysekatalog

| Kennung | Analyse | Kern | Bestand | Ordner |
|---|---|---|---|---|
| **A00** | Unternehmensprofil | ✓ | x | \`A00_Unternehmensprofil\` |
| **A05** | Markt und Wettbewerb | ✓ | x | \`A05_Markt\` |
| **A11** | Technik | | x | \`A11_Technik\` |
| **A18** | Zukunftsthema (erfunden) | ✓ | x | \`A18_Neu\` |
`;

// --- Erfundene Datei-Index-Zeilen (Form wie search.js → makeRow: nur die genutzten Felder). ---
const PP = "TestGmbH/04_Projekte";
const P1 = "2099-001_TEST_Teststadt";
const P2 = "2099-002_OTHER_Anderstadt";
const row = (path, docDate, modified) => ({ name: path.split("/").pop(), path, docDate, modified, webUrl: "https://x/" + path, size: 10 });

const ROWS = [
  row(`${PP}/${P1}/02_Analysen/A00_Unternehmensprofil/2099-01-01_A00_v01.pdf`, "2099-01-01", "2099-01-01T00:00:00Z"),
  row(`${PP}/${P1}/02_Analysen/A00_Unternehmensprofil/unterordner/2099-01-02_mehr_v01.pdf`, "2099-01-02", "2099-01-02T00:00:00Z"), // Unterordner → zählt zu A00
  row(`${PP}/${P1}/02_Analysen/A18_Neu/2099-02-02_neu_v01.pdf`, "2099-02-02", "2099-02-02T00:00:00Z"), // erfundene neue Kennung
  row(`${PP}/${P1}/02_Analysen/A99_Fremd/2099-02-05_fremd_v01.pdf`, "2099-02-05", "2099-02-05T00:00:00Z"), // Kennung NICHT im Katalog
  row(`${PP}/${P1}/02_Analysen/_UNSORTIERT_Pruefen/2099-03-03_todo.pdf`, "2099-03-03", "2099-03-03T00:00:00Z"), // „Zu prüfen"
  row(`${PP}/${P1}/01_Datenraum/2099-04-04_Vertrag_A00_referenz.pdf`, "2099-04-04", "2099-04-04T00:00:00Z"), // A00 nur im NAMEN, im Datenraum
  row(`${PP}/${P2}/00_Alt/2099-05-05_fremdprojekt.pdf`, "2099-05-05", "2099-05-05T00:00:00Z"), // anderes Projekt (alte Struktur)
];

test("Katalog parsen: Kern-Haken + erfundene A18 erkannt", () => {
  const cat = parseAnalysisCatalog(CATALOG_MD);
  assert.deepEqual(cat.map((c) => c.code), ["A00", "A05", "A11", "A18"]);
  assert.equal(cat.find((c) => c.code === "A18").core, true, "A18 als Kern erkannt");
  assert.equal(cat.find((c) => c.code === "A11").core, false, "A11 nicht Kern");
  assert.equal(cat.find((c) => c.code === "A00").folder, "A00_Unternehmensprofil");
});

test("filterProjectRows grenzt exakt auf EIN Projekt ein", () => {
  const r1 = filterProjectRows(ROWS, PP, P1);
  assert.equal(r1.length, 6, "6 Dateien in Projekt 1 (Fremdprojekt fällt weg)");
  assert.ok(!r1.some((r) => r.path.includes(P2)), "keine Datei des anderen Projekts");
});

test("Dokumentzahl je Analyse: physischer Ort, inkl. Unterordner; Namens-Treffer zählt nicht", () => {
  const st = analysisStatsFromRows(filterProjectRows(ROWS, PP, P1));
  assert.equal(st.perCode.A00, 2, "A00 = 2 (inkl. Unterordner), NICHT die Datenraum-Datei mit A00 im Namen");
  assert.equal(st.perCode.A18, 1, "erfundene A18 wird gezählt");
  assert.equal(st.perCode.A99, 1, "Nicht-Katalog-Kennung wird (physisch) gezählt");
  assert.equal(st.unsortedCount, 1, "eine Datei in _UNSORTIERT_Pruefen");
  assert.equal(st.totalFiles, 6);
  assert.equal(st.lastModified, "2099-04-04T00:00:00Z", "jüngste Änderung");
});

test("SELBSTVERVOLLSTÄNDIGUNG: neue Kennung A18 erzeugt automatisch Spalte/Abschnitt (ohne Code-Änderung)", () => {
  const cat = parseAnalysisCatalog(CATALOG_MD); // Katalog trägt A18 → Übersicht bekommt A18-Spalte
  assert.ok(cat.some((c) => c.code === "A18"), "A18 ist eine Katalog-Spalte");
  const { analysen, extraCodes } = docsByAnalysisFromRows(filterProjectRows(ROWS, PP, P1), cat);
  const a18 = analysen.find((a) => a.code === "A18");
  assert.ok(a18, "A18 hat einen eigenen Abschnitt");
  assert.equal(a18.count, 1);
  assert.equal(a18.docs[0].name, "2099-02-02_neu_v01.pdf");
  assert.deepEqual(extraCodes, ["A99"], "Kennung ohne Katalog-Eintrag landet in extraCodes (nicht als Spalte)");
});

test("Dokumentliste je Analyse: neueste zuerst; _UNSORTIERT_Pruefen separat", () => {
  const cat = parseAnalysisCatalog(CATALOG_MD);
  const { analysen, unsorted } = docsByAnalysisFromRows(filterProjectRows(ROWS, PP, P1), cat);
  const a00 = analysen.find((a) => a.code === "A00");
  assert.equal(a00.count, 2);
  assert.equal(a00.docs[0].docDate, "2099-01-02", "neueste zuerst");
  assert.equal(unsorted.length, 1);
  assert.equal(unsorted[0].name, "2099-03-03_todo.pdf");
  assert.ok(!analysen.some((a) => a.docs.some((d) => d.name.includes("todo"))), "Zu-prüfen-Datei nie in einer Analyse");
});

// --- Struktur-Index (Ordner) für die REINEN Übersicht/Detail-Funktionen (kein Microsoft). ---
const fol = (path, webUrl) => ({ path, name: path.split("/").pop(), webUrl: webUrl || "https://x/" + path });
const FOLDERS = [
  fol(`${PP}/${P1}`, "https://sp/" + P1),
  fol(`${PP}/${P1}/02_Analysen`),
  fol(`${PP}/${P1}/01_Datenraum`),
  fol(`${PP}/${P1}/02_Analysen/A00_Unternehmensprofil`),
  fol(`${PP}/${P1}/02_Analysen/A00_Unternehmensprofil/unterordner`),
  fol(`${PP}/${P1}/02_Analysen/A18_Neu`),
  fol(`${PP}/${P1}/02_Analysen/A99_Fremd`),
  fol(`${PP}/${P1}/02_Analysen/_UNSORTIERT_Pruefen`),
  fol(`${PP}/${P2}`, "https://sp/" + P2),
  fol(`${PP}/${P2}/00_Alt`),
  fol(`${PP}/_VORLAGE_Projekt`), // KEIN Projekt (kein JJJJ-NNN) → muss ignoriert werden
];
const INDEX = { rows: ROWS, folders: FOLDERS };

test("Übersicht end-to-end (rein): Vorlage weg, Kern-Abdeckung, alte Struktur, dynamische A18-Spalte", () => {
  const cat = parseAnalysisCatalog(CATALOG_MD);
  const ov = projectsOverview({ index: INDEX, projektePath: PP, catalog: cat });
  assert.equal(ov.length, 2, "nur 2 echte Projekte (_VORLAGE_Projekt fällt weg)");

  const p1 = ov.find((p) => p.name === P1);
  assert.equal(p1.alteStruktur, false);
  assert.equal(p1.kuerzel, "TEST");
  assert.equal(p1.stadt, "Teststadt");
  assert.equal(p1.webUrl, "https://sp/" + P1, "Projekt-Link aus dem Ordner-Index");
  assert.equal(p1.core.total, 3, "3 Kernanalysen im Katalog (A00, A05, A18)");
  assert.equal(p1.core.filled, 2, "A00 + A18 befüllt");
  assert.deepEqual(p1.coreMissing, ["A05"], "A05 ist Kern ohne Dokument");
  assert.equal(p1.perCode.A18, 1, "A18-Spaltenwert vorhanden (neue Kennung, automatisch)");
  assert.equal(p1.unsortedCount, 1);

  const p2 = ov.find((p) => p.name === P2);
  assert.equal(p2.alteStruktur, true, "kein 02_Analysen → alte Struktur");
  assert.equal(p2.core.filled, 0, "ohne 02_Analysen keine Kernanalyse befüllt");
  assert.equal(p2.totalFiles, 1, "eine Datei in alter Struktur");
  assert.deepEqual(p2.perCode, {}, "keine Analyse-Dokumente (nichts unter 02_Analysen)");
});

test("Detail end-to-end (rein): SharePoint-Link, Datenraum-Sprung, offene Kernanalysen", () => {
  const cat = parseAnalysisCatalog(CATALOG_MD);
  const d = projectDetail({ index: INDEX, projektePath: PP, projectName: P1, catalog: cat });
  assert.equal(d.webUrl, "https://sp/" + P1);
  assert.equal(d.hasDatenraum, true, "01_Datenraum vorhanden → Sprung in den Explorer möglich");
  assert.equal(d.alteStruktur, false);
  assert.deepEqual(d.coreMissing, ["A05"]);
  assert.equal(d.analysen.find((a) => a.code === "A18").count, 1);
  assert.equal(d.totalFiles, 6);
});

// --- Voll-tiefer Walk (Fake-Client): erfasst Dateien UND Ordner unterhalb der alten Tiefe-6-Grenze. ---
const FF = (id, name, childCount = 1) => ({ id, name, folder: { childCount }, webUrl: "https://x/" + id });
const DD = (id, name) => ({ id, name, size: 10, lastModifiedDateTime: "2099-09-09T00:00:00Z", webUrl: "https://x/" + id });
const DEEP = {
  PPX: [FF("dp1", "2099-003_DEEP_Tiefenstadt")],
  dp1: [FF("an", "02_Analysen")],
  an: [FF("a00", "A00_Tief")],
  a00: [FF("s1", "ebene1")],
  s1: [FF("s2", "ebene2")],
  s2: [FF("s3", "ebene3")],
  s3: [DD("f", "2099-09-09_sehr_tief_v01.pdf")], // Datei auf Ebene 8 unter 04_Projekte
};
const deepClient = { listChildren: async (_d, id) => DEEP[id] || [] };

test("buildProjectsIndex: volle Tiefe, Dateien + Ordner (keine Tiefe-6-Kappung → LSQ2-Fall)", async () => {
  const { rows, folders } = await buildProjectsIndex(deepClient, { driveId: "d", projekteItemId: "PPX", projektePath: "X/04_Projekte" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "X/04_Projekte/2099-003_DEEP_Tiefenstadt/02_Analysen/A00_Tief/ebene1/ebene2/ebene3/2099-09-09_sehr_tief_v01.pdf");
  assert.equal(rows[0].docDate, "2099-09-09");
  assert.ok(folders.some((f) => f.path === "X/04_Projekte/2099-003_DEEP_Tiefenstadt/02_Analysen"), "02_Analysen als Ordner erfasst");
  assert.equal(analysisStatsFromRows(rows).perCode.A00, 1, "tiefe Datei wird A00 zugeordnet");
});
