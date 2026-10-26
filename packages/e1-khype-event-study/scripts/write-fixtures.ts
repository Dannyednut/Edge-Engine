/**
 * EM-STRAT-014-E1 — writes the deterministic synthetic fixtures to disk.
 *
 * Run: pnpm --filter @edge/e1-khype-event-study write-fixtures
 * (from the package dir: tsx scripts/write-fixtures.ts)
 *
 * Output is byte-for-byte reproducible; the committed files are provenance-
 * verified against this generator by test/e1-fixtures-provenance.test.ts.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticFixtures } from '../src/fixtures/synthetic-generator.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const fixturesDir = join(pkgRoot, 'fixtures', 'synthetic-48h');

const files = buildSyntheticFixtures();
for (const [relPath, content] of Object.entries(files)) {
  const target = join(fixturesDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  process.stdout.write(`wrote ${target} (${Buffer.byteLength(content, 'utf8')} bytes)\n`);
}
