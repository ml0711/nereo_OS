// Testet die EINE Stelle für Namens-Regeln (naming.js): Dokumenttyp-Tabelle aus §5 parsen,
// Dateinamen zerlegen, tolerante Suchform. Rein — keine Graph-/Netzwerk-Abhängigkeit. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocTypes, parseFileName, foldSearch, parseProjectName, analysisCodeOf, docDateFromName } from "../src/naming.js";

const MD = `
## 5 · Dateiname

| Kürzel | Bedeutung | | Kürzel | Bedeutung |
|---|---|---|---|---|
| \`AN\` | Angebot | | \`Analyse\` | eigene Auswertung |
| \`Vertrag\` | Vertrag | | \`BWA\` | Auswertung |

- \`Plan\` ist **kein** Dokumenttyp.

## 6 · Nächster Abschnitt
| \`RE\` | darf NICHT als Typ gezählt werden (außerhalb §5) |
`;

test("parseDocTypes: liest §5-Kürzel, Original-Schreibweise, ohne Plan/Fremdabschnitt", () => {
  const m = parseDocTypes(MD);
  assert.equal(m.get("an"), "AN");
  assert.equal(m.get("analyse"), "Analyse");
  assert.equal(m.get("vertrag"), "Vertrag");
  assert.equal(m.get("bwa"), "BWA");
  assert.equal(m.has("plan"), false, "Plan ist kein Dokumenttyp (§5)");
  assert.equal(m.has("re"), false, "außerhalb §5 → nicht gezählt");
});

const DT = new Map([["re", "RE"], ["analyse", "Analyse"], ["bwa", "BWA"]]);

test("parseFileName: volles Muster mit Projekt-ID", () => {
  const r = parseFileName("2026-09-08_2025-001_RE_Tobok_LPh3_v01.pdf", { docTypes: DT });
  assert.deepEqual(
    { docDate: r.docDate, projektId: r.projektId, docType: r.docType, aCode: r.aCode, version: r.version, ext: r.ext, patternOk: r.patternOk },
    { docDate: "2026-09-08", projektId: "2025-001", docType: "RE", aCode: null, version: "v01", ext: "pdf", patternOk: true }
  );
});

test("parseFileName: Analyse mit A-Kennung im Namen", () => {
  const r = parseFileName("2026-09-17_2026-022_Analyse_A08_Varianten_v01.pdf", { docTypes: DT });
  assert.equal(r.docType, "Analyse");
  assert.equal(r.aCode, "A08");
  assert.equal(r.patternOk, true);
});

test("parseFileName: ohne Projekt-ID", () => {
  const r = parseFileName("2026-08-31_BWA_nereo-development_v01.pdf", { docTypes: DT });
  assert.equal(r.projektId, null);
  assert.equal(r.docType, "BWA");
  assert.equal(r.patternOk, true);
});

test("parseFileName: Altbestand ohne Muster", () => {
  const r = parseFileName("Alte Übersicht Fördermittel.xlsx", { docTypes: DT });
  assert.equal(r.docDate, null);
  assert.equal(r.docType, null);
  assert.equal(r.patternOk, false, "kein Datum/Typ/Version → Muster erkannt: nein");
});

test("foldSearch: Umlaute + Trenner tolerant", () => {
  assert.equal(foldSearch("Fördermittel"), "foerdermittel");
  assert.equal(foldSearch("Foerder-mittel"), "foerdermittel");
  assert.equal(foldSearch("Teltow"), "teltow");
  assert.equal(foldSearch("A-08"), "a08");
  assert.equal(foldSearch("Straße"), "strasse");
});

test("parseProjectName / analysisCodeOf / docDateFromName", () => {
  assert.deepEqual(parseProjectName("2026-014_QG20_Ehningen"), { projektId: "2026-014", kuerzel: "QG20", stadt: "Ehningen" });
  assert.equal(analysisCodeOf("A08_Nutzung_Varianten"), "A08");
  assert.equal(analysisCodeOf("A08"), "A08");
  assert.equal(analysisCodeOf("01_Datenraum"), null);
  assert.equal(docDateFromName("2026-09-08_x.pdf"), "2026-09-08");
  assert.equal(docDateFromName("ohne_datum.pdf"), null);
});
