import { describe, it, expect } from 'vitest';
import { StablecoinDepegScanner } from '../src/strategies/stablecoin-depeg-scanner.js';

describe('StablecoinDepegScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new StablecoinDepegScanner({ minDepegPct: 0.3, majorDepegPct: 2.0 });
    expect(scanner.id).toBe('stablecoin_depeg');
    expect(scanner.landscape).toBe('B_cex_cex');
  });

  it('riskParams returns valid params', () => {
    const scanner = new StablecoinDepegScanner({ minDepegPct: 0.3, majorDepegPct: 2.0 });
    const params = scanner.riskParams();
    expect(params.maxSizeUsd).toBe(10_000);
    expect(params.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new StablecoinDepegScanner({ minDepegPct: 0.3, majorDepegPct: 2.0 });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
