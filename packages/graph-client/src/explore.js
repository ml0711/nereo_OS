// Exploriert read-only, was mit den aktuellen Graph-Permissions sichtbar ist:
// SharePoint-Sites → Drives (Dokumentbibliotheken) → Ordner/Dateien (Baum, 2 Ebenen).
// Plus Grenztest: persönliches OneDrive der User.
//   node packages/graph-client/src/explore.js
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

const fmt = (it) =>
  it.folder
    ? `📁 ${it.name}/  (${it.folder.childCount ?? "?"} Elemente)`
    : `📄 ${it.name}  (${(it.size ?? 0) / 1024 | 0} KB)`;

async function listChildren(client, driveId, itemId, indent, depth) {
  if (depth <= 0) return;
  let res;
  try {
    const base = itemId
      ? `/drives/${driveId}/items/${itemId}/children`
      : `/drives/${driveId}/root/children`;
    res = await client.get(`${base}?$select=id,name,folder,file,size&$top=50`);
  } catch (e) {
    console.log(`${indent}⚠️  ${e.message}`);
    return;
  }
  for (const it of res.value ?? []) {
    console.log(`${indent}${fmt(it)}`);
    if (it.folder && it.folder.childCount > 0) {
      await listChildren(client, driveId, it.id, indent + "   ", depth - 1);
    }
  }
}

async function main() {
  loadRepoEnv();
  const client = createGraphClient(graphConfigFromEnv());

  console.log("══════════ SharePoint-Sites ══════════");
  const sites = (await client.get("/sites?search=*")).value ?? [];
  for (const s of sites) {
    console.log(`\n● ${s.displayName ?? s.name}  —  ${s.webUrl}`);
    let drives = [];
    try {
      drives = (await client.get(`/sites/${s.id}/drives?$select=id,name,driveType`)).value ?? [];
    } catch (e) {
      console.log(`   ⚠️ Drives: ${e.message}`);
    }
    for (const d of drives) console.log(`   💾 Drive "${d.name}" [${d.driveType}]  id=${d.id.slice(-12)}`);
  }

  // Ordnerbaum der "richtigen" Sites (URL mit /sites/) zeigen
  const realSites = sites.filter((s) => /\/sites\//.test(s.webUrl) || s.webUrl.endsWith("sharepoint.com"));
  console.log("\n\n══════════ Ordner-/Datei-Baum (2 Ebenen) ══════════");
  for (const s of realSites.slice(0, 4)) {
    let drives = [];
    try {
      drives = (await client.get(`/sites/${s.id}/drives?$select=id,name`)).value ?? [];
    } catch { continue; }
    for (const d of drives.slice(0, 1)) {
      console.log(`\n▼ ${s.displayName} › ${d.name}`);
      await listChildren(client, d.id, null, "   ", 2);
    }
  }

  // Grenztest: persönliches OneDrive der User
  console.log("\n\n══════════ Grenztest: persönliches OneDrive ══════════");
  try {
    const users = (await client.get("/users?$select=displayName,userPrincipalName&$top=5")).value ?? [];
    console.log(`✅ User-Liste lesbar (${users.length}):`);
    for (const u of users) console.log(`   • ${u.displayName} <${u.userPrincipalName}>`);
    if (users[0]) {
      try {
        const od = await client.get(`/users/${users[0].userPrincipalName}/drive/root/children?$select=name,folder,file&$top=20`);
        console.log(`✅ OneDrive von ${users[0].displayName}:`);
        for (const it of od.value ?? []) console.log(`   ${fmt(it)}`);
      } catch (e) {
        console.log(`❌ OneDrive-Inhalt: ${e.message} → braucht Files.Read.All`);
      }
    }
  } catch (e) {
    console.log(`❌ User-Liste: ${e.message} → braucht User.Read.All (Application)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
