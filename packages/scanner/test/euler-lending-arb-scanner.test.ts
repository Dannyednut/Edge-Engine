import { describe, it, expect } from 'vitest';
import { EulerLendingArbScanner } from '../src/strategies/euler-lending-arb-scanner.js';

describe('EulerLendingArbScanner', () => {
  const params = {
    minSpreadPct: 1.0,
    minLiquidityUsd: 50_000,
    maxSizeUsd: 5_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new EulerLendingArbScanner(params);
    expect(scanner.id).toBe('euler_lending_arb');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams flows maxSizeUsd from constructor', () => {
    const scanner = new EulerLendingArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new EulerLendingArbScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
