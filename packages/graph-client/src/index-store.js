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

export async function saveIndex(index) {
  await ensureSchema();
  const p = await getPool();
  await p.query(
    "INSERT INTO graph_index (generated_at_ms, payload) VALUES ($1, $2)",
    [index?.generatedAtMs ?? null, JSON.stringify(index)]
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
