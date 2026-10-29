import { describe, it, expect } from 'vitest';
import { EulerLendingArbScanner, type EulerLendingArbDeps } from '../src/strategies/euler-lending-arb-scanner.js';
import type { EulerVaultInfo } from '@edge/executor';

// EM-STRAT-005 §3: tests MUST NOT trigger live HyperEVM RPC. We inject a
// mock EulerClient that returns deterministic vault records. The complete
// test suite must run offline.

const MOCK_VAULTS: EulerVaultInfo[] = [
  {
    address: '0x0000000000000000000000000000000000000a01' as any,
    name: 'eUSDC-3', symbol: 'eUSDC-3',
    asset: '0x0000000000000000000000000000000000000b01' as any,
    assetSymbol: 'USDC', assetDecimals: 6,
    totalAssets: 258_000, totalBorrows: 200_000, totalSupply: 258_000, cash: 58_000,
    interestRate: 0, interestRatePct: 7.12,
    utilizationPct: 77.5, borrowable: true, collateral: false, ts: 0,
  },
  {
    address: '0x0000000000000000000000000000000000000a02' as any,
    name: 'eUSDC-4', symbol: 'eUSDC-4',
    asset: '0x0000000000000000000000000000000000000b01' as any,
    assetSymbol: 'USDC', assetDecimals: 6,
    totalAssets: 241_000, totalBorrows: 150_000, totalSupply: 241_000, cash: 91_000,
    interestRate: 0, interestRatePct: 4.50,
    utilizationPct: 62.2, borrowable: true, collateral: false, ts: 0,
  },
];

const MOCK_DEPS: EulerLendingArbDeps = {
  eulerClient: { getAllVaults: async () => MOCK_VAULTS },
};

describe('EulerLendingArbScanner', () => {
  const params = {
    minSpreadPct: 1.0,
    minLiquidityUsd: 50_000,
    maxSizeUsd: 5_000,
  };

  it('implements Strategy interface', () => {
    const scanner = new EulerLendingArbScanner(params, MOCK_DEPS);
    expect(scanner.id).toBe('euler_lending_arb');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams flows maxSizeUsd from constructor', () => {
    const scanner = new EulerLendingArbScanner(params, MOCK_DEPS);
    const rp = scanner.riskParams();
    expect(rp.maxSizeUsd).toBe(5_000);
    expect(rp.maxConcurrent).toBe(5);
  });

  it('scan returns array (mocked — no live RPC, EM-STRAT-005 §3)', async () => {
    const scanner = new EulerLendingArbScanner(params, MOCK_DEPS);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    // Mocked vaults produce ≥1 alert (USDC has 2 vaults with different borrow rates).
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('scan returns monitoring-only alerts with null supply APY / spread / profit (EM-STRAT-005 §3)', async () => {
    const scanner = new EulerLendingArbScanner(params, MOCK_DEPS);
    const results = await scanner.scan();
    for (const a of results) {
      expect(a.monitoringOnly).toBe(true);
      expect(a.depositVault.supplyApyPct).toBeNull();
      expect(a.borrowVault.supplyApyPct).toBeNull();
      expect(a.spreadPct).toBeNull();
      expect(a.estimatedProfitUsd).toBeNull();
    }
  });

  it('scan returns empty array when mock client returns no vaults', async () => {
    const emptyDeps: EulerLendingArbDeps = {
      eulerClient: { getAllVaults: async () => [] },
    };
    const scanner = new EulerLendingArbScanner(params, emptyDeps);
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});
