import { describe, it, expect } from 'vitest';
import type { Strategy, RiskParams, DataPoint, Opportunity, TradeOrder, LandscapeId, AlertSeverity } from '../src/index.js';

describe('@edge/types', () => {
  it('LandscapeId includes all 7 landscapes', () => {
    const landscapes: LandscapeId[] = [
      'A_dex_cex', 'B_cex_cex', 'C_dex_dex', 'D_prediction',
      'E_sports', 'F_perps_funding', 'G_mev'
    ];
    expect(landscapes).toHaveLength(7);
  });

  it('AlertSeverity includes all 5 severities', () => {
    const severities: AlertSeverity[] = ['info', 'opportunity', 'warning', 'critical', 'kill-switch'];
    expect(severities).toHaveLength(5);
  });

  it('RiskParams has required fields', () => {
    const params: RiskParams = {
      minProfitUsd: 10,
      maxSizeUsd: 5000,
      maxConcurrent: 3,
      cooldownMs: 60000,
      gasPriceCapMultiplier: 3,
    };
    expect(params.minProfitUsd).toBe(10);
    expect(params.maxSizeUsd).toBe(5000);
    expect(params.maxConcurrent).toBe(3);
  });

  it('DataPoint has required fields', () => {
    const dp: DataPoint = {
      source: 'test',
      ts: Date.now(),
      kind: 'price',
      symbol: 'BTC',
    };
    expect(dp.source).toBe('test');
    expect(dp.kind).toBe('price');
  });

  it('Strategy interface is satisfied', () => {
    const strategy: Strategy = {
      id: 'test_strategy',
      landscape: 'F_perps_funding',
      subscribesTo: () => [],
      evaluate: () => null,
      riskParams: () => ({
        minProfitUsd: 0,
        maxSizeUsd: 1000,
        maxConcurrent: 1,
        cooldownMs: 1000,
        gasPriceCapMultiplier: 3,
      }),
    };
    expect(strategy.id).toBe('test_strategy');
    expect(strategy.landscape).toBe('F_perps_funding');
  });
});
