// Auflösung der EINEN fixen Workspace-Wurzel ("nereo Development GmbH" / real:
// "nereo Development Partners"). Diese Wurzel ist der Ausgangspunkt der gesamten App —
// die Sidebar und alle Navigation gehen von ihren Kindern aus. Siehe ../../CLAUDE.md §1.
//
// WICHTIG: Die Wurzel ist NICHT der Drive-Root. Der OneDrive von kienle@nereo.ch enthält
// auch Privates (Anlagen, nereo Group AG, Notebooks …). Wir lösen gezielt auf die itemId
// des Ordners "nereo Development Partners" auf und starten ab dessen Kindern.

// EINE Quelle des Wurzel-Namens — ENV-überschreibbar, damit der Umzug (anderer Ordner,
// später eine SharePoint-Site) eine reine Konfig-Änderung ist, kein Code-Eingriff.
export const ROOT_CONFIG = {
  // Bevorzugt: direkt gepinnte ids (stabil, sonderzeichen-immun, überleben Umbenennung).
  driveId: process.env.WORKSPACE_ROOT_DRIVE_ID || null,
  itemId: process.env.WORKSPACE_ROOT_ITEM_ID || null,
  // Bootstrap-Fallback: über OneDrive-Owner + Ordnername auflösen (einmalig, dann pinnen).
  ownerUpn: process.env.WORKSPACE_ROOT_UPN || "kienle@nereo.ch",
  folder: process.env.WORKSPACE_ROOT_FOLDER || "nereo Development Partners",
};

const CACHE_TTL_MS = 6 * 3600 * 1000; // driveId/itemId sind effektiv immutabel
let _root = null; // { driveId, itemId, name, webUrl, owner, ownerUpn, resolvedAt }
let _pending = null; // laufende Auflösung (In-Flight-Guard gegen parallele Erst-Zugriffe)

/**
 * Normalisiert + sichert einen relativen Pfad (gegen Path-Traversal).
 * Liefert ein Array von Segmenten relativ zur Wurzel. Wirft bei "..", absoluten Pfaden etc.
 */
export function safeRelSegments(relPath) {
  if (relPath == null || relPath === "") return [];
  const raw = Array.isArray(relPath) ? relPath : String(relPath).split("/");
  const segs = raw.map((s) => String(s).trim()).filter((s) => s.length > 0);
  for (const s of segs) {
    if (s === "." || s === "..") throw new Error("Ungültiger Pfad (Traversal nicht erlaubt).");
  }
  if (segs.length > 40) throw new Error("Pfad zu tief."); // begrenzt den Descent-Aufwand
  return segs;
}

/**
 * Löst die fixe Wurzel auf. Reihenfolge:
 *   1) ENV-Pin (driveId+itemId) → 1 Verifikations-Call.
 *   2) Bootstrap: Owner-OneDrive + Ordnername per Pfad-Adressierung.
 *   3) Diagnostische Degradation: { root:null, reason, candidates } statt Crash.
 * Ergebnis wird 6h gecacht (force=true erzwingt Neuauflösung).
 *
 * @returns {Promise<{ root: object|null, reason?: string, candidates?: Array }>}
 */
export async function resolveRoot(client, { force = false } = {}) {
  if (!force && _root && Date.now() - _root.resolvedAt < CACHE_TTL_MS) return { root: _root };
  // In-Flight-Guard: parallele Erst-Zugriffe (Boot: /api/workspace + /api/fs gleichzeitig)
  // teilen EINE Auflösung statt jeweils die volle Graph-Kette zu durchlaufen.
  if (!force && _pending) return _pending;
  const p = _resolveRoot(client);
  if (!force) _pending = p;
  try { return await p; } finally { if (_pending === p) _pending = null; }
}

async function _resolveRoot(client) {
  // 1) ENV-Pin: stabil und schnell.
  if (ROOT_CONFIG.driveId && ROOT_CONFIG.itemId) {
    try {
      const item = await client.get(
        `/drives/${ROOT_CONFIG.driveId}/items/${ROOT_CONFIG.itemId}` +
          `?$select=id,name,webUrl,folder,parentReference`
      );
      _root = {
        driveId: ROOT_CONFIG.driveId,
        itemId: item.id,
        name: item.name,
        webUrl: item.webUrl ?? null,
        owner: item.parentReference?.driveId ? ROOT_CONFIG.ownerUpn : ROOT_CONFIG.ownerUpn,
        ownerUpn: ROOT_CONFIG.ownerUpn,
        resolvedAt: Date.now(),
      };
      return { root: _root };
    } catch (e) {
      // Gepinnte ids ungültig → weiter zum Bootstrap statt hart zu scheitern.
      console.error("[workspace] ENV-Pin ungültig, Bootstrap:", e.status ?? e.message);
    }
  }

  // 2) Bootstrap über Owner-OneDrive + Ordnername.
  let drive;
  try {
    drive = await client.getUserDrive(ROOT_CONFIG.ownerUpn);
  } catch (e) {
    return { root: null, reason: `OneDrive von ${ROOT_CONFIG.ownerUpn} nicht lesbar (${e.status ?? e.message}).` };
  }
  try {
    const item = await client.itemByPath(drive.id, ROOT_CONFIG.folder);
    _root = {
      driveId: drive.id,
      itemId: item.id,
      name: item.name,
      webUrl: item.webUrl ?? null,
      owner: ROOT_CONFIG.ownerUpn,
      ownerUpn: ROOT_CONFIG.ownerUpn,
      resolvedAt: Date.now(),
    };
    // Hinweis fürs Pinnen in ENV (macht Resolution stabil + unabhängig vom Ordnernamen).
    console.log(
      `[workspace] Wurzel aufgelöst: "${item.name}" — zum Pinnen setzen:\n` +
        `   WORKSPACE_ROOT_DRIVE_ID=${drive.id}\n   WORKSPACE_ROOT_ITEM_ID=${item.id}`
    );
    return { root: _root };
  } catch (e) {
    // 3) Degradation: Ordner nicht gefunden → Kandidaten anbieten, nicht crashen.
    let candidates = [];
    try {
      const top = await client.listChildren(drive.id, null);
      candidates = top
        .filter((n) => n.folder && /nereo/i.test(n.name))
        .map((n) => ({ name: n.name, itemId: n.id }));
    } catch {}
    return {
      root: null,
      reason:
        `Wurzel-Ordner "${ROOT_CONFIG.folder}" im OneDrive von ${ROOT_CONFIG.ownerUpn} nicht gefunden ` +
        `(${e.status ?? e.message}). WORKSPACE_ROOT_FOLDER prüfen oder ids pinnen.`,
      candidates,
    };
  }
}

/** Verwirft den Cache (z. B. nach ENV-Änderung). */
export function clearRootCache() {
  _root = null;
  _pending = null;
}
