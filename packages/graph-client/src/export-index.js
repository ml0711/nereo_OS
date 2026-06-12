// Vollständiger Read-Only-Export des gesamten lesbaren Bestands:
// alle User-OneDrives + alle SharePoint-Sites/Bibliotheken, jede Ebene.
// Schreibt einen Struktur-Index (Metadaten, KEINE Dateiinhalte) nach .data/graph-index.json
//   node packages/graph-client/src/export-index.js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, createGraphClient } from "./index.js";

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

  async function addDrive(kind, owner, ownerUpn, driveId, driveName, webUrl) {
    process.stdout.write(`  … crawl ${kind}: ${owner}${driveName ? " › " + driveName : ""} `);
    try {
      const tree = await client.walkDrive(driveId, { maxDepth: 30 });
      const s = summarize(tree);
      index.drives.push({ kind, owner, ownerUpn, driveId, driveName, webUrl, summary: s, tree });
      grand.files += s.files; grand.folders += s.folders; grand.bytes += s.bytes; grand.drives++;
      grand.apiDrives.push({ kind, owner, driveName, ...s });
      console.log(`→ ${s.files} Dateien, ${s.folders} Ordner, ${gb(s.bytes)} GB (Tiefe ${s.deepest})`);
    } catch (e) {
      console.log(`→ ⚠️ ${e.status ?? e.message}`);
    }
  }

  console.log("Roles:", index.roles.join(", "), "\n");

  console.log("USER-ONEDRIVES");
  const users = await client.listUsers();
  for (const u of users) {
    let drive;
    try { drive = await client.getUserDrive(u.userPrincipalName); }
    catch { console.log(`  – ${u.displayName}: kein OneDrive`); continue; }
    await addDrive("onedrive", u.displayName, u.userPrincipalName, drive.id, "Documents", drive.webUrl);
  }

  console.log("\nSHAREPOINT-SITES");
  const sites = await client.listSites("*");
  for (const site of sites) {
    let drives = [];
    try { drives = await client.listSiteDrives(site.id); } catch { continue; }
    for (const d of drives) {
      await addDrive("sharepoint", site.displayName, null, d.id, `${d.name} [${d.driveType}]`, d.webUrl);
    }
  }

  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  index.summary = { ...grand };
  delete index.summary.apiDrives;

  mkdirSync(resolve(ROOT, ".data"), { recursive: true });
  const out = resolve(ROOT, ".data/graph-index.json");
  writeFileSync(out, JSON.stringify(index, null, 2));

  console.log("\n══════════ GESAMT ══════════");
  grand.apiDrives.sort((a, b) => b.bytes - a.bytes);
  for (const d of grand.apiDrives.filter((d) => d.files || d.folders))
    console.log(`  ${d.kind.padEnd(10)} ${d.owner}${d.driveName && d.kind === "sharepoint" ? " › " + d.driveName : ""}: ${d.files} Dateien, ${gb(d.bytes)} GB`);
  console.log(`\n  Drives mit Inhalt: ${grand.apiDrives.filter((d) => d.files).length}/${grand.drives}`);
  console.log(`  Ordner: ${grand.folders} · Dateien: ${grand.files} · Volumen: ${gb(grand.bytes)} GB`);
  console.log(`  Dauer: ${secs.toFixed(1)}s · Index: .data/graph-index.json (${(JSON.stringify(index).length / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
