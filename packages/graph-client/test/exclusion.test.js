// Beweist: Ordner der Ausschlussliste (z. B. „90_Personal_VERTRAULICH") tauchen NIE in einer
// Antwort des zentralen Microsoft-Tors (graph-client) auf — oben, verschachtelt und in jeder
// Groß-/Kleinschreibung. Der Server bekommt seine Daten ausschließlich von hier; was hier nicht
// herauskommt, kann der Server nicht ausliefern. Läuft mit ERFUNDENEN Beispieldaten (kein Microsoft).
//   Ausführen:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGraphClient } from "../src/index.js";
import { isExcluded, filterExcluded } from "../src/workspace.js";

// --- Erfundener Ordnerbaum (Graph-Item-Form). Ausgeschlossene Ordner in mehreren Ebenen + Schreibweisen. ---
const F = (id, name) => ({ id, name, folder: {}, webUrl: "https://x/" + id, lastModifiedDateTime: "2026-01-01T00:00:00Z" });
const D = (id, name) => ({ id, name, file: {}, size: 10, lastModifiedDateTime: "2026-01-01T00:00:00Z" });

const NODES = {
  root: [F("u", "01_Unternehmen"), F("p1", "90_Personal_VERTRAULICH"), F("pr", "04_Projekte"), D("dsf", ".DS_Store")],
  u: [D("f1", "2026-01-01_Doc.pdf"), F("p2", "90_Personal_Sub"), F("p2b", "90_personal_klein")],
  pr: [F("p3", "90_PERSONAL_VERTRAULICH"), F("proj", "2026-014_X")],
  // Inhalte ausgeschlossener Ordner — dürfen NIE erreicht/ausgegeben werden:
  p1: [D("s1", "Gehalt.xlsx")],
  p2: [D("s2", "Vertrag.pdf")],
  p3: [D("s3", "Geheim.docx")],
  proj: [D("f2", "2026-02-02_Plan.pdf")],
};
const SEARCH = [F("u", "01_Unternehmen"), F("p1", "90_Personal_VERTRAULICH"), F("p3", "90_PERSONAL_VERTRAULICH")];

// --- fetch stubben: Token + /children + /search liefern die erfundenen Daten. ---
const mkRes = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("login.microsoftonline.com")) return mkRes({ access_token: "tok", expires_in: 3600 });
  if (u.includes("/search(")) return mkRes({ value: SEARCH });
  const m = u.match(/\/drives\/[^/]+\/(?:items\/([^/?]+)|root)\/children/);
  if (m) return mkRes({ value: NODES[m[1] || "root"] || [] });
  return mkRes({ value: [] });
};

const client = createGraphClient({ tenantId: "t", clientId: "c", clientSecret: "s" });
const DRIVE = "drive1";
const PERSONAL = /90[_ ]?personal/i;
const SECRETS = ["Gehalt.xlsx", "Vertrag.pdf", "Geheim.docx"];
const namesOf = (arr) => arr.map((n) => n.name);
function collect(nodes, acc = []) { for (const n of nodes) { acc.push(n.name); if (n.children) collect(n.children, acc); } return acc; }

test("isExcluded/filterExcluded: alle Schreibweisen + .DS_Store", () => {
  for (const n of ["90_Personal_VERTRAULICH", "90_PERSONAL_VERTRAULICH", "90_personal_klein", "90_Personal_Sub", ".DS_Store", "_ZU_LOESCHEN_alt"])
    assert.equal(isExcluded(n), true, `sollte ausgeschlossen sein: ${n}`);
  for (const n of ["01_Unternehmen", "04_Projekte", "2026-014_X", "Personalplanung"]) // "Personal" ohne 90_ ist erlaubt
    assert.equal(isExcluded(n), false, `sollte erlaubt sein: ${n}`);
  assert.deepEqual(namesOf(filterExcluded(NODES.root)).sort(), ["01_Unternehmen", "04_Projekte"]);
});

test("listChildren: ausgeschlossene Einträge fehlen auf JEDER Ebene", async () => {
  for (const id of ["root", "u", "pr"]) {
    const names = namesOf(await client.listChildren(DRIVE, id === "root" ? null : id));
    for (const n of names) assert.ok(!PERSONAL.test(n) && n !== ".DS_Store", `durchgerutscht in ${id}: ${n}`);
  }
  // Sanity: erlaubte Inhalte sind da.
  assert.ok(namesOf(await client.listChildren(DRIVE, null)).includes("01_Unternehmen"));
});

test("childByName: ausgeschlossener Ordner → null (auch andere Groß-/Kleinschreibung)", async () => {
  assert.equal(await client.childByName(DRIVE, "root", "90_Personal_VERTRAULICH"), null);
  assert.equal(await client.childByName(DRIVE, "root", "90_PERSONAL_VERTRAULICH"), null); // Schreibweise
  assert.equal(await client.childByName(DRIVE, "u", "90_Personal_Sub"), null);            // verschachtelt
  assert.equal(await client.childByName(DRIVE, "u", "90_personal_klein"), null);
  assert.ok(await client.childByName(DRIVE, "root", "01_Unternehmen"));                    // erlaubtes bleibt auffindbar
});

test("walkDrive: kein ausgeschlossener Ordner UND kein Inhalt daraus im Baum", async () => {
  const names = collect(await client.walkDrive(DRIVE, { itemId: null, maxDepth: 10 }));
  for (const n of names) assert.ok(!PERSONAL.test(n), `Ordner durchgerutscht: ${n}`);
  for (const s of SECRETS) assert.ok(!names.includes(s), `Inhalt aus ausgeschlossenem Ordner gelesen: ${s}`);
  assert.ok(names.includes("2026-014_X"), "erlaubter Teilbaum fehlt");
});

test("searchDrive: ausgeschlossene Treffer (jede Schreibweise) werden gefiltert", async () => {
  const names = namesOf(await client.searchDrive(DRIVE, "irgendwas"));
  for (const n of names) assert.ok(!PERSONAL.test(n), `Suchtreffer durchgerutscht: ${n}`);
  assert.ok(names.includes("01_Unternehmen")); // erlaubter Treffer bleibt
});
