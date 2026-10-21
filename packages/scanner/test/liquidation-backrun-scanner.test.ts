import { describe, it, expect } from 'vitest';
import { LiquidationBackrunScanner } from '../src/strategies/liquidation-backrun-scanner.js';
// EM-STRAT-006 §2: register offline mocks so scan() does NOT call live API.
import "./_setup/offline-mocks.js";

describe('LiquidationBackrunScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new LiquidationBackrunScanner({
      cascadeFundingThreshold: 100, squeezeFundingThreshold: 500, minOiUsd: 500_000,
    });
    expect(scanner.id).toBe('liquidation_backrun');
    expect(scanner.landscape).toBe('G_mev');
  });

  it('riskParams returns valid params', () => {
    const scanner = new LiquidationBackrunScanner({
      cascadeFundingThreshold: 100, squeezeFundingThreshold: 500, minOiUsd: 500_000,
    });
    const params = scanner.riskParams();
    expect(params.maxSizeUsd).toBe(10_000);
    expect(params.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new LiquidationBackrunScanner({
      cascadeFundingThreshold: 100, squeezeFundingThreshold: 500, minOiUsd: 500_000,
    });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
