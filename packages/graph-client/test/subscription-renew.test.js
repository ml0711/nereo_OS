// Testet das Verlängern der Echtzeit-Überwachung mit ERFUNDENEN Daten (kein Microsoft, keine DB).
import { test } from "node:test";
import assert from "node:assert/strict";
const { reconcileSubscription } = await import("../src/subscriptions.js");

const soon = () => new Date(Date.now() + 3600 * 1000).toISOString(); // läuft in 1 h ab → Verlängern fällig
function setup(renewError) {
  const rows = new Map([["drive-sp", { id: "alt", drive_id: "drive-sp", expiration: soon(), notification_url: "https://app/x", delta_token: "TOKEN-1" }]]);
  const log = [];
  const client = {
    renewSubscription: async (id) => { log.push("renew " + id); if (renewError) throw Object.assign(new Error("x"), { status: renewError }); return { expirationDateTime: "2099-01-01T00:00:00Z" }; },
    deleteSubscription: async (id) => { log.push("delete " + id); },
    createSubscription: async () => { log.push("create"); return { id: "neu", expirationDateTime: "2099-01-01T00:00:00Z" }; },
    driveDelta: async () => { throw new Error("darf nicht nötig sein: Token wird übernommen"); },
  };
  const saved = [];
  const store = {
    loadSubscriptionByDrive: async (d) => rows.get(d) ?? null,
    saveSubscription: async (r) => saved.push(r),
    updateExpiration: async () => {},
    deleteSubscription: async (id) => log.push("row-delete " + id),
  };
  return { client, store, log, saved };
}

test("Verlängern klappt: einfach verlängern", async () => {
  const { client, store, log } = setup(null);
  const r = await reconcileSubscription({ client, driveId: "drive-sp", notificationUrl: "https://app/x", store });
  assert.equal(r.action, "renewed");
  assert.deepEqual(log, ["renew alt"]);
});

for (const status of [401, 403, 404]) {
  test(`Verlängern abgelehnt (${status}): neu anlegen, Änderungs-Token bleibt erhalten`, async () => {
    const { client, store, log, saved } = setup(status);
    const r = await reconcileSubscription({ client, driveId: "drive-sp", notificationUrl: "https://app/x", store });
    assert.equal(r.action, "recreated");
    assert.equal(r.id, "neu");
    assert.ok(log.includes("row-delete alt") && log.includes("create"));
    assert.equal(saved[0].deltaToken, "TOKEN-1", "keine Änderung im Übergang geht verloren");
  });
}

test("Andere Fehler (z. B. Microsoft kurz weg) werden nicht verschluckt", async () => {
  const { client, store } = setup(503);
  await assert.rejects(reconcileSubscription({ client, driveId: "drive-sp", notificationUrl: "https://app/x", store }), (e) => e.status === 503);
});
