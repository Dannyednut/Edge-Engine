import { describe, it, expect } from 'vitest';
import { DefiLlamaYieldScanner } from '../src/strategies/defillama-yield-scanner.js';

describe('DefiLlamaYieldScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 5.0,
      minTvlUsd: 1_000_000,
      stablecoinOnly: true,
      noIlRiskOnly: true,
      maxResults: 50,
    });
    expect(scanner.id).toBe('defillama_yield');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('subscribesTo returns empty array', () => {
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 5.0, minTvlUsd: 1_000_000, stablecoinOnly: true, noIlRiskOnly: true, maxResults: 50,
    });
    expect(scanner.subscribesTo()).toEqual([]);
  });

  it('evaluate returns null', () => {
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 5.0, minTvlUsd: 1_000_000, stablecoinOnly: true, noIlRiskOnly: true, maxResults: 50,
    });
    expect(scanner.evaluate({ source: 'test', ts: Date.now(), kind: 'price', payload: null })).toBeNull();
  });

  it('riskParams returns valid params', () => {
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 5.0, minTvlUsd: 1_000_000, stablecoinOnly: true, noIlRiskOnly: true, maxResults: 50,
    });
    const params = scanner.riskParams();
    expect(params.minProfitUsd).toBe(0);
    expect(params.maxSizeUsd).toBe(100_000);
  });

  it('scan returns array', async () => {
    const scanner = new DefiLlamaYieldScanner({
      minApyPct: 100, minTvlUsd: 1_000_000, stablecoinOnly: true, noIlRiskOnly: true, maxResults: 5,
    });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
