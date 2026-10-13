import { describe, it, expect } from 'vitest';
import { OrderbookImbalanceScanner } from '../src/strategies/orderbook-imbalance-scanner.js';

describe('OrderbookImbalanceScanner', () => {
  const params = {
    coins: ['BTC', 'ETH', 'SOL'],
    imbalanceThreshold: 0.30,
    wallThresholdUsd: 500_000,
    liquidityRangePct: 1.0,
  };

  it('implements Strategy interface', () => {
    const scanner = new OrderbookImbalanceScanner(params);
    expect(scanner.id).toBe('orderbook_imbalance');
    expect(scanner.landscape).toBe('G_mev');
  });

  it('riskParams returns valid params', () => {
    const scanner = new OrderbookImbalanceScanner(params);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new OrderbookImbalanceScanner(params);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  });
});
