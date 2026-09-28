// Projekt-Vollständigkeit gegen den Analysekatalog A00–A17 (Ebene 1: deterministisch, KEINE KI).
// Je Projekt (JJJJ-NNN_…) wird geprüft, welche der Katalog-Analysen unter 02_Analysen als Ordner
// vorliegen und ob sie befüllt sind. Kern = die 8 Kernanalysen laut Katalog.
//
// Der Katalog wird LIVE aus _ANALYSEKATALOG.md gelesen (Bauregel §9: lesen, nicht abschreiben) —
// so zieht er automatisch mit, wenn eine Kennung ergänzt wird. Siehe ../../CLAUDE.md §3/§9.

/** Ordnername ist ein Projekt (Projekt-ID JJJJ-NNN_…)? */
export function isProjectFolder(name) {
  return /^\d{4}-\d{3}[ _]/.test(name || "");
}

/** Zerlegt "2026-014_QG20_Ehningen" → { projektId, kuerzel, stadt }. */
export function parseProjectName(name) {
  const m = /^(\d{4}-\d{3})[ _]+(.+)$/.exec(name || "");
  if (!m) return { projektId: null, kuerzel: null, stadt: null };
  const parts = m[2].split(/[_ ]+/);
  return { projektId: m[1], kuerzel: parts[0] || null, stadt: parts.slice(1).join(" ") || null };
}

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

// Kennung ("A08") aus einem Analyse-Ordnernamen ("A08_Nutzung_Varianten"); sonst null.
function analysisCodeOf(name) {
  const m = /^(A\d{2})[ _]/.exec(name || "");
  return m ? m[1] : null;
}

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
