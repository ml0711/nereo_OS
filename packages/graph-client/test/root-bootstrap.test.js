// Testet die Auflösung der Ablage OHNE gepinnte ids: nur über die SharePoint-Seite, nie über ein OneDrive.
// Eigene Datei, weil ROOT_CONFIG beim Import aus der Umgebung gelesen wird (node --test = eigener Prozess je Datei).
import { test } from "node:test";
import assert from "node:assert/strict";
delete process.env.WORKSPACE_ROOT_DRIVE_ID;
delete process.env.WORKSPACE_ROOT_ITEM_ID;
process.env.WORKSPACE_ROOT_SITE = "example.sharepoint.com:/sites/datenraum";
process.env.WORKSPACE_ROOT_FOLDER = "nereo Development Partners";
const { resolveRoot, clearRootCache } = await import("../src/workspace.js");

const noOneDrive = { getUserDrive: () => { throw new Error("OneDrive darf nie gefragt werden"); } };

test("Ohne Pin: Ablage über die SharePoint-Seite", async () => {
  clearRootCache();
  const calls = [];
  const client = {
    ...noOneDrive,
    getSite: async (host, path) => { calls.push(`site ${host}${path}`); return { id: "site-1" }; },
    get: async (p) => { calls.push(p.split("?")[0]); return p.startsWith("/sites/") ? { id: "drive-1" } : { id: "01ROOT", name: "root", root: {}, webUrl: "https://example/x" }; },
  };
  const { root } = await resolveRoot(client, { force: true });
  assert.deepEqual(calls, ["site example.sharepoint.com/sites/datenraum", "/sites/site-1/drive", "/drives/drive-1/root"]);
  assert.equal(root.driveId, "drive-1");
  assert.equal(root.name, "nereo Development Partners");
  assert.equal(root.isDriveRoot, true);
});

test("Seite nicht lesbar: klare Meldung, kein Rückfall auf OneDrive", async () => {
  clearRootCache();
  const client = { ...noOneDrive, getSite: async () => { throw Object.assign(new Error("x"), { status: 401 }); }, get: async () => { throw new Error("nie"); } };
  const r = await resolveRoot(client, { force: true });
  assert.equal(r.root, null);
  assert.match(r.reason, /SharePoint-Ablage nicht erreichbar \(401\)/);
  assert.match(r.reason, /Leserechte/);
  assert.doesNotMatch(r.reason, /OneDrive/);
});
