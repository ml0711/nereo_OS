// nereo OS — App-Service.
// Liefert das Portal-Frontend + JSON-API. Liest den Graph-Index (read-only,
// abgeleitete Metadaten) und stellt die Datenraum-Übersicht bereit.
// Siehe ../../CLAUDE.md §3.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractDataRooms, summarizeDataRooms } from "../../../packages/graph-client/src/datarooms.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "../../..");
const INDEX_PATH = resolve(ROOT, ".data/graph-index.json");
const port = process.env.PORT || 3000;

function send(res, status, type, body) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));

const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (url === "/healthz") return json(res, 200, { service: "nereo-os-app", status: "ok" });

    if (url === "/api/datarooms") {
      let index;
      try {
        index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
      } catch {
        return json(res, 503, { error: "Kein Graph-Index gefunden. Bitte 'npm run graph:export' ausführen." });
      }
      const rooms = extractDataRooms(index);
      return json(res, 200, {
        generatedAt: index.generatedAtMs,
        roles: index.roles,
        summary: summarizeDataRooms(rooms),
        rooms,
      });
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
