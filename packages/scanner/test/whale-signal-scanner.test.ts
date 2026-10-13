import { describe, it, expect } from 'vitest';
import { WhaleSignalScanner } from '../src/strategies/whale-signal-scanner.js';

describe('WhaleSignalScanner', () => {
  const params = {
    minVolOiRatio: 0.5,
    minTvlChangePct: 5.0,
    minProtocolTvl: 5_000_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new WhaleSignalScanner(params);
    expect(scanner.id).toBe('whale_signal');
    expect(scanner.landscape).toBe('G_mev');
  });

  it('riskParams returns valid params', () => {
    const scanner = new WhaleSignalScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new WhaleSignalScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
