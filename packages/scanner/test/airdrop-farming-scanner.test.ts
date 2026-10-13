import { describe, it, expect } from 'vitest';
import { AirdropFarmingScanner } from '../src/strategies/airdrop-farming-scanner.js';

describe('AirdropFarmingScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new AirdropFarmingScanner({ minTotalReturnPct: 10 });
    expect(scanner.id).toBe('airdrop_farming');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new AirdropFarmingScanner({ minTotalReturnPct: 10 });
    const params = scanner.riskParams();
    expect(params.maxSizeUsd).toBe(50_000);
    expect(params.maxConcurrent).toBe(10);
  });

  it('scan returns non-empty array (curated data)', async () => {
    const scanner = new AirdropFarmingScanner({ minTotalReturnPct: 10 });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});
