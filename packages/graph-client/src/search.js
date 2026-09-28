// Datei-Index + Suche über die Datenräume (nur lesen). Baut aus dem zentralen Microsoft-Tor
// (client.walkDrive → Ausschlüsse bereits zentral entfernt, Bauregel §3) eine flache Liste je
// Datei und durchsucht sie tolerant. Alle Namens-Regeln kommen aus naming.js (die EINE Stelle).
// Siehe ../../CLAUDE.md §3. buildSearchIndex braucht den Client; queryIndex/computeFacets sind rein.

import { isProjectFolder, parseProjectName, analysisCodeOf, parseFileName, foldSearch } from "./naming.js";

/**
 * Baut den Datei-Index für die konfigurierten Gesellschaften.
 * @param client            Graph-Client (zentrales Tor; filtert Ausschlüsse).
 * @param opts.driveId      Drive der Workspace-Wurzel.
 * @param opts.companies    [{ node, company }] aus pickCompanies() — Erlaubnisliste + Ausschlüsse.
 * @param opts.docTypes     Map aus loadDocTypes() (§5-Dokumenttypen).
 * @param opts.maxDepth     max. Tiefe je Gesellschaft (Default 6, entspricht §7 der Konventionen).
 * @returns {Promise<Array>} eine Zeile je Datei (siehe makeRow).
 */
export async function buildSearchIndex(client, { driveId, companies, docTypes, maxDepth = 6 }) {
  const rows = [];
  for (const { node, company } of companies) {
    const tree = await client.walkDrive(driveId, { itemId: node.id, maxDepth, keepFileUrls: true });
    const collect = (nodes, segs) => {
      for (const n of nodes) {
        if (n.type === "folder") collect(n.children || [], [...segs, n.name]);
        else rows.push(makeRow(n, segs, company, docTypes));
      }
    };
    // Pfad beginnt beim Gesellschaftsnamen (= Wurzel-Kind), damit „In Explorer springen"
    // (/api/fs?path=<Gesellschaft>/…) direkt passt.
    collect(tree, [company.name]);
  }
  return rows;
}

// Eine Index-Zeile je Datei. Merkmale laut Aufgabe: Name, Pfad, Gesellschaft, Projekt-ID (aus Pfad),
// A-Kennung (aus Ordner ODER Dateiname), Dokumenttyp (nur wenn in §5-Tabelle), Dokumentdatum,
// zuletzt geändert, Link, „Muster erkannt: ja/nein".
function makeRow(fileNode, dirSegs, company, docTypes) {
  const parsed = parseFileName(fileNode.name, { docTypes });
  const projSeg = dirSegs.find(isProjectFolder) || null; // Projekt-ID aus dem PFAD (zuverlässiger)
  const proj = projSeg ? parseProjectName(projSeg) : { projektId: null };
  const aFromPath = dirSegs.map(analysisCodeOf).find(Boolean) || null; // A-Ordner im Pfad
  const fullSegs = [...dirSegs, fileNode.name];
  return {
    name: fileNode.name,
    company: company.name,
    companyKey: company.key,
    dirPath: dirSegs.join("/"),   // Ordner (fürs Springen in den Explorer)
    path: fullSegs.join("/"),     // voller Pfad (Anzeige)
    projektId: proj.projektId || parsed.projektId || null,
    projektLabel: projSeg,
    aCode: aFromPath || parsed.aCode || null, // Ordner schlägt Dateiname
    docType: parsed.docType || null,
    docDate: parsed.docDate || null,
    modified: fileNode.modified || null,
    size: fileNode.size ?? 0,
    ext: parsed.ext || null,
    webUrl: fileNode.webUrl || null, // „In SharePoint öffnen"
    patternOk: parsed.patternOk,     // „Muster erkannt: ja/nein"
    _fold: foldSearch(fullSegs.join("/")), // vorberechnete Suchform (Name + Pfad)
  };
}

/**
 * Durchsucht/filtert den Index. Freitext `q` matcht tolerant über Name UND Pfad (so findet
 * „Teltow" auch Dateien im Projektordner Teltow). Filter sind exakt (Gesellschaft/Projekt/A/Typ)
 * bzw. ja|nein (Muster). Sortiert neueste zuerst (Dokumentdatum, sonst geändert).
 * @returns {{ total:number, rows:Array }} rows = Seite [offset, offset+limit), ohne interne Felder.
 */
export function queryIndex(rows, { q = "", company = "", projekt = "", a = "", doctype = "", pattern = "", limit = 200, offset = 0 } = {}) {
  const qf = q ? foldSearch(q) : null;
  const dt = doctype ? doctype.toLowerCase() : null;
  const hits = rows.filter((r) => {
    if (company && r.company !== company) return false;
    if (projekt && r.projektId !== projekt) return false;
    if (a && r.aCode !== a) return false;
    if (dt && (r.docType || "").toLowerCase() !== dt) return false;
    if (pattern === "ja" && !r.patternOk) return false;
    if (pattern === "nein" && r.patternOk) return false;
    if (qf && !r._fold.includes(qf)) return false;
    return true;
  });
  hits.sort((x, y) => String(y.docDate || y.modified || "").localeCompare(String(x.docDate || x.modified || "")));
  return { total: hits.length, rows: hits.slice(offset, offset + limit).map(stripInternal) };
}

function stripInternal(r) { const { _fold, ...rest } = r; return rest; }

/**
 * Filter-Optionen + Kennzahlen aus dem gesamten Index (für die Auswahllisten und den ersten
 * Dashboard-Wert „nicht nach Konvention benannt"). `catalog` (aus loadAnalysisCatalog) liefert
 * die Klartext-Namen zu den A-Kennungen.
 */
export function computeFacets(rows, catalog = []) {
  const companies = new Set(), projekte = new Map(), aCodes = new Set(), docTypes = new Set();
  let patternNo = 0;
  for (const r of rows) {
    if (r.company) companies.add(r.company);
    if (r.projektId) projekte.set(r.projektId, r.projektLabel || r.projektId);
    if (r.aCode) aCodes.add(r.aCode);
    if (r.docType) docTypes.add(r.docType);
    if (!r.patternOk) patternNo++;
  }
  const catName = new Map((catalog || []).map((c) => [c.code, c.name]));
  return {
    files: rows.length,
    patternNo, // = „Muster erkannt: nein" über den ganzen Bestand (erster Dashboard-Wert)
    companies: [...companies].sort((x, y) => x.localeCompare(y, "de")),
    projekte: [...projekte.entries()].map(([id, label]) => ({ id, label })).sort((x, y) => x.id.localeCompare(y.id)),
    aCodes: [...aCodes].sort().map((code) => ({ code, name: catName.get(code) || "" })),
    docTypes: [...docTypes].sort((x, y) => x.localeCompare(y, "de")),
  };
}

// ---------- Dashboard-Auswertung (nach ÄNDERUNGSdatum) ----------
// Die Startseite braucht „neu in den letzten 7 Tagen" und „zuletzt geändert" — beides über das
// technische Änderungsdatum (modified), NICHT über das Dokumentdatum. Rein/testbar; arbeitet auf
// denselben Index-Zeilen wie die Suche, damit die Zahlen in der ganzen App gleich sind.

const _mtime = (s) => { const t = Date.parse(s || ""); return isNaN(t) ? -Infinity : t; };
const _byModifiedDesc = (a, b) => _mtime(b.modified) - _mtime(a.modified);

/** Die zuletzt geänderten Dateien (nach `modified`, absteigend). Rein.
 *  @returns {Array} bis zu `limit` Zeilen (ohne interne Felder). */
export function latestModified(rows, limit = 10) {
  return (rows ?? []).slice().sort(_byModifiedDesc).slice(0, Math.max(0, limit)).map(stripInternal);
}

/** Dateien, die seit `sinceMs` (ms seit Epoch) geändert wurden — neueste zuerst. Rein.
 *  @returns {{ total:number, rows:Array }} total = alle im Zeitfenster, rows = erste `limit`. */
export function recentlyModified(rows, { sinceMs = 0, limit = 500 } = {}) {
  const hits = (rows ?? []).filter((r) => _mtime(r?.modified) >= sinceMs);
  hits.sort(_byModifiedDesc);
  return { total: hits.length, rows: hits.slice(0, Math.max(0, limit)).map(stripInternal) };
}
