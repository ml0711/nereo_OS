// Die EINE Stelle für das Zerlegen von Ordner- und Dateinamen (Bauregel §2/§9, CLAUDE.md §3).
// Alles, was einen nereo-Namen interpretiert — Projekt-ID, A-Kennung, Dokumenttyp, Dokumentdatum,
// die tolerante Suchform — steht hier und NUR hier, damit Suche, Projektübersicht und späteres
// Dashboard dieselben Regeln nutzen. Rein + testbar (keine Graph-Abhängigkeit), bis auf loadDocTypes().
//
// Grundlage: _KONVENTIONEN.md in der Ablage (v3.4) — §1 (Projekt-ID) und §5 (Dateiname + Dokumenttypen).
// Die Dokumenttyp-Tabelle wird LIVE aus dieser Datei gelesen (loadDocTypes), nicht abgeschrieben (§9).

// ---------- Projekt-ID (§1) ----------

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

// ---------- A-Kennung (Analysekatalog A00–A17) ----------

/** Kennung ("A08") aus einem ANALYSE-ORDNERnamen ("A08_Nutzung_Varianten" oder bloß "A08"); sonst null. */
export function analysisCodeOf(name) {
  const m = /^(A\d{2})(?=[ _]|$)/.exec(name || "");
  return m ? m[1] : null;
}

// ---------- Dokumentdatum (§5: führendes ISO-Datum = Dokumentdatum, nicht Ablagedatum) ----------

/** Dokumentdatum aus dem Dateinamen: führendes JJJJ-MM-TT, sonst null. */
export function docDateFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?=[_ .]|$)/.exec(name || "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------- Tolerante Suchform ----------

/**
 * Faltet einen Text auf eine vergleichbare Form: klein, Umlaute/ß aufgelöst (ä→ae, ö→oe, ü→ue, ß→ss),
 * Trenner (Leerzeichen, - _ . / \) entfernt. So findet "Foerdermittel" auch "Fördermittel" und
 * "Teltow" auch "teltow"; Bindestriche/Unterstriche sind egal. Wird auf Suchbegriff UND Ziel angewandt.
 */
export function foldSearch(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[\s\-_./\\]+/g, "");
}

// ---------- Dokumenttypen (§5-Tabelle) ----------

/**
 * Parst die Dokumenttyp-Tabellen aus §5 von _KONVENTIONEN.md. Kürzel stehen dort in `Backticks`
 * (AN, AB, RE, GS, Vertrag, Analyse, Konzept, BWA, Praesentation …). Nur Tabellenzeilen im §5-Block,
 * nur reine Buchstaben-Kürzel (so fallen Beispiel-Dateinamen und die Muster-Zeile heraus).
 * "Plan" ist laut §5 ausdrücklich KEIN Dokumenttyp und wird entfernt. Rein — testbar ohne Graph.
 * @returns {Map<string,string>} kleingeschrieben → Original-Schreibweise
 */
export function parseDocTypes(md) {
  const lines = String(md ?? "").split("\n");
  const i0 = lines.findIndex((l) => /^##\s*5\b/.test(l) && /dateiname/i.test(l));
  const map = new Map();
  if (i0 < 0) return map;
  for (let i = i0 + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // nächster Abschnitt → §5 zu Ende
    if (!lines[i].includes("|")) continue; // nur Tabellenzeilen
    for (const m of lines[i].matchAll(/`([^`]+)`/g)) {
      const tok = m[1].trim();
      if (/^[A-Za-zÄÖÜäöü]{2,}$/.test(tok)) map.set(tok.toLowerCase(), tok);
    }
  }
  map.delete("plan"); // §5: „Plan" ist KEIN Dokumenttyp (heißt Planunterlage / Roadmap)
  return map;
}

let _docTypes = null; // { map, loadedAt }
const DOCTYPES_TTL_MS = 60 * 60 * 1000; // 1 h — Konventionen ändern sich selten

/** Lädt + cached die Dokumenttyp-Tabelle aus _KONVENTIONEN.md an der Workspace-Wurzel.
 *  Degradiert leer (kein Crash), wenn die Datei fehlt/nicht lesbar ist. */
export async function loadDocTypes(client, root, { force = false } = {}) {
  if (!force && _docTypes && Date.now() - _docTypes.loadedAt < DOCTYPES_TTL_MS) return _docTypes.map;
  let map = new Map();
  try {
    const f = await client.childByName(root.driveId, root.itemId, "_KONVENTIONEN.md");
    if (f && !f.folder) {
      const buf = await client.downloadItem(root.driveId, f.id);
      map = parseDocTypes(buf.toString("utf8"));
    }
  } catch (e) {
    console.error("[naming] _KONVENTIONEN.md nicht lesbar:", e.status ?? e.message);
  }
  _docTypes = { map, loadedAt: Date.now() };
  return map;
}

/** Verwirft den Dokumenttyp-Cache (z. B. nach Konventions-Änderung). */
export function clearDocTypesCache() { _docTypes = null; }

// ---------- Dateiname zerlegen (§5) ----------

/**
 * Zerlegt einen Dateinamen nach dem Muster
 *   JJJJ-MM-TT_<Projekt-ID>_<Dokumenttyp>_<Kurz>_v<NN>.<ext>
 * (das Projekt-ID-Feld darf fehlen, z. B. "2026-08-31_BWA_nereo-development_v01.pdf").
 *
 * `docTypes` = Map aus loadDocTypes(); ein Dokumenttyp wird NUR gesetzt, wenn er in dieser
 * §5-Tabelle steht. Die A-Kennung wird zusätzlich aus dem Dateinamen gelesen (Analyse-Ergebnisse
 * tragen sie im <Kurz>-Teil, z. B. "…_Analyse_A08_Varianten_v01.pdf").
 *
 * `patternOk` (= „Muster erkannt: ja", Definition von Mike bestätigt): führendes ISO-Datum UND
 * bekannter Dokumenttyp UND Version `v<NN>` als letztes Feld.
 *
 * @returns {{docDate,projektId,docType,aCode,version,ext,patternOk}}
 */
export function parseFileName(name, { docTypes } = {}) {
  const raw = String(name ?? "");
  const dot = raw.lastIndexOf(".");
  const hasExt = dot > 0 && dot < raw.length - 1;
  const ext = hasExt ? raw.slice(dot + 1).toLowerCase() : null;
  const base = hasExt ? raw.slice(0, dot) : raw;
  const tokens = base.split(/[_ ]+/).filter(Boolean);

  const docDate = docDateFromName(raw);

  // Version = letztes Feld "v" + genau zwei Ziffern (v01, v02 …).
  const last = tokens[tokens.length - 1] || "";
  const version = /^v\d{2}$/i.test(last) ? last.toLowerCase() : null;

  // Feld-Position: [Datum] [Projekt-ID?] [Dokumenttyp?] …
  let j = 0;
  if (tokens[j] && /^\d{4}-\d{2}-\d{2}$/.test(tokens[j])) j++;
  let projektId = null;
  if (tokens[j] && /^\d{4}-\d{3}$/.test(tokens[j])) { projektId = tokens[j]; j++; }

  let docType = null;
  if (docTypes && tokens[j]) docType = docTypes.get(tokens[j].toLowerCase()) || null;

  // A-Kennung: irgendein Token "A" + zwei Ziffern (steht meist direkt hinter dem Dokumenttyp).
  let aCode = null;
  for (const t of tokens) { if (/^A\d{2}$/i.test(t)) { aCode = t.toUpperCase(); break; } }

  return { docDate, projektId, docType, aCode, version, ext, patternOk: !!docDate && !!docType && !!version };
}
