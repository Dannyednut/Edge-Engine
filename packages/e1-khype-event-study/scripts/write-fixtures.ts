/**
 * EM-STRAT-014-E1-R1 — regenerate the committed synthetic fixtures from
 * buildSyntheticFixtures() (provenance: fixtures are byte-for-byte the
 * generator output; the provenance test re-derives and compares bytes).
 * Offline, deterministic; writes ONLY under fixtures/synthetic-48h/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticFixtures } from '../src/fixtures/synthetic-generator.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'synthetic-48h');
const fx = buildSyntheticFixtures();

mkdirSync(join(OUT, 'raw'), { recursive: true });
for (const [name, content] of Object.entries(fx)) {
  const p = join(OUT, name);
  writeFileSync(p, content);
  console.log(`wrote ${name} (${content.length} bytes)`);
}
console.log('fixture regeneration complete');
