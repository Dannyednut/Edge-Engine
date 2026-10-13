import { describe, it, expect } from 'vitest';
import { CexDexBridgeScanner } from '../src/strategies/cex-dex-bridge-scanner.js';

describe('CexDexBridgeScanner', () => {
  const params = {
    minSpreadPct: 0.05,
    coins: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'UNI', 'AAVE', 'CRV'],
  };

  it('implements Strategy interface', () => {
    const scanner = new CexDexBridgeScanner(params);
    expect(scanner.id).toBe('cex_dex_bridge');
    expect(scanner.landscape).toBe('A_dex_cex');
  });

  it('riskParams returns valid params', () => {
    const scanner = new CexDexBridgeScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(20_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array (may be empty if APIs unreachable)', async () => {
    const scanner = new CexDexBridgeScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
