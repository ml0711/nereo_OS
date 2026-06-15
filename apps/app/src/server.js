// nereo OS — App-Service.
// Liefert das Portal-Frontend + JSON-API. Liest den Graph-Index (read-only,
// abgeleitete Metadaten) aus der App-Postgres; Fallback auf die Bind-Mount-Datei.
// KI-Datenraum-Analysen kommen aus der DB; ein geschützter Endpoint triggert sie.
// Siehe ../../CLAUDE.md §2/§3.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractDataRooms, summarizeDataRooms } from "../../../packages/graph-client/src/datarooms.js";
import { loadLatestIndex, loadAnalyses } from "../../../packages/graph-client/src/index-store.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../../..");
const INDEX_PATH = resolve(ROOT, ".data/graph-index.json");
const port = process.env.PORT || 3000;

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));

// Graph-Index: zuerst aus Postgres, sonst Bind-Mount-Datei.
async function loadIndex() {
  if (process.env.DATABASE_URL) {
    try {
      const idx = await loadLatestIndex();
      if (idx) return { index: idx, source: "postgres" };
    } catch (e) {
      console.error("Postgres-Index nicht lesbar, Fallback Datei:", e.message);
    }
  }
  try {
    return { index: JSON.parse(readFileSync(INDEX_PATH, "utf8")), source: "file" };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const full = new URL(req.url || "/", "http://localhost");
  const url = full.pathname;
  try {
    if (url === "/healthz") return json(res, 200, { service: "nereo-os-app", status: "ok" });

    if (url === "/api/datarooms") {
      const loaded = await loadIndex();
      if (!loaded) return json(res, 503, { error: "Kein Graph-Index (Postgres leer + keine Datei). 'graph:export' + Seed nötig." });
      const { index, source } = loaded;
      const rooms = extractDataRooms(index);
      let analyses = {};
      try { analyses = await loadAnalyses(); } catch (e) { console.error("Analysen nicht lesbar:", e.message); }
      return json(res, 200, {
        source,
        generatedAt: index.generatedAtMs,
        roles: index.roles,
        summary: summarizeDataRooms(rooms),
        analyzed: Object.keys(analyses).length,
        rooms: rooms.map((r) => ({ ...r, analysis: analyses[r.path] || null })),
      });
    }

    // KI-Analyse triggern (geschützt, idempotent — analysiert nur fehlende, ?force=1 für alle).
    if (url === "/api/datarooms/analyze") {
      const secret = process.env.ANALYZE_TRIGGER_SECRET;
      if (!secret || full.searchParams.get("key") !== secret) return json(res, 403, { error: "forbidden" });
      const { analyzeMissing } = await import("./analyze.js");
      const result = await analyzeMissing({ force: full.searchParams.get("force") === "1" });
      return json(res, 200, result);
    }

    if (url === "/" || url === "/index.html") {
      return send(res, 200, "text/html; charset=utf-8", readFileSync(resolve(__dir, "public/dashboard.html"), "utf8"));
    }

    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(port, () => console.log(`nereo OS app listening on :${port}`));
