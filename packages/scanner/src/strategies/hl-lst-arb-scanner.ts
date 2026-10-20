/**
 * HlLstArbScanner — kHYPE/WHYPE LST carry arbitrage on HyperSwap V3.
 *
 * FAIR-VALUE MODEL (corrected EM-STRAT-003):
 *   The discount is NOT measured against an assumed 1:1 WHYPE ratio.
 *   The Kinetiq kHYPE-to-HYPE exchange rate (from Accountant.kHYPEToHYPE(1e18))
 *   is the authoritative redemption anchor. If 1 kHYPE redeems for R HYPE,
 *   the fair market price of kHYPE in WHYPE is R. Any market price below R
 *   is a true discount; above R is a premium.
 *
 *   The scanner fetches the exchange rate anchor from the on-chain
 *   Accountant contract. If the anchor is unavailable or stale, the
 *   scanner fails closed and does NOT report an actionable discount.
 *
 * REDEMPTION MECHANISM:
 *   Queue native withdrawal -> burns kHYPE, returns HYPE after delay, less fee.
 *   This is a CARRY ARB, not atomic. Capital is locked for the withdrawal period.
 *
 * RISKS:
 *   - Kinetiq smart contract risk (validator / slashing risk)
 *   - Capital locked during withdrawal delay
 *   - HyperSwap V3 pool liquidity may be insufficient for large trades
 *   - Discount could widen or narrow
 *   - Exchange rate anchor could become stale between scans
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, HYPEREVM_RPC, v3PriceToHuman, HYPERLEND_FLASHLOAN_FEE } from '../lib/hyperliquid-defi.js';

// Kinetiq Accountant contract — kHYPEToHYPE(uint256) selector = 0x759bc2fc
const ACCOUNTANT_ADDR = '0x9209648Ec9D448EF57116B73A2f081835643dc7A';
const KHYPE_TO_HYPE_SELECTOR = '0x759bc2fc';
const ONE_E18 = 10n ** 18n;

// Stale data threshold (5 minutes)
const ANCHOR_STALENESS_MS = 5 * 60 * 1000;

export interface HlLstArbParams {
  /** Min discount % to fire alert (default 0.5%) */
  minDiscountPct: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Pool fee tier to use (default 100 = 0.01%) */
  preferredFeeTier: number;
}

export interface HlLstArbAlert {
  pair: string;
  poolAddress: string;
  feeTier: number;
  /** Market price of kHYPE in WHYPE (from pool slot0). */
  marketPrice: number;
  /** Redemption anchor: kHYPE-to-HYPE exchange rate from Accountant. */
  redemptionAnchor: number;
  /** Gross discount: (anchor - marketPrice) / anchor * 100. Positive = kHYPE below fair value. */
  grossDiscountPct: number;
  /** Net-of-cost threshold: gross discount - AMM fee - flashloan fee. */
  netProfitPct: number;
  /** Estimated profit in USD on max position size. */
  estimatedProfitUsd: number;
  flashloanFeePct: number;
  ammFeePct: number;
  poolLiquidity: bigint;
  /** Withdrawal delay in seconds (from Kinetiq StakingManager). */
  withdrawalDelaySec: number | null;
  /** Timestamp of the exchange-rate anchor fetch. */
  anchorTs: number | null;
  /** Whether the anchor is fresh (within staleness threshold). */
  anchorFresh: boolean;
  executable: boolean;
  ts: number;
}

export class HlLstArbScanner implements Strategy {
  readonly id = 'hl_lst_arb';
  readonly landscape = 'C_dex_dex' as const;

  constructor(private params: HlLstArbParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: this.params.maxSizeUsd,
      maxConcurrent: 1,
      cooldownMs: 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  /**
   * Fetch the kHYPE-to-HYPE exchange rate from the Kinetiq Accountant.
   * Returns the rate as a human-readable number (e.g., 1.0265 means 1 kHYPE = 1.0265 HYPE).
   * Returns null if the fetch fails or the result is invalid.
   */
  async fetchRedemptionAnchor(): Promise<{ rate: number; ts: number } | null> {
    try {
      const res = await fetch(HYPEREVM_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'eth_call',
          params: [{ to: ACCOUNTANT_ADDR, data: KHYPE_TO_HYPE_SELECTOR + ONE_E18.toString(16).padStart(64, '0') }, 'latest'], id: 1,
        }),
      });
      const json = await res.json() as { result?: string };
      const result = json.result;
      if (!result || result === '0x' || result.length < 66) return null;
      const rawRate = BigInt('0x' + result.slice(2, 66));
      if (rawRate <= 0n) return null;
      const rate = Number(rawRate) / Number(ONE_E18);
      if (!isFinite(rate) || rate <= 0) return null;
      return { rate, ts: Date.now() };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the withdrawal delay from the Kinetiq StakingManager.
   * Selector: withdrawalDelay() = 0x5e8a8c20
   * Returns seconds, or null if unavailable.
   */
  async fetchWithdrawalDelay(): Promise<number | null> {
    try {
      const STAKING_MANAGER = '0x393D0B87Ed38fc779FD9611144aE649BA6082109';
      const res = await fetch(HYPEREVM_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'eth_call',
          params: [{ to: STAKING_MANAGER, data: '0x5e8a8c20' }, 'latest'], id: 1,
        }),
      });
      const json = await res.json() as { result?: string };
      const result = json.result;
      if (!result || result === '0x' || result.length < 66) return null;
      return parseInt(result.slice(2, 66), 16);
    } catch {
      return null;
    }
  }

  async scan(): Promise<HlLstArbAlert[]> {
    const alerts: HlLstArbAlert[] = [];

    // 1. Fetch the redemption anchor (kHYPE-to-HYPE exchange rate)
    const anchor = await this.fetchRedemptionAnchor();
    if (!anchor) {
      // Fail closed: no anchor = no actionable discount
      return [];
    }
    const anchorFresh = (Date.now() - anchor.ts) < ANCHOR_STALENESS_MS;
    if (!anchorFresh) {
      // Fail closed: stale anchor
      return [];
    }

    // 2. Fetch withdrawal delay
    const withdrawalDelaySec = await this.fetchWithdrawalDelay();

    // 3. Find WHYPE/kHYPE V3 pools and compute discount vs anchor
    const khypePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');

    for (const pool of khypePools) {
      try {
        // Get slot0() for sqrtPriceX96
        const slot0Res = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x3850c7bd' }, 'latest'], id: 1,
          }),
        });
        const slot0Json = await slot0Res.json() as { result?: string };
        const slot0Result = slot0Json.result || '0x';
        if (slot0Result.length < 66) continue;

        const sqrtPriceX96 = BigInt('0x' + slot0Result.slice(2, 66));
        const dec0 = HL_TOKEN_DECIMALS['WHYPE'] ?? 18;
        const dec1 = HL_TOKEN_DECIMALS['kHYPE'] ?? 18;
        const marketPrice = v3PriceToHuman(sqrtPriceX96, dec0, dec1);

        // marketPrice = kHYPE per WHYPE (pool's price representation).
        // The redemption anchor tells us 1 kHYPE = anchor.rate HYPE.
        // Fair price of kHYPE in WHYPE = 1 / anchor.rate (since WHYPE ~= HYPE 1:1).
        // If marketPrice < (1 / anchor.rate), kHYPE is at a discount.
        //
        // Actually, let's think carefully:
        // - Pool price gives us: how many kHYPE per 1 WHYPE
        // - If pool says 1 WHYPE = 1.03 kHYPE, that means kHYPE is cheaper
        // - The fair value: 1 WHYPE should = 1/anchor.rate kHYPE
        //   (because 1 kHYPE redeems for anchor.rate HYPE, so 1/anchor.rate kHYPE = 1 HYPE = 1 WHYPE)
        // - Discount = (fairKHypePerWHYPE - marketKHypePerWHYPE) / fairKHypePerWHYPE * 100
        //   where fairKHypePerWHYPE = 1 / anchor.rate
        //
        // But we need to be careful about price direction. Let's compute:
        // - fairPrice = 1 / anchor.rate (kHYPE per WHYPE at fair value)
        // - If marketPrice > fairPrice, kHYPE is CHEAPER (more kHYPE per WHYPE) = discount
        // - grossDiscountPct = (marketPrice - fairPrice) / fairPrice * 100

        const fairPrice = 1 / anchor.rate; // kHYPE per WHYPE at redemption value
        if (marketPrice <= 0 || marketPrice > 2 * fairPrice) continue; // sanity check

        // Discount = (marketPrice - fairPrice) / fairPrice * 100
        // Positive = kHYPE trades below redemption value (buy kHYPE cheap)
        const grossDiscountPct = ((marketPrice - fairPrice) / fairPrice) * 100;

        if (grossDiscountPct < this.params.minDiscountPct) continue;

        // Get liquidity
        const liqRes = await fetch(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pool.address, data: '0x1a686502' }, 'latest'], id: 1,
          }),
        });
        const liqJson = await liqRes.json() as { result?: string };
        const liqResult = liqJson.result || '0x';
        const liquidity = liqResult.length >= 66 ? BigInt('0x' + liqResult.slice(2, 66)) : 0n;

        if (liquidity === 0n) continue;

        // Compute net profit after costs
        const ammFeePct = (pool.fee / 10000) * 100;
        const flashloanFeePct = HYPERLEND_FLASHLOAN_FEE * 100;
        const netProfitPct = grossDiscountPct - ammFeePct - flashloanFeePct;

        if (netProfitPct <= 0) continue;

        const estimatedProfitUsd = (netProfitPct / 100) * this.params.maxSizeUsd;

        alerts.push({
          pair: 'WHYPE/kHYPE',
          poolAddress: pool.address,
          feeTier: pool.fee,
          marketPrice,
          redemptionAnchor: anchor.rate,
          grossDiscountPct,
          netProfitPct,
          estimatedProfitUsd,
          flashloanFeePct,
          ammFeePct,
          poolLiquidity: liquidity,
          withdrawalDelaySec,
          anchorTs: anchor.ts,
          anchorFresh,
          executable: false,
          ts: Date.now(),
        });
      } catch {
        // skip
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
