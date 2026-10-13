import { describe, it, expect } from 'vitest';
import { PtYieldArbScanner } from '../src/strategies/pt-yield-arb-scanner.js';

describe('PtYieldArbScanner', () => {
  const params = {
    minYieldSpreadPct: 3.0,
    minTvlUsd: 500_000,
    maxImpliedApyPct: 50,
    khypeFloatingYieldApr: 2.37,
  };

  it('implements Strategy interface', () => {
    const scanner = new PtYieldArbScanner(params);
    expect(scanner.id).toBe('pt_yield_arb');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new PtYieldArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new PtYieldArbScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
