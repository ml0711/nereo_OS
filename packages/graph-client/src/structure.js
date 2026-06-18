// "Business as Code": die Ordner→Funktion-Abbildung.
// Je nachdem WO in der gespiegelten SharePoint-Struktur man steht, gibt es eine andere
// View und andere Aktionen. Diese Datei ist die EINE deklarative Quelle dieser Logik.
// Rein datengetrieben — keine Express/Claude-Abhängigkeit. Reuse aus datarooms.js.
// Siehe ../../CLAUDE.md §1/§3.

import { STANDARD_CATEGORIES, isDataRoomName } from "./datarooms.js";

const SCHEMA_PREFIXES = new Set(STANDARD_CATEGORIES.map((c) => c.num)); // {"00".."16"}

// Kind-Ordnername → gültiges Schema-Präfix ("NN_"/"NN "/"NN-"), sonst null.
function categoryPrefixOf(name) {
  const m = /^(\d{2})[ _\-]/.exec(name || "");
  return m && SCHEMA_PREFIXES.has(m[1]) ? m[1] : null;
}

/**
 * Datenraum-Erkennung Signal B (Struktur): ≥3 verschiedene NN_-Kinder
 * (== usesStandard-Schwelle in datarooms.js). childFolderNames kommt gratis aus dem
 * listChildren, das der Resolver für die View ohnehin macht — kein zweiter Graph-Call.
 * ACHTUNG: greift bewusst NUR außerhalb der Projekt-/Unternehmens-Wurzeln (siehe Reihenfolge
 * der CAPABILITIES) — sonst würde der Projektordner 01_Projekte mit seinen Modul-Ordnern
 * (01_…,02_Modul…,03_…) fälschlich als Datenraum klassifiziert.
 */
export function hasDataRoomStructure(ctx) {
  if (ctx.isRoot) return false;
  const distinct = new Set();
  for (const n of ctx.childFolderNames ?? []) {
    const p = categoryPrefixOf(n);
    if (p) distinct.add(p);
  }
  return distinct.size >= 3;
}

/** Datenraum-Erkennung Signal A (Name), z. B. "Beispiel_Datenraum_v3". */
export function isDataRoomByName(ctx) {
  return !ctx.isRoot && isDataRoomName(ctx.name);
}

/** Kombiniert (für Tests/externe Nutzung): Datenraum per Name ODER per Struktur. */
export function looksLikeDataRoomLive(ctx) {
  return isDataRoomByName(ctx) || hasDataRoomStructure(ctx);
}

// Gemeinsame Datenraum-View (zweimal referenziert: per Name hoch, per Struktur niedrig priorisiert).
const DATAROOM = {
  id: "dataroom",
  label: "Datenraum",
  icon: "folder-check",
  view: "dataroom",
  actions: [
    { id: "analyze", label: "KI-Analyse", kind: "analyze", enabled: "always" },
    { id: "create-folder", label: "Kategorie anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true },
    { id: "upload", label: "Dokument hochladen", kind: "write", write: "upload", enabled: "writeEnabled", future: true },
  ],
  analysis: { strategy: "live-room", schema: "00-16" },
};

/**
 * ctx = { relPath, name, segments, depth, isRoot, childFolderNames }
 *   relPath: Pfad relativ zur WURZEL ("" = Wurzel selbst), ohne führenden Slash.
 *   childFolderNames: Namen der Unterordner an dieser Position (für Datenraum-Struktur-Erkennung).
 *
 * Reihenfolge ist bewusst (erste passende Regel gewinnt; `folder` ist garantierter Fallback):
 *   1. workspace-root  — die Wurzel selbst
 *   2. dataroom (Name) — explizit benannter Datenraum schlägt alles (auch innerhalb Projekte)
 *   3. projects        — die zwei Projekt-Wurzeln + ihr Teilbaum
 *   4. company         — 00_Unternehmen + Teilbaum
 *   5. dataroom (Struktur) — unbenannter, aber schema-strukturierter Datenraum AUSSERHALB 2–4
 *   6. folder          — generischer Fallback
 */
export const CAPABILITIES = [
  {
    id: "workspace-root",
    label: "Übersicht",
    icon: "home",
    view: "workspace-root",
    match: (c) => c.isRoot, // relPath === ""
    actions: [
      { id: "create-folder", label: "Bereich anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true },
    ],
    analysis: null,
  },
  { ...DATAROOM, match: (c) => isDataRoomByName(c) },
  {
    id: "projects",
    label: "Projekte",
    icon: "buildings",
    view: "projects",
    // Beide projektartigen Bäume (01_Projekte UND Projekte). Steht VOR dataroom-Struktur,
    // damit der Projekt-Wurzelordner nicht an der NN_-Heuristik hängenbleibt.
    match: (c) => /^(01_Projekte|Projekte)(\/|$)/i.test(c.relPath),
    actions: [
      { id: "analyze-project", label: "Projekt analysieren", kind: "analyze", enabled: "always" },
      { id: "create-folder", label: "Projekt/Ordner anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true },
    ],
    analysis: { strategy: "live-room", schema: "00-16" },
  },
  {
    id: "company",
    label: "Unternehmen",
    icon: "briefcase",
    view: "company",
    match: (c) => /^00_Unternehmen(\/|$)/i.test(c.relPath),
    actions: [
      { id: "create-folder", label: "Ordner anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true },
    ],
    analysis: null,
  },
  { ...DATAROOM, match: (c) => hasDataRoomStructure(c) },
  {
    id: "folder",
    label: "Ordner",
    icon: "folder",
    view: "folder",
    match: () => true, // garantierter Fallback — IMMER letzter
    actions: [
      { id: "create-folder", label: "Ordner anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true },
      { id: "upload", label: "Datei hochladen", kind: "write", write: "upload", enabled: "writeEnabled", future: true },
    ],
    analysis: null,
  },
];

/** Liefert die passende Capability für eine Position im Baum. */
export function resolveCapability(ctx) {
  return CAPABILITIES.find((c) => c.match(ctx)) ?? CAPABILITIES.at(-1);
}

/**
 * Serialisiert eine Capability für die API: entfernt die match-Funktion und löst
 * actions[].enabled zum realen Boolean auf.
 *  "always"        → immer true (z. B. KI-Analyse)
 *  "writeEnabled"  → nur wenn Schreibmacht freigeschaltet (Kill-Switch + Graph-Config ok)
 * `future:true` bleibt erhalten → UI zeigt "kommt bald", schaltet aber nichts scharf.
 */
export function serializeCapability(cap, { writeEnabled } = {}) {
  return {
    id: cap.id,
    label: cap.label,
    icon: cap.icon,
    view: cap.view,
    analysis: cap.analysis,
    actions: cap.actions.map((a) => ({
      ...a,
      enabled: a.enabled === "always" ? true : a.enabled === "writeEnabled" ? !!writeEnabled : false,
    })),
  };
}
