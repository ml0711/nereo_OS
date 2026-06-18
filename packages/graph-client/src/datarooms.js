// Datenraum-Analyse: erkennt aus dem Graph-Index alle Datenräume und liefert je
// Datenraum eine Übersicht — Projekt, Status, Umfang, Dateitypen und Vollständigkeit
// gegen das Standard-Schema 00–16 (CLAUDE.md §3: "Was fehlt im Datenraum?").

export const STANDARD_CATEGORIES = [
  { num: "00", label: "Datenraum-Information" },
  { num: "01", label: "Asset-Overview" },
  { num: "02", label: "Standort und Markt" },
  { num: "03", label: "Grundstück" },
  { num: "04", label: "Baurecht und Genehmigungen" },
  { num: "05", label: "Technische Gebäudedaten" },
  { num: "06", label: "Gutachten" },
  { num: "07", label: "Mietverträge und Vermietung" },
  { num: "08", label: "Property und Facility Management" },
  { num: "09", label: "Versicherungen und Steuern" },
  { num: "10", label: "ESG und Nachhaltigkeit" },
  { num: "11", label: "Projektentwicklung und Bau" },
  { num: "12", label: "Finanzierung" },
  { num: "13", label: "Fördermittel" },
  { num: "14", label: "Transaktion" },
  { num: "15", label: "Wirtschaftlichkeit und Finanzmodell" },
  { num: "16", label: "Risiken und QnA" },
];

export const isDataRoomName = (name) =>
  /(^|[_\s-])datenraum/i.test(name) || /^dr[-_]asset/i.test(name);

function flattenFolders(nodes, prefix, out) {
  for (const n of nodes) {
    if (n.type !== "folder") continue;
    const path = `${prefix}/${n.name}`;
    out.push({ name: n.name, path, node: n });
    if (n.children) flattenFolders(n.children, path, out);
  }
  return out;
}

export function statsOf(node, acc) {
  acc ||= { files: 0, folders: 0, bytes: 0, modified: null, types: {} };
  for (const c of node.children ?? []) {
    if (c.type === "folder") { acc.folders++; statsOf(c, acc); }
    else {
      acc.files++;
      acc.bytes += c.size || 0;
      if (c.modified && (!acc.modified || c.modified > acc.modified)) acc.modified = c.modified;
      const ext = (c.name.includes(".") ? c.name.split(".").pop() : "—").toLowerCase();
      acc.types[ext] = (acc.types[ext] || 0) + 1;
    }
  }
  return acc;
}

export function categoryStatus(rootNode) {
  const folders = flattenFolders(rootNode.children ?? [], "", []);
  return STANDARD_CATEGORIES.map((cat) => {
    const hit = folders.find((f) => new RegExp(`^${cat.num}[ _\\-]`).test(f.name));
    return { ...cat, present: !!hit, files: hit ? statsOf(hit.node).files : 0 };
  });
}

export function statusOf(path) {
  if (/xx_dropped|\/dropped(\/|$)/i.test(path)) return "Dropped";
  if (/pipeline/i.test(path)) return "Pipeline";
  if (/beispiel|vorlage/i.test(path)) return "Vorlage";
  return "Aktiv";
}

let _id = 0;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60);

/** Extrahiert alle Datenräume aus einem Graph-Index (siehe export-index.js). */
export function extractDataRooms(index) {
  const rooms = [];
  for (const drive of index.drives ?? []) {
    const candidates = flattenFolders(drive.tree ?? [], "", []).filter((f) => isDataRoomName(f.name));
    candidates.sort((a, b) => a.path.length - b.path.length);
    const roots = [];
    for (const c of candidates) {
      if (!roots.some((r) => c.path === r.path || c.path.startsWith(`${r.path}/`))) roots.push(c);
    }
    for (const r of roots) {
      const segs = r.path.split("/").filter(Boolean);
      const project = segs[segs.length - 2] || drive.owner;
      const s = statsOf(r.node);
      const cats = categoryStatus(r.node);
      const matched = cats.filter((c) => c.present).length;
      rooms.push({
        id: `${slug(project)}--${slug(r.name)}-${_id++}`,
        name: r.name,
        project,
        owner: drive.owner,
        ownerUpn: drive.ownerUpn ?? null,
        kind: drive.kind,
        status: statusOf(r.path),
        path: r.path,
        webUrl: r.node.webUrl ?? null, // Quellen-Link zum Datenraum in SharePoint (CLAUDE.md §1/§3)
        files: s.files,
        folders: s.folders,
        bytes: s.bytes,
        modified: s.modified,
        fileTypes: Object.entries(s.types).sort((a, b) => b[1] - a[1]).slice(0, 6),
        schema: {
          matched,
          total: STANDARD_CATEGORIES.length,
          usesStandard: matched >= 3,
          categories: cats,
          missing: cats.filter((c) => !c.present).map((c) => `${c.num}_${c.label}`),
        },
      });
    }
  }
  rooms.sort((a, b) => b.files - a.files);
  return rooms;
}

/** Welcher Datenraum-Key (room.path) ist Präfix des geänderten Item-Pfads?
 *  roomPaths sind disjunkt/präfixfrei (extractDataRooms behält nur oberste Roots) → höchstens einer.
 *  Guard mit '/' verhindert, dass "/X/Datenraum_v3" fälschlich "/X/Datenraum_v3_alt" matcht. */
export function dataRoomKeyForChangedPath(changedPath, roomPaths) {
  if (!changedPath) return null;
  for (const key of roomPaths) {
    if (changedPath === key || changedPath.startsWith(`${key}/`)) return key;
  }
  return null;
}

/** Portfolio-Kennzahlen über alle Datenräume. */
export function summarizeDataRooms(rooms) {
  const byStatus = {};
  let files = 0, bytes = 0, schemaSum = 0, schemaN = 0;
  for (const r of rooms) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    files += r.files;
    bytes += r.bytes;
    if (r.schema.usesStandard) { schemaSum += r.schema.matched / r.schema.total; schemaN++; }
  }
  return {
    total: rooms.length,
    byStatus,
    files,
    bytes,
    avgCompleteness: schemaN ? Math.round((schemaSum / schemaN) * 100) : null,
  };
}
