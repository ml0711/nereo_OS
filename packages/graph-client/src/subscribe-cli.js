// CLI: Graph-Subscription für die Workspace-Drive anlegen/erneuern (Realtime-Sync).
// Primärer Renew-Weg als Coolify Scheduled Task (täglich) + manuelles Bootstrap nach Deploy.
//   node packages/graph-client/src/subscribe-cli.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, createGraphClient } from "./index.js";
import { resolveRoot } from "./workspace.js";
import { reconcileSubscription } from "./subscriptions.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function loadEnv() {
  try {
    for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}

async function main() {
  loadEnv();
  const base = (process.env.APP_BASE_URL || "https://app.nereo-os.de").replace(/\/$/, "");
  const notificationUrl = `${base}/api/graph/webhook`;
  const client = createGraphClient(graphConfigFromEnv());
  const { root, reason } = await resolveRoot(client);
  if (!root) { console.error("✗ Wurzel nicht auflösbar:", reason); process.exit(1); }
  console.log(`Reconcile Subscription für Drive …${root.driveId.slice(-8)} → ${notificationUrl}`);
  const r = await reconcileSubscription({ client, driveId: root.driveId, notificationUrl });
  console.log(`✓ ${r.action} · id=${r.id} · gültig bis ${r.expiration}`);
}
main().catch((e) => { console.error("✗", e.status ?? "", e.message, JSON.stringify(e.body ?? "")); process.exit(1); });
