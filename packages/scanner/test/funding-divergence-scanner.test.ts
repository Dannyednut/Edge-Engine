import { describe, it, expect } from 'vitest';
import { FundingDivergenceScanner } from '../src/strategies/funding-divergence-scanner.js';
// EM-STRAT-006 §2: register offline mocks so scan() does NOT call live API.
import "./_setup/offline-mocks.js";

describe('FundingDivergenceScanner', () => {
  const params = {
    minDivergencePct: 20,
    minExtremeOiUsd: 1_000_000,
    extremeFundingThreshold: 50,
  };

  it('implements Strategy interface', () => {
    const scanner = new FundingDivergenceScanner(params);
    expect(scanner.id).toBe('funding_divergence');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new FundingDivergenceScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(10_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new FundingDivergenceScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
