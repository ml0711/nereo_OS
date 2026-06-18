// Baut on-demand aus der LIVE-Struktur (Graph) ein `room`-Objekt in exakt der Form, die
// extractDataRooms() liefert — damit analyzeDataRoom() unverändert darauf läuft und die
// gespeicherte Analyse denselben Schlüssel (dataroom_key = room.path) trägt wie der
// index-basierte Pfad. So sind Live-Analyse und gecachte Analyse bit-genau kompatibel.
// Reuse von statsOf/categoryStatus/statusOf aus datarooms.js (kein Fork der Logik).

import { STANDARD_CATEGORIES, statsOf, categoryStatus, statusOf } from "./datarooms.js";

/**
 * @param client  Graph-Client
 * @param opts.driveId  Drive der Wurzel (server-fixiert)
 * @param opts.itemId   itemId des Datenraum-Ordners (server-aufgelöst, im Workspace)
 * @param opts.relPath  Pfad relativ zur Wurzel (z. B. "Beispiel_Datenraum_v3")
 * @param opts.rootName Name der Workspace-Wurzel (für drive-relativen Pfad == cached key)
 * @param opts.name     Anzeigename des Datenraums
 * @param opts.owner    Owner-Anzeige (Workspace-Owner)
 * @returns room-Objekt kompatibel mit analyzeDataRoom() / saveAnalysis()
 */
export async function buildLiveRoom(client, { driveId, itemId, relPath, rootName, name, owner }) {
  // WICHTIG: gleiche Tiefe wie der gecachte Crawl (export-index.js: maxDepth 30), sonst
  // werden tief verschachtelte Datenräume untergezählt (files/bytes/Kategorie-Counts) und
  // die Live-Analyse würde unter demselben dataroom_key die korrekte Cache-Analyse mit zu
  // niedrigen Zahlen überschreiben. 30 liegt klar über der real beobachteten Tiefe.
  const tree = await client.walkDrive(driveId, { itemId, maxDepth: 30 });
  const rootNode = { children: tree };

  const s = statsOf(rootNode);
  const cats = categoryStatus(rootNode);
  const matched = cats.filter((c) => c.present).length;

  // Drive-relativer Pfad == dataroom_key, den extractDataRooms erzeugen würde.
  const drivePath = `/${rootName}/${relPath}`.replace(/\/+$/, "");
  const segs = drivePath.split("/").filter(Boolean);

  return {
    name,
    project: segs[segs.length - 2] || rootName,
    owner: owner ?? rootName,
    status: statusOf(drivePath),
    path: drivePath,
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
  };
}
