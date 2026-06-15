// Einmal-Seed (läuft IM Container, erreicht die App-Postgres via DATABASE_URL):
// liest die Bind-Mount-Datei .data/graph-index.json und schreibt sie in Postgres,
// sofern die DB leer oder älter ist. Non-fatal — Fehler dürfen den Deploy nicht stoppen.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { saveIndex, loadLatestIndex } from "../../../packages/graph-client/src/index-store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = resolve(ROOT, ".data/graph-index.json");

async function main() {
  if (!process.env.DATABASE_URL) return console.log("seed-index: kein DATABASE_URL — übersprungen.");
  let index;
  try { index = JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return console.log("seed-index: keine Index-Datei unter", FILE, "— übersprungen."); }

  const existing = await loadLatestIndex().catch(() => null);
  const fileTs = index.generatedAtMs ?? 0;
  const dbTs = existing?.generatedAtMs ?? 0;
  if (existing && fileTs <= dbTs) return console.log("seed-index: DB bereits aktuell — übersprungen.");

  await saveIndex(index);
  console.log(`seed-index: Index nach Postgres geschrieben (generatedAtMs=${index.generatedAtMs}, drives=${index.drives?.length}).`);
}

main().catch((e) => console.error("seed-index Fehler (non-fatal):", e.message)).finally(() => process.exit(0));
