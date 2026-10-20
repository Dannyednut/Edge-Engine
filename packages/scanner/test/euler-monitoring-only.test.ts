import { describe, it, expect } from 'vitest';
import { EulerLendingArbScanner, type EulerLendingArbDeps } from '../src/strategies/euler-lending-arb-scanner.js';
import type { EulerVaultInfo } from '@edge/executor';

// ─── EM-STRAT-005 §3 regression tests ──────────────────────────────────
//
// These tests verify that the EulerLendingArbScanner:
//   - Uses the injectable test seam (NO live HyperEVM RPC).
//   - Returns monitoring-only alerts with null supply APY / spread / profit.
//   - Is NOT presented as an actionable opportunity.
//
// EM-STRAT-005 §3: tests MUST run offline. The mock EulerClient returns
// deterministic vault records. A failed assertion or unexpected exception
// must fail the test — no catch-and-skip.

function makeVault(opts: Partial<EulerVaultInfo> = {}): EulerVaultInfo {
  return {
    address: (opts.address ?? '0x0000000000000000000000000000000000000a01') as any,
    name: opts.name ?? 'eUSDC-3',
    symbol: opts.symbol ?? 'eUSDC-3',
    asset: (opts.asset ?? '0x0000000000000000000000000000000000000b01') as any,
    assetSymbol: opts.assetSymbol ?? 'USDC',
    assetDecimals: opts.assetDecimals ?? 6,
    totalAssets: opts.totalAssets ?? 258_000,
    totalBorrows: opts.totalBorrows ?? 200_000,
    totalSupply: opts.totalSupply ?? 258_000,
    cash: opts.cash ?? 58_000,
    interestRate: opts.interestRate ?? 0,
    interestRatePct: opts.interestRatePct ?? 7.12,
    utilizationPct: opts.utilizationPct ?? 77.5,
    borrowable: opts.borrowable ?? true,
    collateral: opts.collateral ?? false,
    ts: opts.ts ?? 0,
  };
}

function makeMockDeps(vaults: EulerVaultInfo[]): EulerLendingArbDeps {
  return {
    eulerClient: {
      getAllVaults: async () => vaults,
    },
  };
}

describe('EM-STRAT-005 §3 — Euler monitoring-only with injectable test seam (NO live RPC)', () => {

  describe('mocked vault records produce monitoring-only alerts', () => {
    it('two USDC vaults with different borrow rates produce a monitoring-only alert', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      for (const a of alerts) {
        expect(a.monitoringOnly).toBe(true);
      }
    });

    it('supplyApyPct is null on both deposit and borrow vaults', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      for (const a of alerts) {
        expect(a.depositVault.supplyApyPct).toBeNull();
        expect(a.borrowVault.supplyApyPct).toBeNull();
      }
    });

    it('spreadPct is null (cannot compute without supply APY)', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      for (const a of alerts) {
        expect(a.spreadPct).toBeNull();
      }
    });

    it('estimatedProfitUsd is null (cannot compute without supply APY and verified price)', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      for (const a of alerts) {
        expect(a.estimatedProfitUsd).toBeNull();
      }
    });

    it('alerts are NOT actionable (monitoring-only)', async () => {
      // EM-STRAT-005 §3: the EulerLendingArbAlert interface does not have an
      // `actionable` field, but `monitoringOnly=true` is the equivalent
      // contract — presenters MUST NOT treat these as actionable. The
      // strategy-labeling.test.ts verifies that presenters skip these alerts.
      const vaults = [
        makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      for (const a of alerts) {
        expect(a.monitoringOnly).toBe(true);
      }
    });
  });

  describe('injectable test seam: NO live RPC', () => {
    it('mock client returning empty array produces empty alerts (no crash, no RPC)', async () => {
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps([]),
      );
      const alerts = await scanner.scan();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts.length).toBe(0);
    });

    it('mock client returning single vault (no pair) produces empty alerts', async () => {
      const vaults = [makeVault({ name: 'eUSDC-3', interestRatePct: 7.12 })];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      // Need ≥2 vaults for the same asset to form a pair.
      expect(alerts.length).toBe(0);
    });

    it('mock client returning vaults with totalAssets=0 are skipped', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', totalAssets: 0, interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      // Only one vault has totalAssets > 0, so no pair can be formed.
      expect(alerts.length).toBe(0);
    });

    it('mock client returning multiple assets produces alerts per asset', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', assetSymbol: 'USDC', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, assetSymbol: 'USDC', interestRatePct: 4.50 }),
        makeVault({ name: 'eWETH-1', address: '0x0000000000000000000000000000000000000a03' as any, assetSymbol: 'WETH', interestRatePct: 3.5 }),
        makeVault({ name: 'eWETH-2', address: '0x0000000000000000000000000000000000000a04' as any, assetSymbol: 'WETH', interestRatePct: 2.5 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      // Two assets with pairs → ≥2 alerts.
      expect(alerts.length).toBeGreaterThanOrEqual(2);
      const assets = new Set(alerts.map(a => a.assetSymbol));
      expect(assets.has('USDC')).toBe(true);
      expect(assets.has('WETH')).toBe(true);
    });
  });

  describe('no catch-and-skip: exceptions propagate', () => {
    it('mock client that throws causes the test to fail (no silent skip)', async () => {
      // EM-STRAT-005 §3: a failed assertion or unexpected exception must fail
      // the test. We verify this by injecting a mock that throws and checking
      // that the scanner propagates the error.
      const throwingDeps: EulerLendingArbDeps = {
        eulerClient: {
          getAllVaults: async () => { throw new Error('mock RPC failure'); },
        },
      };
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        throwingDeps,
      );
      // The scanner does NOT catch errors from getAllVaults() — they propagate.
      // This is intentional: tests must fail loudly on errors, not silently skip.
      await expect(scanner.scan()).rejects.toThrow('mock RPC failure');
    });
  });

  describe('caller-provided prices flow through to totalLiquidityUsd', () => {
    it('when assetPrices provided, totalLiquidityUsd is computed', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', assetSymbol: 'USDC', totalAssets: 258_000, interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, assetSymbol: 'USDC', totalAssets: 241_000, interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000, assetPrices: { USDC: 1.0 } },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      // totalLiquidityUsd = (258_000 + 241_000) × 1.0 = 499_000
      expect(alerts[0].totalLiquidityUsd).toBeCloseTo(499_000, 0);
      // Even with price, supply APY / spread / profit remain null (cannot verify).
      expect(alerts[0].spreadPct).toBeNull();
      expect(alerts[0].estimatedProfitUsd).toBeNull();
    });

    it('when assetPrices NOT provided, totalLiquidityUsd is null', async () => {
      const vaults = [
        makeVault({ name: 'eUSDC-3', assetSymbol: 'USDC', interestRatePct: 7.12 }),
        makeVault({ name: 'eUSDC-4', address: '0x0000000000000000000000000000000000000a02' as any, assetSymbol: 'USDC', interestRatePct: 4.50 }),
      ];
      const scanner = new EulerLendingArbScanner(
        { minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000 },
        makeMockDeps(vaults),
      );
      const alerts = await scanner.scan();
      expect(alerts[0].totalLiquidityUsd).toBeNull();
    });
  });
});
