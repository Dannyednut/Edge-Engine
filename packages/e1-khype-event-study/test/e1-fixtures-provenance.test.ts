/**
 * EM-STRAT-014-E1 — fixture provenance: the committed synthetic fixtures
 * must be byte-for-byte identical to the deterministic generator output.
 * Hand-edits to fixtures fail here, so the fixture set stays machine-
 * verified provenance (see fixtures/synthetic-48h/PROVENANCE.md).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSyntheticFixtures } from '../src/fixtures/synthetic-generator.js';
import { FIXTURES_DIR, RAW_DIR } from './_helpers.js';

describe('fixture provenance — committed bytes == generator output', () => {
  const generated = buildSyntheticFixtures();

  it('SYNTHETIC-manifest.json matches the generator byte-for-byte', () => {
    const committed = readFileSync(join(FIXTURES_DIR, 'SYNTHETIC-manifest.json'), 'utf8');
    expect(committed).toBe(generated['SYNTHETIC-manifest.json']);
    // and it is valid canonical JSON (sorted keys, no floats)
    expect(() => JSON.parse(committed)).not.toThrow();
  });

  it('anchor + pool archives match the generator byte-for-byte (4 pools)', () => {
    expect(readFileSync(join(RAW_DIR, 'anchor.jsonl'), 'utf8')).toBe(generated['raw/anchor.jsonl']);
    for (const addr of [
      '0x00000000000000000000000000000000000000a1',
      '0x00000000000000000000000000000000000000a2',
      '0x00000000000000000000000000000000000000a3',
      '0x00000000000000000000000000000000000000a4',
    ]) {
      const committed = readFileSync(join(RAW_DIR, `${addr}.jsonl`), 'utf8');
      expect(committed).toBe(generated[`raw/${addr}.jsonl`]);
      // every line is valid JSON and carries the right address
      for (const line of committed.split('\n')) {
        if (line.trim() === '') continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.poolAddress === 'string') expect(obj.poolAddress).toBe(addr);
      }
    }
  });

  it('the generator itself is deterministic (two builds are identical)', () => {
    const again = buildSyntheticFixtures();
    expect(JSON.stringify(again)).toBe(JSON.stringify(generated));
  });
});
