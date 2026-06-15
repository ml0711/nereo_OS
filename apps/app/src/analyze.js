// KI-Agent: Datenraum-Analyse (CLAUDE.md §3 — "Was fehlt? / Risiken / Unstimmigkeiten").
// Läuft serverseitig über die Claude API (pay-per-token). Modell per ENV (Default: Haiku 4.5 = günstig).
// Arbeitet NUR auf Ordnerstruktur + Metadaten (read-only, keine Dateiinhalte).
// `@anthropic-ai/sdk` wird LAZY geladen, damit der Server auch ohne Key/SDK startet.
import { STANDARD_CATEGORIES, extractDataRooms } from "../../../packages/graph-client/src/datarooms.js";
import { loadLatestIndex, loadAnalyses, saveAnalysis } from "../../../packages/graph-client/src/index-store.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

let client;
async function getClient() {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY nicht gesetzt");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  client = new Anthropic(); // liest ANTHROPIC_API_KEY aus der Umgebung
  return client;
}

const SCHEMA_TEXT = STANDARD_CATEGORIES.map((c) => `${c.num} ${c.label}`).join("\n");

const SYSTEM = `Du bist ein erfahrener Analyst für Immobilien-Datenräume (Real-Estate Due Diligence) bei nereo.
Du prüfst die VOLLSTÄNDIGKEIT eines Datenraums gegen das Standard-Schema 00–16 und identifizierst Lücken, Risiken und strukturelle Unstimmigkeiten — ausschließlich aus Ordnerstruktur + Metadaten (du siehst KEINE Dateiinhalte).

Standard-Kategorien:
${SCHEMA_TEXT}

Regeln:
- Antworte auf Deutsch, knapp und fachlich.
- Kern-Kategorien (01 Asset-Overview, 03 Grundstück, 04 Baurecht, 05 Technik, 07 Mietverträge, 12 Finanzierung) sind bei Fehlen "kritisch".
- Vorhandene, aber LEERE Kategorien (Ordner da, 0 Dateien) sind Unstimmigkeiten.
- "Vorlage"/"Beispiel"/"Dropped"-Datenräume bewertest du nachsichtiger (Hinweis statt Risiko).
- completeness_score 0–100 = fachliche Gesamteinschätzung (nicht nur die reine Trefferquote).`;

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    completeness_score: { type: "integer" },
    critical_gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string" },
          importance: { type: "string", enum: ["kritisch", "wichtig", "optional"] },
          note: { type: "string" },
        },
        required: ["category", "importance", "note"],
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["hoch", "mittel", "niedrig"] },
          detail: { type: "string" },
        },
        required: ["title", "severity", "detail"],
      },
    },
    inconsistencies: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["completeness_score", "critical_gaps", "risks", "inconsistencies", "summary"],
};

export async function analyzeDataRoom(room) {
  const cats = room.schema.categories
    .map((c) => `${c.num} ${c.label}: ${c.present ? `vorhanden (${c.files} Dateien)` : "FEHLT"}`)
    .join("\n");
  const user = `Datenraum: ${room.name}
Projekt: ${room.project} · Status: ${room.status} · Owner: ${room.owner}
Umfang: ${room.files} Dateien, ${room.folders} Ordner, ${(room.bytes / 1e9).toFixed(2)} GB
Top-Dateitypen: ${(room.fileTypes || []).map(([e, n]) => `${e}:${n}`).join(", ") || "—"}
Schema-Treffer: ${room.schema.matched}/${room.schema.total}

Kategorien:
${cats}`;

  const cl = await getClient();
  const resp = await cl.messages.create({
    model: MODEL,
    max_tokens: 1500,
    // System-Prompt als eigener Block markiert. Hinweis: cache_control greift erst, wenn der
    // stabile Präfix das Modell-Minimum überschreitet (Haiku 4.5 = 4096 Tokens) — der aktuelle
    // SYSTEM-Prompt liegt darunter, der Breakpoint ist also (noch) wirkungslos. Bewusst belassen:
    // sobald SYSTEM wächst (mehr Schema/Beispiele), greift Caching ohne weitere Änderung.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    // Strukturierte Ausgabe -> garantiert valides JSON nach ANALYSIS_SCHEMA.
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });

  // stop_reason VOR dem Parsen prüfen: bei "refusal" ist content leer, bei "max_tokens"
  // ist das JSON abgeschnitten — beides würde JSON.parse mit kryptischem Fehler werfen.
  if (resp.stop_reason === "refusal")
    throw new Error("KI hat die Analyse abgelehnt (stop_reason=refusal).");
  if (resp.stop_reason === "max_tokens")
    throw new Error("KI-Antwort abgeschnitten (max_tokens) — Datenraum zu groß für 1500 Tokens.");

  const text = (resp.content.find((b) => b.type === "text") || {}).text || "{}";
  const analysis = JSON.parse(text);
  return {
    ...analysis,
    model: MODEL,
    usage: {
      input: resp.usage?.input_tokens ?? null,
      output: resp.usage?.output_tokens ?? null,
      cacheRead: resp.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

/** Analysiert alle (oder nur noch nicht analysierten) Datenräume und speichert sie in der DB. */
export async function analyzeMissing({ force = false } = {}) {
  const index = await loadLatestIndex();
  if (!index) return { error: "Kein Graph-Index in der DB. Erst graph:export + Seed." };
  const rooms = extractDataRooms(index);
  const existing = force ? {} : await loadAnalyses().catch(() => ({}));
  const result = { total: rooms.length, analyzed: 0, skipped: 0, failed: 0, tokens: { input: 0, output: 0 }, items: [] };
  for (const room of rooms) {
    if (existing[room.path]) { result.skipped++; continue; }
    try {
      const a = await analyzeDataRoom(room);
      await saveAnalysis(room, a);
      result.analyzed++;
      result.tokens.input += a.usage?.input || 0;
      result.tokens.output += a.usage?.output || 0;
      result.items.push({ name: room.name, project: room.project, score: a.completeness_score, gaps: a.critical_gaps?.length || 0, risks: a.risks?.length || 0 });
    } catch (e) {
      result.failed++;
      result.items.push({ name: room.name, project: room.project, error: e.message });
    }
  }
  return result;
}

/** EINEN Datenraum (per stabilem Pfad) gezielt analysieren — on-demand, kein Bulk. */
export async function analyzeOne(path) {
  const index = await loadLatestIndex();
  if (!index) return { error: "Kein Graph-Index in der DB." };
  const room = extractDataRooms(index).find((r) => r.path === path);
  if (!room) return { error: "Datenraum nicht gefunden." };
  try {
    const a = await analyzeDataRoom(room);
    await saveAnalysis(room, a);
    return { analyzed: 1, failed: 0, room: room.name, project: room.project, score: a.completeness_score, tokens: a.usage };
  } catch (e) {
    return { analyzed: 0, failed: 1, room: room.name, error: e.message };
  }
}

/** Alle Datenräume EINES Projekts analysieren — on-demand, scoped. force=alle neu, sonst nur fehlende. */
export async function analyzeProject(project, { force = false } = {}) {
  const index = await loadLatestIndex();
  if (!index) return { error: "Kein Graph-Index in der DB." };
  const rooms = extractDataRooms(index).filter((r) => r.project === project);
  if (!rooms.length) return { error: "Projekt nicht gefunden." };
  const existing = force ? {} : await loadAnalyses().catch(() => ({}));
  const r = { project, total: rooms.length, analyzed: 0, skipped: 0, failed: 0, tokens: { input: 0, output: 0 }, items: [] };
  for (const room of rooms) {
    if (existing[room.path]) { r.skipped++; continue; }
    try {
      const a = await analyzeDataRoom(room);
      await saveAnalysis(room, a);
      r.analyzed++; r.tokens.input += a.usage?.input || 0; r.tokens.output += a.usage?.output || 0;
      r.items.push({ name: room.name, score: a.completeness_score });
    } catch (e) { r.failed++; r.items.push({ name: room.name, error: e.message }); }
  }
  return r;
}
