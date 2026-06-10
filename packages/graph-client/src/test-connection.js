// Verbindungstest für die Microsoft-Graph-Anbindung (read-only).
// Holt ein App-Token und liest SharePoint-Sites.
//   node packages/graph-client/src/test-connection.js
// Lädt .env aus dem Repo-Root (ohne dotenv-Dependency).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, getAppToken, createGraphClient } from "./index.js";

function loadRepoEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const raw = readFileSync(resolve(root, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* keine .env — dann müssen die Variablen anders gesetzt sein */
  }
}

async function main() {
  loadRepoEnv();
  const cfg = graphConfigFromEnv();
  console.log(`→ Tenant ${cfg.tenantId}`);
  console.log(`→ Client ${cfg.clientId}`);

  console.log("\n[1/2] App-Token holen …");
  let token;
  try {
    token = await getAppToken(cfg);
    console.log(`    ✅ Token erhalten (gültig ${token.expiresIn}s).`);
  } catch (err) {
    console.error(`    ❌ ${err.message}`);
    if (err.aadError) console.error(`       AAD-Error: ${err.aadError}`);
    if (err.body) console.error(`       Body: ${err.body}`);
    if (err.status === 404) {
      console.error(
        "\n    ⚠️  HTTP 404 vom Login-Endpoint = bekannter Netzwerk-Blocker:\n" +
          "       Dieser Host erreicht login.microsoftonline.com nicht (Azure-AD-Edge\n" +
          "       liefert 404), obwohl Graph erreichbar ist. Login-Traffic muss über\n" +
          "       einen gesunden Netzwerkpfad laufen, bevor dieser Test durchläuft."
      );
    }
    process.exit(1);
  }

  console.log("\n[2/2] SharePoint-Sites lesen (read-only) …");
  const client = createGraphClient(cfg);
  try {
    const sites = await client.listSites("*");
    const list = sites.value ?? [];
    console.log(`    ✅ ${list.length} Site(s) sichtbar:`);
    for (const s of list.slice(0, 10)) {
      console.log(`       • ${s.displayName ?? s.name} — ${s.webUrl}`);
    }
    if (!list.length) {
      console.log(
        "    ℹ️  0 Sites — vermutlich fehlt noch Admin-Consent für die\n" +
          "       Application-Permission (Sites.Selected / Sites.Read.All)."
      );
    }
  } catch (err) {
    console.error(`    ❌ ${err.message}`);
    console.error(`       ${JSON.stringify(err.body)?.slice(0, 600)}`);
    if (err.status === 403) {
      console.error(
        "\n    ⚠️  403 = Token ok, aber keine Berechtigung. Application-Permission\n" +
          "       (Sites.Selected empfohlen) + Admin-Consent im Azure-Portal nötig."
      );
    }
    process.exit(2);
  }

  console.log("\n✅ Graph-Verbindung funktioniert.");
}

main().catch((e) => {
  console.error("Unerwarteter Fehler:", e);
  process.exit(99);
});
