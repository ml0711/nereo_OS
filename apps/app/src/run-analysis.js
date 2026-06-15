// CLI: Datenraum-Analysen erzeugen (in-container ausführen — braucht DATABASE_URL + ANTHROPIC_API_KEY).
//   node apps/app/src/run-analysis.js [--force]
// --force = auch bereits analysierte Datenräume neu bewerten.
import { analyzeMissing } from "./analyze.js";

const force = process.argv.includes("--force");

analyzeMissing({ force })
  .then((r) => {
    if (r.error) { console.error(r.error); process.exit(1); }
    for (const it of r.items) {
      if (it.error) console.error(`  ✗ ${it.project} / ${it.name}: ${it.error}`);
      else console.log(`  ✓ ${it.project} / ${it.name} — Score ${it.score}, ${it.gaps} Lücken, ${it.risks} Risiken`);
    }
    console.log(`\nFertig: ${r.analyzed} analysiert, ${r.skipped} übersprungen, ${r.failed} Fehler. Tokens: ${r.tokens.input} in / ${r.tokens.output} out.`);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
