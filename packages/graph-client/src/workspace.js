// Auflösung der EINEN fixen Workspace-Wurzel. Quelle aller Dateien ist die SharePoint-Seite
// „nereo.datenraum“ (seit 2026-11-20); ihre Bibliothek „Freigegebene Dokumente“ IST die Wurzel
// (Aufbau: nereo.Group, nereo.development, _KONVENTIONEN.md, _ANALYSEKATALOG.md …).
// Die Sidebar und alle Navigation gehen von ihren Kindern aus. Siehe ../../CLAUDE.md §3.
// Es gibt bewusst KEINEN Rückfall auf ein persönliches OneDrive: ist die Seite nicht lesbar,
// meldet die App das, statt still alte oder private Daten zu zeigen.

// EINE Quelle des Speicherorts — ENV-überschreibbar (Umzug = Konfig-Änderung, kein Code-Eingriff).
export const ROOT_CONFIG = {
  // Bevorzugt: direkt gepinnte ids (stabil). ITEM_ID=root bzw. weggelassen = ganze Bibliothek.
  driveId: process.env.WORKSPACE_ROOT_DRIVE_ID || null,
  itemId: process.env.WORKSPACE_ROOT_ITEM_ID || (process.env.WORKSPACE_ROOT_DRIVE_ID ? "root" : null),
  // Ohne Pin: SharePoint-Seite als "host:/sites/name" → deren Standard-Bibliothek.
  site: process.env.WORKSPACE_ROOT_SITE || "nereo.sharepoint.com:/sites/nereo.datenraum",
  // Anzeigename der Wurzel (Microsoft nennt eine Bibliothek intern nur „root“).
  folder: process.env.WORKSPACE_ROOT_FOLDER || "nereo Development Partners",
};

// Kleiner Helfer: kommagetrennte ENV-Liste → Array (oder null, wenn nicht/leer gesetzt).
function splitEnvList(v) {
  if (v == null || String(v).trim() === "") return null;
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

// ===================================================================
// DATENORT-POLICY (Bauregel §2/§3, CLAUDE.md §3). EINE zentrale Stelle für
// (a) die sichtbaren Gesellschaften und (b) die Ausschlüsse. ALLES ENV-überschreibbar,
// damit der spätere Umzug auf eigene SharePoint-Teamsites (eine je Gesellschaft) und
// jede Ausschluss-Anpassung eine reine Konfig-Änderung bleibt — kein Code-Eingriff.
// ===================================================================

// (a) Sichtbare Gesellschaften an der WURZEL, in Anzeige-Reihenfolge. Alles andere auf
//     Wurzelebene (z. B. "Projekte_alt", "_VORLAGE_Gesellschaft") wird NICHT angezeigt —
//     das ist eine Erlaubnisliste, kein Ausschluss. `site` ist der Platzhalter für den
//     Umzug auf eine eigene Teamsite je Gesellschaft: dann nur die Site-ID hier eintragen
//     (heute wird über `name` der Unterordner unter der Wurzel gefunden).
export const COMPANY_CONFIG = (splitEnvList(process.env.WORKSPACE_COMPANIES) ?? [
  "nereo.Group",
  "nereo.development",
]).map((name) => ({ key: companyKey(name), name, site: null }));

// Stabile, sonderzeichen-freie Kennung je Gesellschaft (für Adressen / späteren Site-Bezug).
function companyKey(name) {
  return String(name).toLowerCase().replace(/^nereo\./, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// (b) Ausschlüsse — gelten AUSNAHMSLOS an jeder Lesestelle (Navigation, Suche, Zählungen,
//     Index/Sync, KI-Aufrufe). `prefixes` = "Name beginnt mit …" (inkl. allem darunter),
//     `exact` = exakter ganzer Name. Case-insensitiv (SharePoint ist case-preserving).
export const EXCLUDE_CONFIG = {
  prefixes: splitEnvList(process.env.WORKSPACE_EXCLUDE_PREFIXES) ?? ["90_Personal", "_ZU_LOESCHEN"],
  exact: splitEnvList(process.env.WORKSPACE_EXCLUDE_EXACT) ?? [".DS_Store"],
};

/** true, wenn ein Ordner-/Dateiname NIE ausgeliefert werden darf (Bauregel §3). */
export function isExcluded(name) {
  const low = String(name ?? "").toLowerCase();
  if (!low) return false;
  for (const p of EXCLUDE_CONFIG.prefixes) if (low.startsWith(p.toLowerCase())) return true;
  for (const e of EXCLUDE_CONFIG.exact) if (low === e.toLowerCase()) return true;
  return false;
}

/** Entfernt ausgeschlossene Einträge aus einer Knoten-/Item-Liste (matcht `.name`). */
export function filterExcluded(items) {
  return (items ?? []).filter((it) => !isExcluded(it?.name));
}

/**
 * Wählt aus den WURZEL-Kindern NUR die konfigurierten Gesellschaften, in Config-Reihenfolge,
 * und wirft ausgeschlossene Namen weg. Rückgabe: [{ node, company }] — nicht gefundene
 * Gesellschaften werden übersprungen (kein Crash; die UI zeigt dann eben weniger).
 * Match case-insensitiv (SharePoint/OneDrive: case-preserving, case-insensitive).
 */
export function pickCompanies(rootChildren) {
  const byName = new Map();
  for (const k of rootChildren ?? []) {
    if (!k?.folder || isExcluded(k.name)) continue;
    byName.set(String(k.name).toLowerCase(), k);
  }
  const out = [];
  for (const company of COMPANY_CONFIG) {
    const node = byName.get(company.name.toLowerCase());
    if (node) out.push({ node, company });
  }
  return out;
}

const CACHE_TTL_MS = 6 * 3600 * 1000; // driveId/itemId sind effektiv immutabel
let _root = null; // { driveId, itemId, name, isDriveRoot, webUrl, owner, resolvedAt }
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
 *   2) SharePoint-Seite (WORKSPACE_ROOT_SITE) → Standard-Bibliothek → deren Wurzel.
 *   3) Sonst { root:null, reason } — KEIN Rückfall auf OneDrive.
 * Ergebnis wird 6h gecacht (force=true erzwingt Neuauflösung).
 *
 * @returns {Promise<{ root: object|null, reason?: string, candidates?: Array }>}
 */
export async function resolveRoot(client, { force = false } = {}) {
  if (!force && _root && Date.now() - _root.resolvedAt < CACHE_TTL_MS) return { root: _root };
  // In-Flight-Guard: parallele Erst-Zugriffe teilen EINE Auflösung.
  if (!force && _pending) return _pending;
  const p = _resolveRoot(client);
  if (!force) _pending = p;
  try { return await p; } finally { if (_pending === p) _pending = null; }
}

const ITEM_SELECT = "?$select=id,name,webUrl,folder,parentReference,root";

function toRoot(driveId, item) {
  // Wurzel = ganze Bibliothek: Microsoft nennt sie „root“ → vertrauter Name aus WORKSPACE_ROOT_FOLDER,
  // und der Sync zählt dann jede Änderung in der Bibliothek.
  const isDriveRoot = Boolean(item.root);
  return {
    driveId,
    itemId: item.id,
    name: isDriveRoot ? ROOT_CONFIG.folder : item.name,
    isDriveRoot,
    webUrl: item.webUrl ?? null,
    owner: "SharePoint",
    resolvedAt: Date.now(),
  };
}

async function _resolveRoot(client) {
  let lastStatus = null;
  // 1) ENV-Pin: stabil und schnell.
  if (ROOT_CONFIG.driveId && ROOT_CONFIG.itemId) {
    try {
      const item = await client.get(`/drives/${ROOT_CONFIG.driveId}/items/${ROOT_CONFIG.itemId}${ITEM_SELECT}`);
      _root = toRoot(ROOT_CONFIG.driveId, item);
      return { root: _root };
    } catch (e) {
      lastStatus = e.status ?? e.message;
      console.error("[workspace] ENV-Pin nicht lesbar:", lastStatus);
    }
  }
  // 2) Über die SharePoint-Seite (z. B. wenn kein Pin gesetzt ist).
  const m = String(ROOT_CONFIG.site || "").match(/^([^:/]+):(\/sites\/[^/?#]+)$/);
  if (m) {
    try {
      const site = await client.getSite(m[1], m[2]);
      const drive = await client.get(`/sites/${site.id}/drive?$select=id`);
      const item = await client.get(`/drives/${drive.id}/root${ITEM_SELECT}`);
      _root = toRoot(drive.id, item);
      console.log(`[workspace] Wurzel über SharePoint-Seite aufgelöst — zum Pinnen: WORKSPACE_ROOT_DRIVE_ID=${drive.id}, WORKSPACE_ROOT_ITEM_ID=root`);
      return { root: _root };
    } catch (e) {
      lastStatus = e.status ?? e.message;
      console.error("[workspace] SharePoint-Seite nicht lesbar:", lastStatus);
    }
  }
  // 3) Klare Meldung statt Rückfall.
  const hint = lastStatus === 401 || lastStatus === 403
    ? "Der App fehlen Leserechte in Azure (nereo_os: Files.Read.All + Sites.Read.All, Typ Anwendung)."
    : "WORKSPACE_ROOT_DRIVE_ID/WORKSPACE_ROOT_SITE prüfen.";
  return { root: null, reason: `SharePoint-Ablage nicht erreichbar (${lastStatus ?? "keine Einstellung"}). ${hint}`, candidates: [] };
}

/** Verwirft den Cache (z. B. nach ENV-Änderung). */
export function clearRootCache() {
  _root = null;
  _pending = null;
}
