// CLI: Delta-Poll-Sicherheitsnetz (Realtime-Sync). Holt Änderungen seit dem gespeicherten
// Delta-Token und aktualisiert Index + Analyse-Staleness — UNABHÄNGIG vom Webhook. Konvergiert
// auch bei totem Webhook. Als Coolify Scheduled Task alle 15–30 min.
//   node packages/graph-client/src/sync-cli.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, createGraphClient } from "./index.js";
import { resolveRoot } from "./workspace.js";
import { claimSubscriptionForSync, finishProcessing } from "./index-store.js";
import { deltaThenRewalkAndSave } from "./sync.js";

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
  const client = createGraphClient(graphConfigFromEnv());
  const { root, reason } = await resolveRoot(client);
  if (!root) { console.error("✗ Wurzel nicht auflösbar:", reason); process.exit(1); }
  // Lease nehmen (auch ohne dirty) → schließt den Cross-Prozess-Race mit dem Webhook-Pfad aus.
  // null = keine Subscription-Zeile ODER der Webhook/ein anderer Poll hält gerade das Lease.
  const claimed = await claimSubscriptionForSync(root.driveId);
  if (!claimed) {
    console.log("· kein Lease (Webhook/anderer Poll aktiv) oder keine Subscription-Zeile (erst 'graph:subscribe') — übersprungen.");
    process.exit(0);
  }
  try {
    const r = await deltaThenRewalkAndSave({
      client, driveId: root.driveId, rootItemId: root.itemId, rootName: root.name,
      subscriptionId: claimed.id, prevToken: claimed.delta_token,
    });
    console.log(`✓ sync: ${r.bootstrap ? "bootstrap-token" : r.changed ? `${r.items} Änderung(en), ${r.affected.length} Datenraum/-räume markiert` : "keine relevanten Änderungen"}`);
  } finally {
    await finishProcessing(claimed.id, { lastSyncAt: new Date() }); // Lease IMMER lösen
  }
}
main().catch((e) => { console.error("✗", e.status ?? "", e.message, JSON.stringify(e.body ?? "")); process.exit(1); });
