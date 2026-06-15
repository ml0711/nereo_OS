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
  analysisSchemaReady = true;
}

export async function saveAnalysis(room, analysis) {
  await ensureAnalysisSchema();
  const p = await getPool();
  await p.query(
    `INSERT INTO dataroom_analysis (dataroom_key, project, name, analysis, model)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dataroom_key) DO UPDATE
       SET analysis=$4, model=$5, project=$2, name=$3, analyzed_at=now()`,
    [room.path, room.project ?? null, room.name ?? null, JSON.stringify(analysis), analysis?.model ?? null]
  );
}

// Map: dataroom-path -> analysis (inkl. model + analyzedAt)
export async function loadAnalyses() {
  await ensureAnalysisSchema();
  const p = await getPool();
  const { rows } = await p.query(`SELECT dataroom_key, analysis, model, analyzed_at FROM dataroom_analysis`);
  const map = {};
  for (const r of rows) map[r.dataroom_key] = { ...r.analysis, model: r.model, analyzedAt: r.analyzed_at };
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
