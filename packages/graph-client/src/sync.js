// Realtime-Sync-Orchestrierung (CLAUDE.md §3). Eine Notification/ein Poll-Tick triggert:
//   Delta-Query → Relevanz-Filter (nur Änderungen UNTER der Workspace-Wurzel) → bei Relevanz
//   gezielter Re-Walk des Workspace-Teilbaums → Index-Merge (andere Drives bleiben) → saveIndex
//   → betroffene Datenräume als „geändert" markieren → ERST DANN Delta-Token vorrücken.
// Re-Walk = Ground Truth → Doppel-/Out-of-Order-Notifications sind harmlos (idempotent).
// Die Notification ist NUR Trigger, nie Datenquelle.

import { saveIndex, loadLatestIndex, saveDeltaToken, markRoomChanged } from "./index-store.js";
import { extractDataRooms, dataRoomKeyForChangedPath } from "./datarooms.js";

const FULL_WALK_DEPTH = 30; // gleiche Tiefe wie export-index.js / live-room.js (sonst Untercount)

// Drive-relativer Pfad eines Delta-Items: parentReference.path = "/drives/{id}/root:/<rel>" (oder ".../root:").
function itemDrivePath(item) {
  const pr = item.parentReference?.path;
  if (!pr) return item.name ? `/${item.name}` : null; // root-nahe Items ohne expliziten Pfad
  const after = pr.split("root:")[1];
  if (after == null) return null;
  let parentRel;
  try { parentRel = decodeURIComponent(after); } // "" | "/Attachments" | "/nereo Development Partners/..."
  catch { parentRel = after; } // defekte %-Sequenz darf nicht den ganzen Sync-Lauf abbrechen (Prefilter)
  return `${parentRel}/${item.name}`.replace(/\/{2,}/g, "/");
}

// Liegt das geänderte Item unter der Workspace-Wurzel? (Delta läuft über die GANZE Drive —
// inkl. privater OneDrive-Bereiche; nur Änderungen unter rootName interessieren uns.)
function isUnderRoot(item, rootName) {
  if (item.name === rootName) return true; // der Workspace-Ordner selbst
  const p = itemDrivePath(item);
  if (!p) return false;
  return p === `/${rootName}` || p.startsWith(`/${rootName}/`);
}

function summarizeTree(nodes, acc = { files: 0, folders: 0, bytes: 0 }) {
  for (const n of nodes) {
    if (n.type === "folder") { acc.folders++; if (n.children) summarizeTree(n.children, acc); }
    else { acc.files++; acc.bytes += n.size || 0; }
  }
  return acc;
}

// Ersetzt im bestehenden Voll-Index NUR den Workspace-Teilbaum (Knoten == rootItemId/rootName)
// innerhalb der Workspace-Drive — andere Drives und der Rest der Drive bleiben unangetastet.
async function rebuildIndexWithSubtree({ driveId, rootName, rootItemId, subtree, generatedAtMs }) {
  const prev = (await loadLatestIndex()) || { roles: [], drives: [], summary: {} };
  const drives = (prev.drives || []).map((d) => ({ ...d }));
  const workspaceNode = { name: rootName, id: rootItemId, type: "folder", children: subtree };
  let drive = drives.find((d) => d.driveId === driveId);
  if (!drive) {
    drives.push({ kind: "onedrive", owner: rootName, ownerUpn: null, driveId, driveName: "Documents", webUrl: null, tree: [workspaceNode] });
  } else {
    const tree = Array.isArray(drive.tree) ? [...drive.tree] : [];
    const i = tree.findIndex((n) => n.id === rootItemId || n.name === rootName);
    if (i >= 0) tree[i] = { ...tree[i], ...workspaceNode };
    else tree.push(workspaceNode);
    drive.tree = tree;
    drive.summary = summarizeTree(drive.tree);
  }
  return { generatedAtMs, roles: prev.roles || [], drives, summary: prev.summary || {}, syncedAt: generatedAtMs, syncSource: "realtime-delta" };
}

/**
 * @param prevToken  Delta-Token aus der gespeicherten Subscription-Zeile (oder null/'' beim Erstlauf).
 * @param force      true → Voll-Resync (token=null).
 * @returns { changed, bootstrap?, affected, deltaToken, items }
 * WICHTIG: Reihenfolge saveIndex+markRoomChanged ZUERST, saveDeltaToken DANACH (Crash-Sicherheit).
 */
export async function deltaThenRewalkAndSave({ client, driveId, rootItemId, rootName, subscriptionId, prevToken = null, force = false }) {
  // Erstlauf ohne Token: nur Bootstrap-Token holen (kein Itemstrom, kein Re-Walk — Index ist aktuell aus dem Voll-Crawl).
  if (!prevToken && !force) {
    const { deltaToken } = await client.driveDelta(driveId, "latest");
    if (deltaToken) await saveDeltaToken(subscriptionId, deltaToken);
    return { changed: false, bootstrap: true, affected: [], deltaToken };
  }
  let fullResync = !!force;
  let delta;
  try {
    delta = await client.driveDelta(driveId, force ? null : prevToken);
  } catch (e) {
    // 410 Gone / resyncRequired → Token ungültig → Voll-Resync.
    const resync = e.status === 410 || /resync/i.test(JSON.stringify(e.body ?? ""));
    if (!resync) throw e;
    console.warn("[sync] Delta-Token ungültig → Full-Resync");
    fullResync = true;
    delta = await client.driveDelta(driveId, null);
  }
  const relevant = delta.items.filter((it) => isUnderRoot(it, rootName));
  // Re-Walk bei relevanten Änderungen ODER Full-Resync (Index muss aktuell werden); sonst nur Token.
  if (!relevant.length && !fullResync) {
    if (delta.deltaToken) await saveDeltaToken(subscriptionId, delta.deltaToken);
    return { changed: false, affected: [], deltaToken: delta.deltaToken };
  }
  // Gezielter Re-Walk des Workspace-Teilbaums → frischer Index (Merge, andere Drives bleiben).
  const subtree = await client.walkDrive(driveId, { itemId: rootItemId, maxDepth: FULL_WALK_DEPTH });
  const newIndex = await rebuildIndexWithSubtree({ driveId, rootName, rootItemId, subtree, generatedAtMs: Date.now() });
  await saveIndex(newIndex);
  // Staleness NUR bei echtem INKREMENTELLEM Delta markieren. Ein Full-Resync (Token-Ablauf) liefert ALLE
  // Items zurück und ist KEIN inhaltliches Änderungssignal — würde sonst sämtliche Analysen fälschlich
  // als veraltet markieren (unnötige KI-Token-Kosten). Index wird trotzdem aufgefrischt.
  let affected = [];
  if (!fullResync && relevant.length) {
    const roomPaths = extractDataRooms(newIndex).map((r) => r.path);
    const set = new Set();
    for (const it of relevant) {
      const key = dataRoomKeyForChangedPath(itemDrivePath(it), roomPaths);
      if (key) set.add(key);
    }
    // ts = ECHTE Änderungszeit (max lastModifiedDateTime der Items), nicht new Date(): so ist GREATEST
    // bei Replay (gleicher Token) ein No-op → ein bereits neu-analysierter Datenraum bleibt nicht-stale.
    const maxMod = relevant.reduce((mx, it) => Math.max(mx, it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) || 0 : 0), 0);
    const markTs = maxMod ? new Date(maxMod) : new Date();
    for (const key of set) await markRoomChanged(key, markTs);
    affected = [...set];
  }
  // ERST jetzt Token vorrücken (nach Index + Stale committet). Fehlt der Token, NICHT vorrücken + warnen.
  if (delta.deltaToken) await saveDeltaToken(subscriptionId, delta.deltaToken);
  else console.warn("[sync] driveDelta ohne deltaToken — Token rückt nicht vor (Replay-Risiko)", { driveId });
  return { changed: true, affected, deltaToken: delta.deltaToken, items: relevant.length, fullResync };
}
