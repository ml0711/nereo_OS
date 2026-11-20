// Read-Only-Export der SharePoint-Ablage (Workspace-Wurzel aus workspace.js), jede Ebene.
// Schreibt einen Struktur-Index (Metadaten, KEINE Dateiinhalte).
//
// KANONISCHER Speicher = App-Postgres: ist DATABASE_URL gesetzt, schreibt der Export
// direkt via saveIndex() in die DB (die App liest DB-first). Die Datei
// .data/graph-index.json bleibt als lokaler Fallback/Debug-Artefakt erhalten.
//   node packages/graph-client/src/export-index.js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, createGraphClient } from "./index.js";
import { saveIndex } from "./index-store.js";
import { resolveRoot } from "./workspace.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function loadRepoEnv() {
  try {
    const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}

const gb = (b) => (b / 1e9).toFixed(2);
function summarize(nodes, acc = { files: 0, folders: 0, bytes: 0, deepest: 0 }, depth = 1) {
  for (const n of nodes) {
    if (n.type === "folder") {
      acc.folders++; acc.deepest = Math.max(acc.deepest, depth);
      if (n.children) summarize(n.children, acc, depth + 1);
    } else { acc.files++; acc.bytes += n.size; }
  }
  return acc;
}

async function main() {
  loadRepoEnv();
  const client = createGraphClient(graphConfigFromEnv());
  const t0 = process.hrtime.bigint();
  const index = { generatedAtMs: null, roles: await client.tokenRoles(), drives: [] };
  const grand = { files: 0, folders: 0, bytes: 0, drives: 0, apiDrives: [] };


  console.log("Roles:", index.roles.join(", "), "\n");

  console.log("SHAREPOINT-ABLAGE");
  const { root, reason } = await resolveRoot(client);
  if (!root) throw new Error(reason);
  process.stdout.write(`  … crawl ${root.name} `);
  const subtree = await client.walkDrive(root.driveId, { itemId: root.itemId, maxDepth: 30 });
  const s = summarize(subtree);
  index.drives.push({
    kind: "sharepoint", owner: root.name, ownerUpn: null, driveId: root.driveId, driveName: "Freigegebene Dokumente",
    webUrl: root.webUrl, summary: s, tree: [{ name: root.name, id: root.itemId, type: "folder", children: subtree }],
  });
  grand.files += s.files; grand.folders += s.folders; grand.bytes += s.bytes; grand.drives++;
  grand.apiDrives.push({ kind: "sharepoint", owner: root.name, driveName: "", ...s });
  console.log(`→ ${s.files} Dateien, ${s.folders} Ordner, ${gb(s.bytes)} GB (Tiefe ${s.deepest})`);

  index.generatedAtMs = Date.now();
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  index.summary = { ...grand };
  delete index.summary.apiDrives;

  mkdirSync(resolve(ROOT, ".data"), { recursive: true });
  const out = resolve(ROOT, ".data/graph-index.json");
  writeFileSync(out, JSON.stringify(index, null, 2));

  // Kanonisch in die App-Postgres schreiben (wenn erreichbar). Non-fatal:
  // ohne DB bleibt die Datei + späteres seed-index.js (Container) der Weg.
  if (process.env.DATABASE_URL) {
    try {
      await saveIndex(index);
      console.log(`  ✓ Index direkt nach App-Postgres geschrieben (generatedAtMs=${index.generatedAtMs}).`);
    } catch (e) {
      console.log(`  ⚠️ Postgres-Schreiben fehlgeschlagen (Datei bleibt Fallback): ${e.message}`);
    }
  } else {
    console.log("  · DATABASE_URL nicht gesetzt — nur Datei geschrieben (Container seedet später).");
  }

  console.log("\n══════════ GESAMT ══════════");
  grand.apiDrives.sort((a, b) => b.bytes - a.bytes);
  for (const d of grand.apiDrives.filter((d) => d.files || d.folders))
    console.log(`  ${d.kind.padEnd(10)} ${d.owner}${d.driveName && d.kind === "sharepoint" ? " › " + d.driveName : ""}: ${d.files} Dateien, ${gb(d.bytes)} GB`);
  console.log(`\n  Drives mit Inhalt: ${grand.apiDrives.filter((d) => d.files).length}/${grand.drives}`);
  console.log(`  Ordner: ${grand.folders} · Dateien: ${grand.files} · Volumen: ${gb(grand.bytes)} GB`);
  console.log(`  Dauer: ${secs.toFixed(1)}s · Index: .data/graph-index.json (${(JSON.stringify(index).length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
