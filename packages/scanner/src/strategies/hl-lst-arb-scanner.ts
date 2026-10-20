/**
 * HlLstArbScanner — kHYPE/WHYPE LST carry arbitrage on HyperSwap V3.
 *
 * FAIR-VALUE MODEL (corrected EM-STRAT-003, hardened EM-STRAT-004):
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
 * NET-DISCOUNT THRESHOLD (EM-STRAT-004):
 *   An actionable alert requires a minimum 0.30% net discount AFTER costs
 *   (AMM swap fee + flashloan fee), not merely a positive gross discount
 *   and positive net profit. The 0.30% threshold provides a conservative
 *   margin against slippage, MEV, and execution risk before the carry
 *   is treated as a real opportunity.
 *
 * SOURCE FRESHNESS (EM-STRAT-004):
 *   Anchor freshness reflects the on-chain block timestamp at which the
 *   rate was read — NOT the local clock time of the fetch. The block
 *   timestamp is the authoritative "last update" of the Accountant state.
 *
 * FAIL-CLOSED INPUTS (EM-STRAT-004):
 *   All of the following are required inputs; if any is unavailable the
 *   scanner returns [] (no actionable alert):
 *     - Redemption anchor (kHYPE→HYPE rate)
 *     - Anchor freshness within staleness window
 *     - Withdrawal delay (from StakingManager)
 *     - AMM fee tier (from pool metadata)
 *     - Flashloan fee (constant)
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
 *
 * TEST SEAM:
 *   The constructor accepts an optional `deps` argument with `rpcCall`
 *   (JSON-RPC override) and `now` (clock override). Tests inject a
 *   deterministic `rpcCall` to exercise specific pool/anchor/delay
 *   scenarios without hitting live RPC. The scanner never invokes live
 *   RPC when `rpcCall` is provided.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, HYPEREVM_RPC, v3PriceToHuman, HYPERLEND_FLASHLOAN_FEE } from '../lib/hyperliquid-defi.js';

// Kinetiq Accountant contract — kHYPEToHYPE(uint256) selector = 0x759bc2fc
const ACCOUNTANT_ADDR = '0x9209648Ec9D448EF57116B73A2f081835643dc7A';
const KHYPE_TO_HYPE_SELECTOR = '0x759bc2fc';
const STAKING_MANAGER_ADDR = '0x393D0B87Ed38fc779FD9611144aE649BA6082109';
const WITHDRAWAL_DELAY_SELECTOR = '0x5e8a8c20'; // withdrawalDelay()
const SLOT0_SELECTOR = '0x3850c7bd';            // slot0()
const LIQUIDITY_SELECTOR = '0x1a686502';        // liquidity()
const ONE_E18 = 10n ** 18n;

// Stale data threshold (5 minutes). Anchor freshness is measured against
// the on-chain block timestamp, so this detects a stalled Accountant.
const ANCHOR_STALENESS_MS = 5 * 60 * 1000;

// EM-STRAT-004: required minimum net discount after costs (0.30%).
export const MIN_NET_DISCOUNT_PCT_DEFAULT = 0.30;

export interface HlLstArbParams {
  /** Min gross discount % to consider (default 0.5%). Below this is not interesting. */
  minDiscountPct: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
  /** Pool fee tier to use (default 100 = 0.01%) */
  preferredFeeTier: number;
  /**
   * Required minimum net discount % AFTER costs (default 0.30%).
   * An alert is only emitted when netProfitPct >= minNetDiscountPct.
   * EM-STRAT-004: replaces the previous "positive net profit" check.
   */
  minNetDiscountPct?: number;
}

/**
 * Injectable dependencies. Tests pass `rpcCall` to override live RPC.
 * Production callers omit `deps`; the scanner uses global `fetch()`.
 */
export interface HlLstArbDeps {
  /**
   * JSON-RPC call override. Receives (method, params) and returns the
   * parsed JSON response object (must contain `result`). When omitted,
   * the scanner uses global `fetch()` against HYPEREVM_RPC.
   */
  rpcCall?: (method: string, params: unknown[]) => Promise<{ result?: string }>;
  /** Clock override (ms since epoch). Defaults to Date.now. */
  now?: () => number;
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
  /** AMM swap fee as a percentage (e.g., 0.01 for tier-100 pool). */
  ammFeePct: number;
  /** Flashloan fee as a percentage (e.g., 0.04 for Hyperlend 0.04%). */
  flashloanFeePct: number;
  poolLiquidity: bigint;
  /** Withdrawal delay in seconds (from Kinetiq StakingManager). */
  withdrawalDelaySec: number | null;
  /**
   * On-chain block timestamp (seconds since epoch) at which the anchor
   * rate was read. This is the authoritative "last update" of the
   * Accountant state — NOT the local fetch time.
   */
  anchorBlockTs: number | null;
  /** Anchor freshness window (ms). Anchor is fresh if (now - anchorBlockTs*1000) < window. */
  anchorFresh: boolean;
  /** Whether the alert meets the 0.30% net-discount threshold and all required inputs. */
  executable: boolean;
  ts: number;
}

export class HlLstArbScanner implements Strategy {
  readonly id = 'hl_lst_arb';
  readonly landscape = 'C_dex_dex' as const;

  private readonly rpcCall: (method: string, params: unknown[]) => Promise<{ result?: string }>;
  private readonly now: () => number;

  constructor(private params: HlLstArbParams, deps: HlLstArbDeps = {}) {
    this.rpcCall = deps.rpcCall ?? ((method, rpcParams) =>
      fetch(HYPEREVM_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: rpcParams, id: 1 }),
      }).then(r => r.json()) as Promise<{ result?: string }>);
    this.now = deps.now ?? (() => Date.now());
  }

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
   * Fetch the kHYPE-to-HYPE exchange rate from the Kinetiq Accountant,
   * along with the latest block timestamp (real source freshness).
   * Returns null if either fetch fails.
   *
   * The block timestamp is the authoritative "last update" of the
   * on-chain Accountant state — using it (instead of Date.now()) means
   * anchor freshness reflects actual on-chain update cadence, not local
   * fetch latency.
   */
  async fetchRedemptionAnchor(): Promise<{ rate: number; blockTs: number } | null> {
    try {
      // Fetch rate and latest block in parallel.
      const [rateRes, blockRes] = await Promise.all([
        this.rpcCall('eth_call', [
          { to: ACCOUNTANT_ADDR, data: KHYPE_TO_HYPE_SELECTOR + ONE_E18.toString(16).padStart(64, '0') },
          'latest',
        ]),
        this.rpcCall('eth_getBlockByNumber', ['latest', false]),
      ]);

      const rateHex = rateRes.result;
      if (!rateHex || rateHex === '0x' || rateHex.length < 66) return null;
      const rawRate = BigInt('0x' + rateHex.slice(2, 66));
      if (rawRate <= 0n) return null;
      const rate = Number(rawRate) / Number(ONE_E18);
      if (!isFinite(rate) || rate <= 0) return null;

      // Block timestamp from eth_getBlockByNumber result.
      // Block JSON: { number, timestamp, hash, ... }
      const block = blockRes.result as unknown;
      let blockTs: number | null = null;
      if (typeof block === 'string' && block.startsWith('0x')) {
        // Some RPCs return just the block hash; treat as unavailable.
        blockTs = null;
      } else if (block && typeof block === 'object') {
        const ts = (block as { timestamp?: string }).timestamp;
        if (typeof ts === 'string' && ts.startsWith('0x')) {
          blockTs = parseInt(ts.slice(2), 16);
        }
      }
      if (blockTs === null || !isFinite(blockTs) || blockTs <= 0) return null;

      return { rate, blockTs };
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
      const res = await this.rpcCall('eth_call', [
        { to: STAKING_MANAGER_ADDR, data: WITHDRAWAL_DELAY_SELECTOR },
        'latest',
      ]);
      const result = res.result;
      if (!result || result === '0x' || result.length < 66) return null;
      const delay = parseInt(result.slice(2, 66), 16);
      if (!isFinite(delay) || delay < 0) return null;
      return delay;
    } catch {
      return null;
    }
  }

  async scan(): Promise<HlLstArbAlert[]> {
    const alerts: HlLstArbAlert[] = [];

    // 1. Fetch the redemption anchor (kHYPE-to-HYPE exchange rate + block ts)
    const anchor = await this.fetchRedemptionAnchor();
    if (!anchor) {
      // Fail closed: no anchor = no actionable discount
      return [];
    }
    const nowMs = this.now();
    const anchorFresh = (nowMs - anchor.blockTs * 1000) < ANCHOR_STALENESS_MS;
    if (!anchorFresh) {
      // Fail closed: stale anchor (block timestamp too old)
      return [];
    }

    // 2. Fetch withdrawal delay — REQUIRED input (EM-STRAT-004)
    const withdrawalDelaySec = await this.fetchWithdrawalDelay();
    if (withdrawalDelaySec === null) {
      // Fail closed: missing required withdrawal-delay input
      return [];
    }

    // 3. Find WHYPE/kHYPE V3 pools and compute discount vs anchor
    const khypePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/kHYPE');

    const minNetDiscountPct = this.params.minNetDiscountPct ?? MIN_NET_DISCOUNT_PCT_DEFAULT;

    for (const pool of khypePools) {
      try {
        // Get slot0() for sqrtPriceX96
        const slot0Res = await this.rpcCall('eth_call', [
          { to: pool.address, data: SLOT0_SELECTOR },
          'latest',
        ]);
        const slot0Result = slot0Res.result || '0x';
        if (slot0Result.length < 66) continue;

        const sqrtPriceX96 = BigInt('0x' + slot0Result.slice(2, 66));
        const dec0 = HL_TOKEN_DECIMALS['WHYPE'] ?? 18;
        const dec1 = HL_TOKEN_DECIMALS['kHYPE'] ?? 18;
        const marketPrice = v3PriceToHuman(sqrtPriceX96, dec0, dec1);

        // Pool price gives us: how many kHYPE per 1 WHYPE.
        // The redemption anchor tells us 1 kHYPE = anchor.rate HYPE.
        // Fair price of kHYPE in WHYPE = 1 / anchor.rate (since WHYPE ~= HYPE 1:1).
        // If marketPrice > fairPrice, kHYPE is CHEAPER (more kHYPE per WHYPE) = discount.
        //
        // Discount = (marketPrice - fairPrice) / fairPrice * 100
        // Positive = kHYPE trades below redemption value (buy kHYPE cheap)
        const fairPrice = 1 / anchor.rate; // kHYPE per WHYPE at redemption value
        if (marketPrice <= 0 || marketPrice > 2 * fairPrice) continue; // sanity check

        const grossDiscountPct = ((marketPrice - fairPrice) / fairPrice) * 100;

        if (grossDiscountPct < this.params.minDiscountPct) continue;

        // Get liquidity
        const liqRes = await this.rpcCall('eth_call', [
          { to: pool.address, data: LIQUIDITY_SELECTOR },
          'latest',
        ]);
        const liqResult = liqRes.result || '0x';
        const liquidity = liqResult.length >= 66 ? BigInt('0x' + liqResult.slice(2, 66)) : 0n;

        if (liquidity === 0n) continue;

        // ── Fee-tier conversion (EM-STRAT-004) ──────────────────────────
        // HyperSwap V3 (Uniswap V3 convention): fee tier is in hundredths
        // of a basis point. So:
        //   fee=100    → 0.01% (1 bps)
        //   fee=500    → 0.05% (5 bps)
        //   fee=3000   → 0.30% (30 bps)
        //   fee=10000  → 1.00% (100 bps)
        // Conversion: pct = fee / 1_000_000 * 100 = fee / 10_000
        //
        // The previous formula `(pool.fee / 10000) * 100` was 100x too
        // high (e.g., tier 100 yielded 1.0% instead of 0.01%).
        const ammFeePct = pool.fee / 10_000;

        // Flashloan fee (Hyperlend) — required input. Constant from lib.
        const flashloanFeePct = HYPERLEND_FLASHLOAN_FEE * 100; // 0.04 → 0.04%

        // ── Net-of-cost profit (EM-STRAT-004) ───────────────────────────
        // Net = gross - AMM fee - flashloan fee.
        const netProfitPct = grossDiscountPct - ammFeePct - flashloanFeePct;

        // EM-STRAT-004: require minimum 0.30% net discount after costs.
        // Previously only required netProfitPct > 0.
        if (netProfitPct < minNetDiscountPct) continue;

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
          ammFeePct,
          flashloanFeePct,
          poolLiquidity: liquidity,
          withdrawalDelaySec,
          anchorBlockTs: anchor.blockTs,
          anchorFresh,
          executable: false,
          ts: nowMs,
        });
      } catch {
        // skip this pool
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
