import { describe, it, expect } from 'vitest';
import { PrecompileFlashloanArbScanner } from '../src/strategies/precompile-flashloan-arb.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── EM-STRAT-012 Phase-0 task D: fabricated-alert quarantine regression ──
//
// The unwired precompile-flashloan-arb prototype previously pushed a
// fabricated BTC divergence alert with hardcoded prices (82501/82500) that
// were not derived from any market data. These tests prove the quarantine:
// scan() emits nothing, and the fake values no longer exist anywhere in
// the source file.

describe('PrecompileFlashloanArbScanner — fabricated-alert quarantine (EM-STRAT-012 task D)', () => {

  it('scan() returns an empty array (no fabricated opportunity)', async () => {
    const scanner = new PrecompileFlashloanArbScanner({ minSpreadPct: 1, maxFlashloanUsd: 10_000 });
    const alerts = await scanner.scan();
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts.length).toBe(0);
  });

  it('the source file no longer contains the fabricated placeholder prices', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'strategies', 'precompile-flashloan-arb.ts'),
      'utf8',
    );
    // The hardcoded fake values from the removed alert must be gone.
    // (The direction union type on the alert interface is retained — it
    // describes the future real implementation, not the fabricated alert.)
    expect(src).not.toContain('82501');
    expect(src).not.toContain('82500');
    expect(src).not.toContain("asset: 'BTC'");
    expect(src).not.toMatch(/hlPerpPrice:\s*\d/);
    expect(src).not.toMatch(/hyperswapPrice:\s*\d/);
  });

  it('the quarantine is documented in scan() (not a silent change)', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'strategies', 'precompile-flashloan-arb.ts'),
      'utf8',
    );
    expect(src).toContain('QUARANTINED');
    expect(src).toContain('EM-STRAT-012');
  });
});
