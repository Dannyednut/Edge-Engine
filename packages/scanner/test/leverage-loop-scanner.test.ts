import { describe, it, expect } from 'vitest';
import { LeverageLoopScanner } from '../src/strategies/leverage-loop-scanner.js';

describe('LeverageLoopScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new LeverageLoopScanner({ minSpreadPct: 0.5, maxLeverage: 5 });
    expect(scanner.id).toBe('leverage_loop');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new LeverageLoopScanner({ minSpreadPct: 0.5, maxLeverage: 5 });
    const params = scanner.riskParams();
    expect(params.maxSizeUsd).toBe(50_000);
    expect(params.maxConcurrent).toBe(5);
  });

  it('scan returns non-empty array (curated data)', async () => {
    const scanner = new LeverageLoopScanner({ minSpreadPct: 0.5, maxLeverage: 5 });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});
