// Persistenz des Graph-Index in der App-Postgres (DATABASE_URL).
// Ablöse der Host-Datei .data/graph-index.json (CLAUDE.md §2/§3: App-Daten -> Coolify-Postgres).
// `pg` wird LAZY geladen: fehlt es oder ist die DB nicht erreichbar, werfen die Funktionen —
// der Aufrufer (app/server.js) fällt dann auf die Datei zurück. So crasht die app nie.

let pool;
let schemaReady = false;

async function getPool() {
  if (pool) return pool;
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL nicht gesetzt");
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: cs, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 });
  return pool;
}

async function ensureSchema() {
  if (schemaReady) return;
  const p = await getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS graph_index (
      id              bigserial PRIMARY KEY,
      generated_at_ms bigint,
      payload         jsonb NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`);
  schemaReady = true;
}

// Behält nur die letzten KEEP Indizes — graph_index ist sonst append-only und
// wächst pro Export um die volle Index-Größe (~MB JSONB). KEEP>1 = kurze Historie/Rollback.
const KEEP_INDICES = Number(process.env.GRAPH_INDEX_KEEP) || 5;

export async function saveIndex(index) {
  await ensureSchema();
  const p = await getPool();
  await p.query(
    "INSERT INTO graph_index (generated_at_ms, payload) VALUES ($1, $2)",
    [index?.generatedAtMs ?? null, JSON.stringify(index)]
  );
  // Pruning: alte Indizes über KEEP hinaus löschen (neueste behalten).
  await p.query(
    `DELETE FROM graph_index WHERE id NOT IN (
       SELECT id FROM graph_index ORDER BY created_at DESC, id DESC LIMIT $1
     )`,
    [KEEP_INDICES]
  );
}

export async function loadLatestIndex() {
  await ensureSchema();
  const p = await getPool();
  const { rows } = await p.query(
    "SELECT payload FROM graph_index ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0]?.payload ?? null;
}

// Leichtgewichtiger DB-Erreichbarkeits-Check für /healthz (kein Schema, kurzer Timeout).
// Wirft nie — gibt false zurück, wenn DB nicht erreichbar (degradierter Zustand sichtbar).
export async function pingDb() {
  try {
    const p = await getPool();
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// --- KI-Agenten-Output: Datenraum-Analysen (CLAUDE.md §3) ---
let analysisSchemaReady = false;
async function ensureAnalysisSchema() {
  if (analysisSchemaReady) return;
  const p = await getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS dataroom_analysis (
      dataroom_key text PRIMARY KEY,         -- stabiler Schlüssel = Datenraum-Pfad
      project      text,
      name         text,
      analysis     jsonb NOT NULL,
      model        text,
      analyzed_at  timestamptz NOT NULL DEFAULT now()
    )`);
  // Staleness: wann sich der Datenraum zuletzt geändert hat. stale = (last_change_at > analyzed_at),
  // ABGELEITET, nicht gespeichert → kein Flag-Reset-Race beim saveAnalysis (analyzed_at=now reicht).
  await p.query(`ALTER TABLE dataroom_analysis ADD COLUMN IF NOT EXISTS last_change_at timestamptz`);
  analysisSchemaReady = true;
}

/** Markiert einen Datenraum als geändert (für „neu analysieren?"-Hinweis). UPDATE, KEIN Upsert:
 *  ohne bestehende Analyse wird nichts angelegt. GREATEST → monoton/idempotent bei Duplikaten/Out-of-Order. */
export async function markRoomChanged(key, ts = new Date()) {
  await ensureAnalysisSchema();
  const p = await getPool();
  const { rowCount } = await p.query(
    `UPDATE dataroom_analysis
       SET last_change_at = GREATEST(COALESCE(last_change_at, 'epoch'::timestamptz), $2::timestamptz)
       WHERE dataroom_key = $1`,
    [key, ts]
  );
  return rowCount; // >0 wenn eine Analyse existierte und markiert wurde
}

// analyzedAt = Zeitpunkt, zu dem die Analyse ihre QUELLE gelesen hat (nicht der Abschluss-Zeitpunkt) —
// sonst entgeht eine Änderung, die WÄHREND eines laufenden (langsamen) Claude-Calls passiert, der
// Staleness-Erkennung (last_change_at < analyzed_at, obwohl die Analyse die Änderung nicht kennt).
export async function saveAnalysis(room, analysis, analyzedAt = new Date()) {
  await ensureAnalysisSchema();
  const p = await getPool();
  await p.query(
    `INSERT INTO dataroom_analysis (dataroom_key, project, name, analysis, model, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dataroom_key) DO UPDATE
       SET analysis=$4, model=$5, project=$2, name=$3, analyzed_at=$6`,
    [room.path, room.project ?? null, room.name ?? null, JSON.stringify(analysis), analysis?.model ?? null, analyzedAt]
  );
}

// Map: dataroom-path -> analysis (inkl. model + analyzedAt + abgeleitetem stale/changedAt)
export async function loadAnalyses() {
  await ensureAnalysisSchema();
  const p = await getPool();
  const { rows } = await p.query(`SELECT dataroom_key, analysis, model, analyzed_at, last_change_at FROM dataroom_analysis`);
  const map = {};
  for (const r of rows) {
    const stale = !!(r.last_change_at && r.analyzed_at && r.last_change_at > r.analyzed_at);
    map[r.dataroom_key] = { ...r.analysis, model: r.model, analyzedAt: r.analyzed_at, stale, changedAt: r.last_change_at ?? null };
  }
  return map;
}

// --- Schreib-Audit: JEDE Mutation gegen SharePoint/Outlook (Guardrail, CLAUDE.md §2) ---
// Lückenloses Protokoll: wer, was, wann, Ergebnis. Pflicht für den Kunden-Security-Review.
let writeAuditSchemaReady = false;
async function ensureWriteAuditSchema() {
  if (writeAuditSchemaReady) return;
  const p = await getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS graph_write_audit (
      id          bigserial PRIMARY KEY,
      actor       text,                   -- eingeloggter Nutzer (LogTo), der den Write ausgelöst hat
      method      text NOT NULL,          -- POST | PUT | PATCH | DELETE
      path        text NOT NULL,          -- Graph-Pfad der Mutation
      label       text,                   -- menschenlesbare Kurzbeschreibung
      status      text NOT NULL,          -- dry-run | blocked | ok | error
      http_status int,
      result_id   text,                   -- ID des erzeugten/geänderten Objekts (falls vorhanden)
      error       jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await p.query(`CREATE INDEX IF NOT EXISTS graph_write_audit_created_idx ON graph_write_audit (created_at DESC)`);
  writeAuditSchemaReady = true;
}

/** Schreibt einen Audit-Eintrag. Wird vom onWrite-Callback des Graph-Clients gefüttert. */
export async function logWrite(entry) {
  await ensureWriteAuditSchema();
  const p = await getPool();
  await p.query(
    `INSERT INTO graph_write_audit (actor, method, path, label, status, http_status, result_id, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.actor ?? null,
      entry.method,
      entry.path,
      entry.label ?? null,
      entry.status,
      entry.httpStatus ?? null,
      entry.resultId ?? null,
      entry.error == null ? null : JSON.stringify(entry.error),
    ]
  );
}

/** Liest die letzten Audit-Einträge (neueste zuerst). */
export async function loadWriteAudit(limit = 100) {
  await ensureWriteAuditSchema();
  const p = await getPool();
  const { rows } = await p.query(
    `SELECT id, actor, method, path, label, status, http_status, result_id, error, created_at
       FROM graph_write_audit ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Number(limit) || 100, 500)]
  );
  return rows;
}

// --- Realtime-Sync: Graph-Subscription + Delta-Token-Zustand (CLAUDE.md §3) ---
// EINE Zeile pro Drive (Phase 2: kind='mail' pro Postfach). delta_token lebt hier (1 Drive = 1 Zustand).
let subscriptionSchemaReady = false;
async function ensureSubscriptionSchema() {
  if (subscriptionSchemaReady) return;
  const p = await getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS graph_subscription (
      id                   text PRIMARY KEY,        -- Graph-Subscription-id (matcht subscriptionId der Notification)
      kind                 text NOT NULL DEFAULT 'drive',
      resource             text NOT NULL,           -- "/drives/{driveId}/root"
      drive_id             text,
      notification_url     text NOT NULL,
      client_state         text NOT NULL,           -- pro-Sub Secret, gegen Notification-clientState
      expiration           timestamptz NOT NULL,
      delta_token          text,                    -- letzter @odata.deltaLink-Token
      last_notification_at timestamptz,
      last_sync_at         timestamptz,             -- letzter erfolgreicher Re-Walk (Watchdog/healthz)
      dirty                boolean NOT NULL DEFAULT false,
      processing_at        timestamptz,             -- Lease/Claim (NULL=frei); Stale-Reclaim < now()-10min
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    )`);
  await p.query(`CREATE INDEX IF NOT EXISTS graph_subscription_dirty_idx ON graph_subscription (dirty) WHERE dirty`);
  subscriptionSchemaReady = true;
}

export async function saveSubscription(sub) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(
    `INSERT INTO graph_subscription (id, kind, resource, drive_id, notification_url, client_state, expiration, delta_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       kind=$2, resource=$3, drive_id=$4, notification_url=$5, client_state=$6, expiration=$7,
       delta_token=COALESCE($8, graph_subscription.delta_token), updated_at=now()`,
    [sub.id, sub.kind ?? "drive", sub.resource, sub.driveId ?? null, sub.notificationUrl, sub.clientState, sub.expiration, sub.deltaToken ?? null]
  );
}

export async function loadActiveSubscriptions() {
  await ensureSubscriptionSchema();
  const p = await getPool();
  const { rows } = await p.query(`SELECT * FROM graph_subscription ORDER BY created_at`);
  return rows;
}
export async function loadSubscriptionById(id) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  const { rows } = await p.query(`SELECT * FROM graph_subscription WHERE id=$1`, [id]);
  return rows[0] ?? null;
}
export async function loadSubscriptionByDrive(driveId) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  const { rows } = await p.query(`SELECT * FROM graph_subscription WHERE drive_id=$1 ORDER BY created_at DESC LIMIT 1`, [driveId]);
  return rows[0] ?? null;
}

/** Setzt dirty=true (Notification eingegangen). */
export async function markDirty(id, at = new Date()) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(`UPDATE graph_subscription SET dirty=true, last_notification_at=$2, updated_at=now() WHERE id=$1`, [id, at]);
}

/** Atomar einen dirty-Job klauen (Single-Flight, auch bei mehreren Replicas): dirty->false,
 *  processing_at=now. FOR UPDATE SKIP LOCKED + Lease-Reclaim alter Hänger. null wenn nichts frei. */
export async function claimDirtySubscription() {
  await ensureSubscriptionSchema();
  const p = await getPool();
  const { rows } = await p.query(
    `UPDATE graph_subscription SET dirty=false, processing_at=now(), updated_at=now()
       WHERE id = (
         SELECT id FROM graph_subscription
           WHERE dirty = true AND (processing_at IS NULL OR processing_at < now() - interval '10 minutes')
           ORDER BY last_notification_at NULLS FIRST
           FOR UPDATE SKIP LOCKED LIMIT 1
       )
     RETURNING *`
  );
  return rows[0] ?? null;
}

/** Claim für den Delta-Poll (sync-cli) — nimmt das Lease (processing_at) AUCH ohne dirty, per driveId.
 *  Schließt den Cross-Prozess-Race aus: hält der Webhook gerade das Lease, gibt das hier null (→ Poll überspringt)
 *  und umgekehrt. Beide Pfade gaten über dasselbe processing_at → echtes Single-Flight über Prozessgrenzen. */
export async function claimSubscriptionForSync(driveId) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  const { rows } = await p.query(
    `UPDATE graph_subscription SET processing_at=now(), updated_at=now()
       WHERE id = (
         SELECT id FROM graph_subscription
           WHERE drive_id=$1 AND (processing_at IS NULL OR processing_at < now() - interval '10 minutes')
           ORDER BY created_at DESC
           FOR UPDATE SKIP LOCKED LIMIT 1
       )
     RETURNING *`,
    [driveId]
  );
  return rows[0] ?? null;
}

/** Verarbeitung abgeschlossen: Lease lösen, delta_token + last_sync_at fortschreiben. */
export async function finishProcessing(id, { deltaToken = null, lastSyncAt = null } = {}) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(
    `UPDATE graph_subscription SET processing_at=NULL,
       delta_token=COALESCE($2, delta_token), last_sync_at=COALESCE($3, last_sync_at), updated_at=now()
       WHERE id=$1`,
    [id, deltaToken, lastSyncAt]
  );
}

export async function saveDeltaToken(id, deltaToken) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(`UPDATE graph_subscription SET delta_token=$2, updated_at=now() WHERE id=$1`, [id, deltaToken]);
}
export async function updateExpiration(id, expiration) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(`UPDATE graph_subscription SET expiration=$2, updated_at=now() WHERE id=$1`, [id, expiration]);
}
export async function deleteSubscription(id) {
  await ensureSubscriptionSchema();
  const p = await getPool();
  await p.query(`DELETE FROM graph_subscription WHERE id=$1`, [id]);
}
