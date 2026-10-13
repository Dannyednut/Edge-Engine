import { describe, it, expect } from 'vitest';
import { GoldArbScanner } from '../src/strategies/gold-arb-scanner.js';

describe('GoldArbScanner', () => {
  const params = {
    minSpreadPct: 0.3,
    maxSizeUsd: 10_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new GoldArbScanner(params);
    expect(scanner.id).toBe('gold_arb');
    expect(scanner.landscape).toBe('A_dex_cex');
  });

  it('riskParams flows maxSizeUsd from constructor', () => {
    const scanner = new GoldArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(10_000);
    expect(rp.maxConcurrent).toBe(1);
  });

  it('scan returns array', async () => {
    const scanner = new GoldArbScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
