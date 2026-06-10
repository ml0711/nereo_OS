// Vollständiger Read-Only-Crawl: zeigt, was Graph aktuell hergibt.
// Token-Roles → User → deren OneDrives → SharePoint-Sites/Drives → Strukturbäume + Summen.
// Degradiert sauber, wenn eine Permission fehlt.
//   node packages/graph-client/src/crawl.js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { graphConfigFromEnv, createGraphClient } from "./index.js";

function loadRepoEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const raw = readFileSync(resolve(root, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {}
}

const KNOWN_FALLBACK_UPNS = ["letzgus@nereo.ch"]; // falls User.Read.All fehlt

const gb = (b) => (b / 1e9).toFixed(2);
const kb = (b) => `${(b / 1024) | 0} KB`;

function printTree(nodes, indent = "   ", max = 40) {
  let shown = 0;
  for (const n of nodes) {
    if (shown++ >= max) { console.log(`${indent}… (+${nodes.length - max} weitere)`); break; }
    console.log(`${indent}${n.type === "folder" ? "📁 " + n.name + "/" : "📄 " + n.name + "  " + kb(n.size)}`);
    if (n.children?.length) printTree(n.children, indent + "   ", max);
  }
}

function summarize(nodes, acc = { files: 0, folders: 0, bytes: 0 }) {
  for (const n of nodes) {
    if (n.type === "folder") { acc.folders++; if (n.children) summarize(n.children, acc); }
    else { acc.files++; acc.bytes += n.size; }
  }
  return acc;
}

async function crawlDrive(client, label, driveId) {
  try {
    const tree = await client.walkDrive(driveId, { maxDepth: 6 });
    const s = summarize(tree);
    console.log(`\n▼ ${label}  —  ${s.files} Dateien, ${s.folders} Ordner, ${gb(s.bytes)} GB`);
    printTree(tree);
    return s;
  } catch (e) {
    console.log(`\n▼ ${label}  —  ⚠️ ${e.message}`);
    return { files: 0, folders: 0, bytes: 0 };
  }
}

async function main() {
  loadRepoEnv();
  const client = createGraphClient(graphConfigFromEnv());
  const total = { files: 0, folders: 0, bytes: 0, drives: 0 };

  console.log("Consented App-Roles:", (await client.tokenRoles()).join(", ") || "(keine)");

  // ── User + OneDrives ──
  console.log("\n══════════ User & OneDrives ══════════");
  let users = [];
  try {
    users = await client.listUsers();
    console.log(`✅ ${users.length} User im Tenant.`);
  } catch (e) {
    console.log(`⚠️ User-Liste: ${e.message} → Fallback auf bekannte UPNs (${KNOWN_FALLBACK_UPNS.join(", ")})`);
    users = KNOWN_FALLBACK_UPNS.map((upn) => ({ userPrincipalName: upn, displayName: upn }));
  }
  for (const u of users) {
    let drive;
    try {
      drive = await client.getUserDrive(u.userPrincipalName);
    } catch (e) {
      console.log(`\n● ${u.displayName}: kein OneDrive (${e.status})`);
      continue;
    }
    const s = await crawlDrive(client, `OneDrive · ${u.displayName}`, drive.id);
    total.files += s.files; total.folders += s.folders; total.bytes += s.bytes; total.drives++;
  }

  // ── SharePoint-Sites ──
  console.log("\n\n══════════ SharePoint-Sites & Bibliotheken ══════════");
  const sites = await client.listSites("*");
  for (const site of sites) {
    let drives = [];
    try { drives = await client.listSiteDrives(site.id); } catch (e) {
      console.log(`\n● ${site.displayName}: ⚠️ ${e.status}`); continue;
    }
    if (!drives.length) continue;
    console.log(`\n● ${site.displayName} (${site.webUrl})`);
    for (const d of drives) {
      const s = await crawlDrive(client, `${site.displayName} › ${d.name} [${d.driveType}]`, d.id);
      total.files += s.files; total.folders += s.folders; total.bytes += s.bytes; total.drives++;
    }
  }

  console.log("\n\n══════════ GESAMT ══════════");
  console.log(`Drives: ${total.drives} · Ordner: ${total.folders} · Dateien: ${total.files} · Volumen: ${gb(total.bytes)} GB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
