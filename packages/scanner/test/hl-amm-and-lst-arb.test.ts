import { describe, it, expect } from 'vitest';
import { HlAmmArbScanner } from '../src/strategies/hl-amm-arb-scanner.js';
import { HlLstArbScanner } from '../src/strategies/hl-lst-arb-scanner.js';

describe('HlAmmArbScanner', () => {
  const params = {
    minSpreadPct: 0.1,
    minPoolLiquidityUsd: 100,
    maxSizeUsd: 5_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new HlAmmArbScanner(params);
    expect(scanner.id).toBe('hl_amm_arb');
    expect(scanner.landscape).toBe('C_dex_dex');
  });

  it('riskParams flows maxSizeUsd', () => {
    const scanner = new HlAmmArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(2);
  });

  it('scan returns array', async () => {
    const scanner = new HlAmmArbScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});

describe('HlLstArbScanner', () => {
  const params = {
    minDiscountPct: 0.1,
    maxSizeUsd: 5_000,
    preferredFeeTier: 100,
  };

  it('implements Strategy interface', () => {
    const scanner = new HlLstArbScanner(params);
    expect(scanner.id).toBe('hl_lst_arb');
    expect(scanner.landscape).toBe('C_dex_dex');
  });

  it('riskParams flows maxSizeUsd', () => {
    const scanner = new HlLstArbScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(1);
  });

  it('scan returns array', async () => {
    const scanner = new HlLstArbScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
