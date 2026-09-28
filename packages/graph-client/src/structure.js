// "Business as Code": die Ordner→Funktion-Abbildung.
// Je nachdem WO in der gespiegelten SharePoint-Struktur man steht, gibt es eine andere
// View und ein anderes Etikett. Diese Datei ist die EINE deklarative Quelle dieser Logik.
// Rein datengetrieben — keine Express/Claude-Abhängigkeit. Siehe ../../CLAUDE.md §3.
//
// Struktur (Stand 2026-09, aus _KONVENTIONEN.md / _ANALYSEKATALOG.md in der Ablage —
// gelesen, nicht abgeschrieben, Bauregel §9):
//   Wurzel → Gesellschaft (nereo.Group / nereo.development)
//     → 01_Unternehmen · 02_Finanzen · 03_Assets · 04_Projekte · 99_Archiv
//   04_Projekte → Projekt (JJJJ-NNN_Kuerzel_Stadt)
//     → 00_Steuerung · 01_Datenraum · 02_Analysen · 03_Konzept · 04_Baurecht_Verfahren · …
//   02_Analysen → A00–A17 (Analysekatalog).
//
// WICHTIG: Die KI-Analyse ist hier bewusst PAUSIERT (keine `analyze`-Aktion). Die Umstellung
// der Analyse-Logik vom alten Datenraum-Schema 00–16 auf den Projekt-Analysekatalog A00–A17
// ist ein eigener, separat geplanter Schritt (Schritt B). Bis dahin ist die Navigation
// reine Ansicht: richtige Etiketten je Ebene, keine Analyse.

// Schreibaktionen: sichtbar als "kommt bald", schalten nichts scharf (Schreibmacht ist
// abgesichert, kein Auto-Write — CLAUDE.md §2). `future:true` → UI zeigt sie deaktiviert.
const CREATE_FOLDER = { id: "create-folder", label: "Ordner anlegen", kind: "write", write: "folder", enabled: "writeEnabled", future: true };
const UPLOAD = { id: "upload", label: "Datei hochladen", kind: "write", write: "upload", enabled: "writeEnabled", future: true };

// Erkennung am AKTUELLEN Ordnernamen (c.name = wo man steht). Sonderzeichen-immun und
// unabhängig vom Gesellschafts-Präfix im Pfad (die Ebene "Gesellschaft" liegt davor).
// Namens-Regeln aus der EINEN Stelle (naming.js) — nicht hier doppelt.
import { isProjectFolder, analysisCodeOf } from "./naming.js";
const isProjectId = (name) => isProjectFolder(name); // JJJJ-NNN_Kuerzel_Stadt
const isAnalysisId = (name) => !!analysisCodeOf(name); // A08_Nutzung_Varianten
const nameIs = (re) => (c) => re.test(c.name || "");

/**
 * ctx = { relPath, name, segments, depth, isRoot, childFolderNames }
 *   name  : Name des Ordners, in dem man steht (bzw. der Sidebar-Eintrag).
 *   depth : Anzahl Pfadsegmente ab Wurzel (eine Gesellschaft liegt bei depth === 1).
 *
 * Reihenfolge ist bewusst (erste passende Regel gewinnt; `folder` ist garantierter Fallback):
 *   1. workspace-root  — die Wurzel selbst
 *   2. projekt         — ein einzelnes Projekt (JJJJ-NNN_…); schlägt die Bereichsnamen
 *   3. analyse         — ein einzelner Analyseordner (A00–A17)
 *   4.–10. Bereichsordner per exaktem Namen (Unternehmen/Finanzen/Assets/Projekte/Analysen/Datenraum/Archiv)
 *   11. gesellschaft   — Top-Level-Ordner unter der Wurzel (eine Gesellschaft)
 *   12. folder         — generischer Fallback (immer letzter)
 */
export const CAPABILITIES = [
  { id: "workspace-root", label: "Übersicht", icon: "home", view: "workspace-root",
    match: (c) => c.isRoot, actions: [CREATE_FOLDER], analysis: null },

  { id: "projekt", label: "Projekt", icon: "folder-check", view: "projekt",
    match: (c) => isProjectId(c.name), actions: [CREATE_FOLDER], analysis: null },

  { id: "analyse", label: "Analyse", icon: "sparkle", view: "analyse",
    match: (c) => isAnalysisId(c.name), actions: [CREATE_FOLDER, UPLOAD], analysis: null },

  { id: "unternehmen", label: "Unternehmen", icon: "briefcase", view: "unternehmen",
    match: nameIs(/^01_Unternehmen$/i), actions: [CREATE_FOLDER], analysis: null },

  { id: "finanzen", label: "Finanzen", icon: "coins", view: "finanzen",
    match: nameIs(/^02_Finanzen$/i), actions: [CREATE_FOLDER], analysis: null },

  { id: "assets", label: "Assets", icon: "buildings", view: "assets",
    match: nameIs(/^03_Assets$/i), actions: [CREATE_FOLDER], analysis: null },

  { id: "projekte", label: "Projekte", icon: "buildings", view: "projekte",
    match: nameIs(/^04_Projekte$/i), actions: [CREATE_FOLDER], analysis: null },

  { id: "analysen", label: "Analysen", icon: "sparkles", view: "analysen",
    match: nameIs(/^02_Analysen$/i), actions: [CREATE_FOLDER, UPLOAD], analysis: null },

  { id: "datenraum", label: "Datenraum", icon: "folder", view: "datenraum",
    match: nameIs(/^01_Datenraum$/i), actions: [CREATE_FOLDER, UPLOAD], analysis: null },

  { id: "archiv", label: "Archiv", icon: "archive", view: "archiv",
    match: nameIs(/^99_Archiv$/i), actions: [CREATE_FOLDER], analysis: null },

  { id: "gesellschaft", label: "Gesellschaft", icon: "building", view: "gesellschaft",
    match: (c) => c.depth === 1, actions: [CREATE_FOLDER], analysis: null },

  { id: "folder", label: "Ordner", icon: "folder", view: "folder",
    match: () => true, actions: [CREATE_FOLDER, UPLOAD], analysis: null },
];

/** Liefert die passende Capability für eine Position im Baum. */
export function resolveCapability(ctx) {
  return CAPABILITIES.find((c) => c.match(ctx)) ?? CAPABILITIES.at(-1);
}

/**
 * Serialisiert eine Capability für die API: entfernt die match-Funktion und löst
 * actions[].enabled zum realen Boolean auf.
 *  "always"        → immer true
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
