import { describe, it, expect } from 'vitest';
import { PendleBorosScanner } from '../src/strategies/pendle-boros-scanner.js';
// EM-STRAT-006 §2: register offline mocks so scan() does NOT call live API.
import './_setup/offline-mocks.js';

describe('PendleBorosScanner', () => {
  const params = {
    minSpreadApr: 0.5,
    maxSizeUsd: 5_000,
    minNotionalOI: 50_000,
    platforms: [],
    minVolume24h: 100_000,
    minDaysToMaturity: 7,
    minSpreadPersistence: 2,
  };

  it('implements Strategy interface', () => {
    const scanner = new PendleBorosScanner(params);
    expect(scanner.id).toBe('pendle_boros');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams flows maxSizeUsd from constructor', () => {
    const scanner = new PendleBorosScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(3);
  });

  it('scan returns array', async () => {
    const scanner = new PendleBorosScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
