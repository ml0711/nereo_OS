// nereo OS — App-Service (Platzhalter)
// Verantwortung: Frontend ausliefern, Backend-API, KI-Agenten.
// Daten: liest SharePoint/Outlook via Microsoft Graph (read-only),
//        schreibt Analyse-Ergebnisse nach Supabase. Auth über LogTo.
// Siehe ../../CLAUDE.md

import { createServer } from "node:http";

const port = process.env.PORT || 3000;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ service: "nereo-os-app", status: "ok" }));
});

server.listen(port, () => {
  console.log(`nereo OS app listening on :${port}`);
});
