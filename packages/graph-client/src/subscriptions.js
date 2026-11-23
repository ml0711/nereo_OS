// Subscription-Lifecycle-Reconciler (Realtime-Sync, CLAUDE.md §3). Idempotent gegen den
// Soll-Zustand "genau 1 gültige Graph-Subscription auf der Workspace-Drive". Create/Renew/Recreate.
// Subscriptions sind Graph-Metadaten (Notification-Plumbing) → read-only-Scope genügt, kein Write-Consent.

import { randomBytes } from "node:crypto";
import {
  loadSubscriptionByDrive, saveSubscription, updateExpiration, loadActiveSubscriptions,
  deleteSubscription as storeDeleteSubscription,
} from "./index-store.js";

const LIFETIME_MIN = Number(process.env.GRAPH_SUB_LIFETIME_MIN) || 10080;     // 7 Tage (konservativ < ~30d-Max)
const RENEW_BEFORE_MIN = Number(process.env.GRAPH_SUB_RENEW_BEFORE_MIN) || 2880; // 2 Tage Puffer

const expISO = (minFromNow) => new Date(Date.now() + minFromNow * 60000).toISOString();

/**
 * Gleicht die Drive-Subscription gegen den Soll-Zustand ab.
 * @returns { action: 'created'|'renewed'|'recreated'|'noop', id, expiration }
 */
export async function reconcileSubscription({ client, driveId, notificationUrl, store = {} }) {
  // store: nur für Tests austauschbar (Standard = App-Postgres).
  const { loadSubscriptionByDrive: loadByDrive = loadSubscriptionByDrive, saveSubscription: save = saveSubscription,
    updateExpiration: updateExp = updateExpiration, deleteSubscription: removeRow = storeDeleteSubscription } = store;
  const resource = `/drives/${driveId}/root`;
  const existing = await loadByDrive(driveId);

  // carryDeltaToken: der drive-RESOURCE-Delta-Token ist unabhängig von der Subscription-Lebensdauer und
  // bleibt nach einem Recreate gültig — übernehmen, sonst nimmt der nächste Sync den Bootstrap-Pfad
  // (kein Re-Walk, kein markRoomChanged) und alle Änderungen im Expired-Fenster gehen still verloren.
  const create = async (carryDeltaToken = null) => {
    const clientState = randomBytes(32).toString("base64url");
    const expirationDateTime = expISO(LIFETIME_MIN);
    // Delta-Token VOR createSubscription snapshotten (falls keiner übernommen wird): so liegt der
    // Baseline-Token zeitlich VOR dem Aktivwerden der Subscription → eine Änderung im Anlege-Fenster
    // erscheint im NÄCHSTEN inkrementellen Delta (Re-Walk + Stale-Mark) statt im Baseline zu verpuffen.
    let deltaToken = carryDeltaToken;
    if (!deltaToken) {
      try { deltaToken = (await client.driveDelta(driveId, "latest")).deltaToken; }
      catch (e) { console.warn("[subscription] Delta-Token-Bootstrap fehlgeschlagen:", e.message); }
    }
    const sub = await client.createSubscription({ resource, notificationUrl, clientState, expirationDateTime, changeType: "updated" });
    await save({
      id: sub.id, kind: "drive", resource, driveId, notificationUrl, clientState,
      expiration: sub.expirationDateTime || expirationDateTime, deltaToken,
    });
    return { id: sub.id, expiration: sub.expirationDateTime || expirationDateTime };
  };

  if (!existing) return { action: "created", ...(await create()) };

  const now = Date.now();
  const exp = new Date(existing.expiration).getTime();

  // Abgelaufen ODER notificationUrl geändert (z. B. neue Domain) → alte best-effort löschen, neu anlegen
  // (delta_token erhalten → echter Catch-up statt Bootstrap).
  if (exp <= now || existing.notification_url !== notificationUrl) {
    try { await client.deleteSubscription(existing.id); } catch {}
    await removeRow(existing.id);
    return { action: "recreated", ...(await create(existing.delta_token)) };
  }

  // Bald ablaufend → erneuern.
  if (exp - now < RENEW_BEFORE_MIN * 60000) {
    try {
      const r = await client.renewSubscription(existing.id, expISO(LIFETIME_MIN));
      const newExp = r.expirationDateTime || expISO(LIFETIME_MIN);
      await updateExp(existing.id, newExp);
      return { action: "renewed", id: existing.id, expiration: newExp };
    } catch (e) {
      // 404: Graph hat sie entsorgt. 401/403: Verlängern braucht laut Microsoft evtl. ein Schreibrecht,
      // das nereo_os bewusst nicht hat — NEU ANLEGEN braucht nur Files.Read.All. In beiden Fällen
      // alte Subscription verwerfen und neu anlegen (delta_token erhalten → keine Änderung geht verloren).
      if (e.status === 404 || e.status === 401 || e.status === 403) {
        if (e.status !== 404) {
          console.warn(`[subscription] Verlängern abgelehnt (${e.status}) → neu anlegen`);
          try { await client.deleteSubscription(existing.id); } catch {}
        }
        await removeRow(existing.id);
        return { action: "recreated", ...(await create(existing.delta_token)) };
      }
      throw e;
    }
  }

  return { action: "noop", id: existing.id, expiration: existing.expiration };
}

/**
 * Beendet Subscriptions auf anderen Drives als der aktuellen Wurzel (z. B. nach dem Umzug von
 * Vascos OneDrive auf die SharePoint-Seite, 2026-11-20). Sonst bliebe die alte bis zum Ablauf aktiv und /healthz
 * zeigte sie an. Graph-Löschen best-effort, die DB-Zeile wird immer entfernt.
 * @returns {Promise<number>} Anzahl beendeter Subscriptions
 */
export async function retireOtherSubscriptions({ client, keepDriveId, list = loadActiveSubscriptions, remove = storeDeleteSubscription }) {
  if (!keepDriveId) return 0;
  let n = 0;
  for (const s of await list()) {
    if (!s.drive_id || s.drive_id === keepDriveId) continue;
    try { await client.deleteSubscription(s.id); } catch {}
    await remove(s.id);
    n++;
  }
  return n;
}
