// Testet den Wechsel der Wurzel auf eine ganze SharePoint-Bibliothek (ERFUNDENE ids, kein Microsoft).
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.WORKSPACE_ROOT_DRIVE_ID = "drive-sp";
process.env.WORKSPACE_ROOT_ITEM_ID = "root";
process.env.WORKSPACE_ROOT_FOLDER = "nereo Development Partners";
const { resolveRoot, clearRootCache } = await import("../src/workspace.js");
const { isUnderRoot } = await import("../src/sync.js");
const { retireOtherSubscriptions } = await import("../src/subscriptions.js");

test("Bibliothek als Wurzel: vertrauter Name, keine Person als Besitzer", async () => {
  clearRootCache();
  const client = { get: async (p) => { assert.match(p, /^\/drives\/drive-sp\/items\/root\?/); return { id: "01ROOTID", name: "root", root: {}, webUrl: "https://example.invalid/sites/x/Freigegebene%20Dokumente" }; } };
  const { root } = await resolveRoot(client, { force: true });
  assert.equal(root.itemId, "01ROOTID");
  assert.equal(root.name, "nereo Development Partners");
  assert.equal(root.isDriveRoot, true);
  assert.equal(root.owner, "SharePoint");
  assert.equal(root.ownerUpn, null);
});

test("Ordner als Wurzel (wie bisher in OneDrive): unverändert", async () => {
  clearRootCache();
  const client = { get: async () => ({ id: "01FOLDER", name: "nereo Development Partners", folder: {}, parentReference: { driveId: "drive-sp" } }) };
  const { root } = await resolveRoot(client, { force: true });
  assert.equal(root.isDriveRoot, false);
  assert.equal(root.name, "nereo Development Partners");
  clearRootCache();
});

test("Echtzeit: in der Bibliothek zählt jede Änderung, im Ordner-Modus nur darunter", () => {
  const inLib = { name: "Plan.pdf", parentReference: { path: "/drives/x/root:/nereo.development/04_Projekte" } };
  assert.equal(isUnderRoot(inLib, "nereo Development Partners", true), true);
  assert.equal(isUnderRoot(inLib, "nereo Development Partners", false), false, "alter Modus erwartet den Ordner im Pfad");
  const inFolder = { name: "Plan.pdf", parentReference: { path: "/drives/x/root:/nereo%20Development%20Partners/nereo.development" } };
  assert.equal(isUnderRoot(inFolder, "nereo Development Partners", false), true);
  assert.equal(isUnderRoot({ name: "Privat.docx", parentReference: { path: "/drives/x/root:/Anderes" } }, "nereo Development Partners", false), false);
});

test("Alte Überwachung auf dem früheren Speicherort wird beendet, die aktuelle bleibt", async () => {
  const graphDeleted = [], dbDeleted = [];
  const rows = [{ id: "alt", drive_id: "drive-onedrive" }, { id: "neu", drive_id: "drive-sp" }, { id: "ohne", drive_id: null }];
  const n = await retireOtherSubscriptions({
    client: { deleteSubscription: async (id) => { graphDeleted.push(id); if (id === "alt") throw new Error("schon weg"); } },
    keepDriveId: "drive-sp", list: async () => rows, remove: async (id) => dbDeleted.push(id),
  });
  assert.equal(n, 1);
  assert.deepEqual(graphDeleted, ["alt"]);
  assert.deepEqual(dbDeleted, ["alt"], "DB-Zeile wird auch entfernt, wenn Microsoft die Subscription schon verworfen hat");
  assert.equal(await retireOtherSubscriptions({ client: {}, keepDriveId: null, list: async () => rows, remove: async () => {} }), 0);
});
