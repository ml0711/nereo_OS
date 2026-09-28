// Projekt-Vollständigkeit gegen den Analysekatalog A00–A17 (Ebene 1: deterministisch, KEINE KI).
// Je Projekt (JJJJ-NNN_…) wird geprüft, welche der Katalog-Analysen unter 02_Analysen als Ordner
// vorliegen und ob sie befüllt sind. Kern = die 8 Kernanalysen laut Katalog.
//
// Der Katalog wird LIVE aus _ANALYSEKATALOG.md gelesen (Bauregel §9: lesen, nicht abschreiben) —
// so zieht er automatisch mit, wenn eine Kennung ergänzt wird. Siehe ../../CLAUDE.md §3/§9.

// Namens-Regeln kommen aus der EINEN Stelle (naming.js), nicht doppelt hier. Re-Export, damit
// bestehende Importe von projects.js unverändert weiterlaufen.
import { isProjectFolder, parseProjectName, analysisCodeOf, docDateFromName } from "./naming.js";
export { isProjectFolder, parseProjectName };

// ---------- Analysekatalog (aus _ANALYSEKATALOG.md) ----------

/**
 * Parst die Katalog-Tabelle (§2) aus _ANALYSEKATALOG.md.
 * Erkennt Zeilen mit einer Kennung `A00`–`A17` (auch **fett**), liest Name, Kern-Haken (✓)
 * und den Ordnernamen aus den Backticks. Rein — testbar ohne Graph.
 * @returns {Array<{code,name,core,folder}>}
 */
export function parseAnalysisCatalog(md) {
  const out = [];
  const seen = new Set();
  for (const raw of String(md ?? "").split("\n")) {
    if (!raw.includes("|")) continue;
    const cells = raw.split("|").map((c) => c.trim());
    const i = cells.findIndex((c) => /^\*{0,2}A\d{2}\*{0,2}$/.test(c));
    if (i < 0) continue;
    const code = cells[i].replace(/\*/g, "");
    if (seen.has(code)) continue;
    const name = (cells[i + 1] || "").replace(/\*/g, "").trim();
    const core = /[✓✔]/.test(cells[i + 2] || "");
    const fm = raw.match(new RegExp("`(" + code + "[^`]*)`"));
    out.push({ code, name, core, folder: fm ? fm[1] : code });
    seen.add(code);
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

let _catalog = null; // { list, loadedAt }
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 h — Katalog ändert sich selten

/** Lädt + cached den Analysekatalog aus _ANALYSEKATALOG.md an der Workspace-Wurzel.
 *  Degradiert leer (kein Crash), wenn die Datei fehlt/nicht lesbar ist. */
export async function loadAnalysisCatalog(client, root, { force = false } = {}) {
  if (!force && _catalog && Date.now() - _catalog.loadedAt < CATALOG_TTL_MS) return _catalog.list;
  let list = [];
  try {
    const f = await client.childByName(root.driveId, root.itemId, "_ANALYSEKATALOG.md");
    if (f && !f.folder) {
      const buf = await client.downloadItem(root.driveId, f.id);
      list = parseAnalysisCatalog(buf.toString("utf8"));
    }
  } catch (e) {
    console.error("[projects] Analysekatalog nicht lesbar:", e.status ?? e.message);
  }
  _catalog = { list, loadedAt: Date.now() };
  return list;
}

/** Verwirft den Katalog-Cache (z. B. nach Katalog-Änderung). */
export function clearCatalogCache() { _catalog = null; }

// ---------- Projekt-Status ----------

/**
 * Vollständigkeits-Status EINES Projekts gegen den Katalog.
 * `filled` = Katalog-Ordner existiert UND hat Inhalt (childCount > 0). `present` = existiert.
 * Kosten: 2 Graph-Aufrufe (Projekt-Kinder + 02_Analysen-Kinder).
 */
export async function buildProjectStatus(client, { driveId, projectItemId, projectName, catalog }) {
  const meta = parseProjectName(projectName);
  const projectKids = await client.listChildren(driveId, projectItemId);
  const analysenNode = projectKids.find((k) => k.folder && /^02_Analysen$/i.test(k.name));
  const aFolders = analysenNode ? await client.listChildren(driveId, analysenNode.id) : [];

  const byCode = new Map();
  const extra = [];
  for (const k of aFolders) {
    if (!k.folder) continue;
    const code = analysisCodeOf(k.name);
    if (code) byCode.set(code, k);
    else extra.push(k.name); // Nicht-Katalog-Ordner, z. B. _UNSORTIERT_Pruefen
  }

  const analysen = (catalog ?? []).map((c) => {
    const node = byCode.get(c.code) ?? null;
    const count = node?.folder?.childCount ?? 0;
    return { code: c.code, name: c.name, core: c.core, folder: c.folder, present: !!node, filled: !!node && count > 0, count };
  });
  const coreList = analysen.filter((a) => a.core);
  return {
    projektId: meta.projektId, name: projectName, kuerzel: meta.kuerzel, stadt: meta.stadt,
    hasAnalysenFolder: !!analysenNode,
    analysen,
    core: { filled: coreList.filter((a) => a.filled).length, total: coreList.length },
    all: { filled: analysen.filter((a) => a.filled).length, total: analysen.length },
    missingCore: coreList.filter((a) => !a.filled).map((a) => a.code),
    extra,
  };
}

/**
 * Alle Projekte unter einem 04_Projekte-Ordner, je mit Status (Vorlagen/Altordner ohne
 * Projekt-ID werden übersprungen). Projekt-Builds laufen parallel (Promise.all).
 */
export async function listProjectsWithStatus(client, { driveId, projekteItemId, catalog }) {
  const kids = await client.listChildren(driveId, projekteItemId);
  const projects = kids.filter((k) => k.folder && isProjectFolder(k.name));
  const out = await Promise.all(
    projects.map((p) => buildProjectStatus(client, { driveId, projectItemId: p.id, projectName: p.name, catalog }))
  );
  out.sort((a, b) => (a.projektId || a.name).localeCompare(b.projektId || b.name, "de"));
  return out;
}

// ===================================================================
// Seite „Projekte" (App-Instanz) — Datei-Kennzahlen aus dem gemeinsamen Datei-Index.
// Die Dokumentzahlen kommen aus derselben Datei-Liste wie die Datenraum-Suche (search.js),
// damit die Zahlen in der ganzen App gleich sind. Diese Helfer sind REIN (keine Graph-
// Abhängigkeit) und werden mit erfundenen Zeilen getestet (test/projects.test.js — u. a. der
// „A18 erzeugt automatisch eine neue Spalte"-Beweis). Zeilen-Form = search.js → makeRow().
// ===================================================================

/** Alle Index-Zeilen EINES Projekts (physisch unter <projektePath>/<projektName>/…).
 *  Abschließender „/" verhindert, dass „2026-014_…" auf „2026-014_…X" mit-matcht. Rein. */
export function filterProjectRows(rows, projektePath, projectName) {
  const prefix = `${projektePath}/${projectName}/`;
  return (rows ?? []).filter((r) => typeof r?.path === "string" && r.path.startsWith(prefix));
}

/** A-Kennung eines Dokuments nach seinem PHYSISCHEN Ort: das Pfad-Segment direkt unter
 *  „02_Analysen" (deckt Unterordner mit ab). So zählt eine Datei im Datenraum, die „A08" nur
 *  im Namen trägt, NICHT als Analyse-Dokument. null, wenn nicht unter 02_Analysen. Rein. */
function analysisCodeForRow(row) {
  const segs = String(row?.path || "").split("/");
  const i = segs.indexOf("02_Analysen");
  return i >= 0 && segs[i + 1] ? analysisCodeOf(segs[i + 1]) : null;
}
/** Liegt das Dokument in einem „_UNSORTIERT_Pruefen"-Ordner (irgendwo unter dem Projekt)? Rein. */
function isUnsortedRow(row) {
  return String(row?.path || "").split("/").includes("_UNSORTIERT_Pruefen");
}

/** Datei-Kennzahlen eines Projekts aus seinen Index-Zeilen: Dokumentzahl je A-Kennung
 *  (einschließlich Unterordner), „Zu prüfen", Dateien gesamt, zuletzt geändert. Rein. */
export function analysisStatsFromRows(projectRows) {
  const perCode = {};
  let unsortedCount = 0;
  let lastModified = null;
  for (const r of projectRows ?? []) {
    const code = analysisCodeForRow(r);
    if (code) perCode[code] = (perCode[code] || 0) + 1;
    if (isUnsortedRow(r)) unsortedCount++;
    const m = r?.modified || null;
    if (m && (!lastModified || m > lastModified)) lastModified = m;
  }
  return { perCode, unsortedCount, totalFiles: (projectRows ?? []).length, lastModified };
}

/** Dokumentlisten je Katalog-A-Kennung + „Zu prüfen" für die Projektseite (Detail). Sortiert
 *  neueste zuerst (Dokumentdatum, sonst geändert). `extraCodes` = A-Kennungen mit Dateien, die
 *  (noch) nicht im Katalog stehen. Rein. */
export function docsByAnalysisFromRows(projectRows, catalog) {
  const byCode = new Map();
  const unsorted = [];
  for (const r of projectRows ?? []) {
    const doc = { name: r.name, docDate: r.docDate || null, modified: r.modified || null, webUrl: r.webUrl || null, path: r.path };
    if (isUnsortedRow(r)) { unsorted.push(doc); continue; } // „Zu prüfen" nicht als Analyse-Dokument zählen
    const code = analysisCodeForRow(r);
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(doc);
  }
  const byDate = (a, b) => String(b.docDate || b.modified || "").localeCompare(String(a.docDate || a.modified || ""));
  const analysen = (catalog ?? []).map((c) => ({
    code: c.code, name: c.name, core: c.core, folder: c.folder,
    docs: (byCode.get(c.code) || []).slice().sort(byDate),
    count: (byCode.get(c.code) || []).length,
  }));
  const extraCodes = [...byCode.keys()].filter((code) => !(catalog ?? []).some((c) => c.code === code)).sort();
  unsorted.sort(byDate);
  return { analysen, extraCodes, unsorted };
}

/** Kern-Abdeckung aus den Dokumentzahlen (nicht aus Ordner-Existenz): Kernanalyse „erfüllt",
 *  wenn ≥1 Dokument. Passt zur Hervorhebung „Kernanalyse ohne Dokument". Rein. */
function coreCoverage(catalog, perCode) {
  const coreCodes = (catalog ?? []).filter((c) => c.core).map((c) => c.code);
  const missing = coreCodes.filter((code) => !(perCode[code] > 0));
  return { core: { filled: coreCodes.length - missing.length, total: coreCodes.length }, coreMissing: missing };
}

// ---------- Voll-tiefer Datei-Index NUR für die Projektseite ----------
// Zählt in VOLLER Ordnertiefe (die Datenraum-Suche bleibt bei Tiefe 6 — hiervon UNBERÜHRT).
// Grund: große, tief verschachtelte Projekte (Datenräume) reichen tiefer als 6; erst voll-tief
// stimmen die Zahlen exakt mit dem _PROJEKTREGISTER.xlsx überein (an LSQ2 verifiziert 2026-09-28).
// EIN Walk liefert Dateien UND Ordner-Existenz → Übersicht/Detail brauchen danach KEINE weitere
// Microsoft-Abfrage (rein, testbar). Läuft über das EINE Tor (Ausschlüsse zentral raus, Bauregel §3/§5),
// begrenzt parallel + mit 429-Wiederholung (Graph-Throttling), danach zwischengespeichert.

/** listChildren mit Wiederholung bei 429 (Throttling) — respektiert retryAfterSeconds. */
async function listChildrenResilient(client, driveId, id, { tries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await client.listChildren(driveId, id); }
    catch (e) {
      if (e?.status === 429 && attempt < tries) {
        const secs = Number(e?.body?.retryAfterSeconds) || 5;
        await new Promise((r) => setTimeout(r, Math.min(secs, 60) * 1000));
        continue;
      }
      throw e;
    }
  }
}

/** Begrenzt-paralleler, rekursiver Walk (dediziert; ändert das geteilte walkDrive NICHT).
 *  Rückgabe { rows, folders }: rows je Datei { name, path, modified, webUrl, size, docDate };
 *  folders je Ordner { path, name, webUrl } (auch leere → „02_Analysen vorhanden?" bleibt korrekt). */
async function walkProjectFiles(client, driveId, itemId, baseSegs, { maxDepth = 20, concurrency = 6 } = {}) {
  const rows = [];
  const folders = [];
  const frontier = [{ id: itemId, segs: baseSegs, depth: 0 }];
  let running = 0;
  const visit = async ({ id, segs, depth }) => {
    const kids = await listChildrenResilient(client, driveId, id); // zentral gefiltert (Ausschluss)
    for (const k of kids) {
      if (k.folder) {
        const path = [...segs, k.name].join("/");
        folders.push({ path, name: k.name, webUrl: k.webUrl || null }); // Existenz IMMER merken (auch leer)
        // childCount === 0 ⇒ sicher leer, Abstieg gespart; unbekannt/>0 ⇒ absteigen (sonst Teilbäume verloren).
        if (depth < maxDepth && k.folder.childCount !== 0) frontier.push({ id: k.id, segs: [...segs, k.name], depth: depth + 1 });
      } else {
        rows.push({
          name: k.name, path: [...segs, k.name].join("/"),
          modified: k.lastModifiedDateTime || null, webUrl: k.webUrl || null,
          size: k.size ?? 0, docDate: docDateFromName(k.name),
        });
      }
    }
  };
  await new Promise((resolveAll, rejectAll) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (frontier.length === 0 && running === 0) return resolveAll();
      while (running < concurrency && frontier.length) {
        running++;
        visit(frontier.shift()).then(() => { running--; pump(); }, (e) => { failed = true; rejectAll(e); });
      }
    };
    pump();
  });
  return { rows, folders };
}

/** Baut den voll-tiefen Index (Dateien + Ordner) für ALLE Projekte unter 04_Projekte. */
export async function buildProjectsIndex(client, { driveId, projekteItemId, projektePath, maxDepth = 20, concurrency = 6 }) {
  return walkProjectFiles(client, driveId, projekteItemId, projektePath.split("/"), { maxDepth, concurrency });
}

/**
 * Übersicht aller Projekte unter 04_Projekte für die Projektseite — REIN (aus dem gebauten Index,
 * KEINE weitere Microsoft-Abfrage). Struktur (hat 02_Analysen? → sonst „alte Struktur"; Projekt-Link)
 * kommt aus `index.folders`, die Datei-Zahlen aus `index.rows`. Vorlagen/„_…" fallen weg.
 */
export function projectsOverview({ index, projektePath, catalog }) {
  const rows = index?.rows ?? [];
  const folders = index?.folders ?? [];
  const folderPaths = new Set(folders.map((f) => f.path));
  const projFolders = folders.filter((f) => f.path === `${projektePath}/${f.name}` && isProjectFolder(f.name));
  const out = projFolders.map((p) => {
    const meta = parseProjectName(p.name);
    const stats = analysisStatsFromRows(filterProjectRows(rows, projektePath, p.name));
    const cov = coreCoverage(catalog, stats.perCode);
    return {
      projektId: meta.projektId, name: p.name, kuerzel: meta.kuerzel, stadt: meta.stadt,
      webUrl: p.webUrl ?? null, alteStruktur: !folderPaths.has(`${projektePath}/${p.name}/02_Analysen`),
      perCode: stats.perCode, unsortedCount: stats.unsortedCount,
      totalFiles: stats.totalFiles, lastModified: stats.lastModified,
      ...cov,
    };
  });
  out.sort((a, b) => (a.projektId || a.name).localeCompare(b.projektId || b.name, "de"));
  return out;
}

/**
 * Detailstatus EINES Projekts für die Projektseite — REIN (aus dem Index). Dokumentlisten je
 * A-Kennung, „Zu prüfen", Kern-Abdeckung, ob 01_Datenraum vorhanden ist (Sprung in den Explorer),
 * Projekt-Link (webUrl) aus `index.folders`.
 */
export function projectDetail({ index, projektePath, projectName, catalog }) {
  const rows = index?.rows ?? [];
  const folders = index?.folders ?? [];
  const folderPaths = new Set(folders.map((f) => f.path));
  const projFolder = folders.find((f) => f.path === `${projektePath}/${projectName}`);
  const meta = parseProjectName(projectName);
  const prows = filterProjectRows(rows, projektePath, projectName);
  const { analysen, extraCodes, unsorted } = docsByAnalysisFromRows(prows, catalog);
  const stats = analysisStatsFromRows(prows);
  const cov = coreCoverage(catalog, stats.perCode);
  return {
    projektId: meta.projektId, name: projectName, kuerzel: meta.kuerzel, stadt: meta.stadt,
    webUrl: projFolder?.webUrl ?? null,
    alteStruktur: !folderPaths.has(`${projektePath}/${projectName}/02_Analysen`),
    hasDatenraum: folderPaths.has(`${projektePath}/${projectName}/01_Datenraum`),
    analysen, extraCodes, unsorted,
    totalFiles: stats.totalFiles, lastModified: stats.lastModified, unsortedCount: stats.unsortedCount,
    ...cov,
  };
}
