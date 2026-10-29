/**
 * PtKhypeYieldArbScanner — Pendle PT-kHYPE fixed vs floating yield arb.
 *
 * ───────────────────────────────────────────────────────────────────────
 * EM-STRAT-014-B2 — RESEARCH-ONLY / FAIL-CLOSED (signal-integrity quarantine)
 * ───────────────────────────────────────────────────────────────────────
 *
 * STATUS: This scanner is RESEARCH-ONLY. `scan()` fails closed and produces
 * NO operational opportunities until ALL of the following are wired through
 * a documented source:
 *
 *   1. A validated, instrument-specific PT price (in kHYPE terms) — NOT a
 *      hard-coded constant. The previous implementation fabricated a
 *      placeholder PT price of 0.98, which manufactured an implied yield,
 *      a yield spread, a direction and an `estimatedProfitUsd` out of
 *      thin air. That fabricated signal reached operational Telegram alerts
 *      with `severity: 'opportunity'`. It is removed.
 *   2. An active (non-expired) market identity. The three PT-kHYPE tokens
 *      discovered on 2026-10-13 (maturities 2025-11-13, 2026-03-19 and
 *      2026-09-24) are ALL in the past as of 2026-10-24. The previous
 *      implementation clamped days-to-maturity to a minimum of one day,
 *      converting every expired market into a synthetic one-day opportunity.
 *      That clamp is removed: expired instruments are rejected BEFORE any
 *      RPC/API call, never converted to a one-day window.
 *   3. A documented market-data source (Pendle API / HyperSwap pool) for
 *      both the PT price and total supply. No such integration is wired
 *      here — EM-STRAT-014-B2 explicitly does NOT implement a market-data
 *      integration. The total-supply RPC `eth_call` is retained ONLY as a
 *      gated downstream step that runs once a price source is injected;
 *      today it is unreachable because the price-source gate fails first.
 *
 * FAIL-CLOSED CONTRACT:
 *   - No validated price source  ⇒ scan() returns [] and makes ZERO
 *     fetch/RPC calls.
 *   - All instruments expired     ⇒ scan() returns [] and makes ZERO
 *     fetch/RPC calls (rejected before any query).
 *   - Missing / malformed / non-positive / > 2 PT price ⇒ that instrument
 *     is skipped, never alerted.
 *   - Any alert that IS emitted (only when a price source is injected)
 *     carries `researchOnly: true`. The presenter (all-runner.ts) MUST NOT
 *     dispatch it with `severity: 'opportunity'`; it is delivered as
 *     `severity: 'info'` with a `[PTKH-RESEARCH]` prefix. This is enforced
 *     by static presenter-contract tests in strategy-labeling.test.ts.
 *
 * The structural yield math is preserved (gated behind the price-source
 * check) so that a future, separately-reviewed task can wire a documented
 * source without re-deriving the formula. This file does NOT imply
 * strategy readiness.
 *
 * This scanner is DISTINCT from `hl_lst_arb` (which EI independently
 * classifies as a paper-validation candidate against a redemption anchor).
 * EM-STRAT-014-B2 does NOT touch EI-S008, kHYPE cadence/observation
 * requirements, anchor artifacts, or any protected funding-carry data.
 * ───────────────────────────────────────────────────────────────────────
 *
 * DISCOVERY (Oct 13 2026 — research note, all instruments now EXPIRED):
 *   Found 3PT-kHYPE tokens on HyperEVM (Pendle Principal Tokens):
 *     PT-kHYPE-13NOV2025: 13,241 tokens (matured 2025-11-13 — EXPIRED)
 *     PT-kHYPE-19MAR2026: 543 tokens   (matured 2026-03-19 — EXPIRED)
 *     PT-kHYPE-24SEP2026: 27,027 tokens (matured 2026-09-24 — EXPIRED)
 *
 * ARB STRUCTURE (research only — not actionable until a price source is wired):
 *   PT-kHYPE pays a FIXED yield at maturity.
 *   kHYPE earns a FLOATING yield (validator rewards, ~2.28% APR).
 *   implied_yield = (1 - pt_price) / pt_price × (365 / days_to_maturity)
 *   e.g., PT at 0.98 with 30 days to maturity:
 *         yield = (1-0.98)/0.98 × 365/30 = 0.0204 × 12.17 = 24.8% APR
 *
 * EXECUTION (research only — no execution path exists from this scanner):
 *   Buy PT-kHYPE on Pendle/HyperSwap → hold to maturity → redeem for kHYPE
 *   Or: buy kHYPE on HyperSwap → hold → earn floating validator rewards
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';
import { HYPEREVM_RPC } from '../lib/hyperliquid-defi.js';

export interface PtKhypeParams {
  /** Min yield spread between PT fixed and kHYPE floating (default 1%) */
  minYieldSpreadPct: number;
  /** kHYPE floating yield APR (default 2.28% — from Kinetiq staking) */
  khypeFloatingYieldApr: number;
  /** Max position size (default $5000) */
  maxSizeUsd: number;
}

export interface PtKhypeAlert {
  ptToken: string;
  ptAddress: string;
  maturity: string;
  daysToMaturity: number;
  ptTotalSupply: number;
  ptPrice: number;
  impliedFixedYieldApr: number;
  khypeFloatingYieldApr: number;
  yieldSpreadApr: number;
  direction: 'buy_pt' | 'buy_khype';
  estimatedProfitUsd: number;
  /**
   * EM-STRAT-014-B2: every alert is research-only. The PT price source is
   * not wired in production; no alert reaches operational channels as an
   * actionable opportunity. The presenter must dispatch with severity
   * 'info' and a [PTKH-RESEARCH] prefix. This flag MUST remain true until
   * a separately-reviewed task wires a documented, validated price source
   * AND updates the presenter contract + regression tests.
   */
  researchOnly: true;
  ts: number;
}

/**
 * A documented PT-kHYPE price source. NOT wired in production — injecting
 * one is the explicit prerequisite for re-enabling this scanner. A future
 * task must implement this against a real Pendle API / HyperSwap pool and
 * pass it to the scanner constructor. Until then `scan()` fails closed.
 */
export interface PtKhypePriceSource {
  /**
   * Returns the PT price in kHYPE terms for the given PT address, or
   * `null` when the price is missing, malformed, stale, or otherwise
   * unverifiable. Implementations MUST NOT return a hard-coded constant
   * or a synthetic fallback.
   */
  getPtPrice(ptAddress: string): Promise<number | null>;
}

export interface PtKhypeInstrument {
  name: string;
  address: string;
  /** ISO date string (e.g. '2026-09-24'). Expired instruments are rejected. */
  maturity: string;
}

/**
 * Research-discovery instrument list. ALL THREE maturities are in the past
 * as of 2026-10-24. They are retained as a research record and as the
 * default instrument set; `scan()` rejects every expired entry before any
 * RPC/API call, so this list produces zero opportunities today.
 */
export const PT_KHYPE_TOKENS: readonly PtKhypeInstrument[] = [
  { name: 'PT-kHYPE-13NOV2025', address: '0x311dB0FDe558689550c68355783c95eFDfe25329', maturity: '2025-11-13' },
  { name: 'PT-kHYPE-19MAR2026', address: '0xea84ca9849D9e76a78B91F221F84e9Ca065FC9f5', maturity: '2026-03-19' },
  { name: 'PT-kHYPE-24SEP2026', address: '0x50fC4EDC6346F36993Bb30Fe60E932504Ed17391', maturity: '2026-09-24' },
];

/**
 * Optional dependencies for deterministic offline testing and future price
 * wiring. In production the scanner is constructed with `params` only
 * (see all-runner.ts); `deps` defaults to `{}`, which makes `scan()` fail
 * closed.
 */
export interface PtKhypeDeps {
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Validated PT price source. When undefined (the production default),
   * `scan()` returns `[]` without any RPC/API polling.
   */
  priceSource?: PtKhypePriceSource;
  /** Injectable instrument list. Defaults to `PT_KHYPE_TOKENS`. */
  instruments?: readonly PtKhypeInstrument[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class PtKhypeYieldArbScanner implements Strategy {
  readonly id = 'pt_khype_yield_arb';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: PtKhypeParams, private deps: PtKhypeDeps = {}) {}

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

  async scan(): Promise<PtKhypeAlert[]> {
    const now = (this.deps.now ?? Date.now)();
    const instruments = this.deps.instruments ?? PT_KHYPE_TOKENS;

    // ── Gate 1: reject expired instruments BEFORE any RPC/API call. ──
    // No one-day floor clamp. Expired ⇒ excluded, never converted to a
    // one-day-to-maturity opportunity.
    const activeInstruments: PtKhypeInstrument[] = [];
    for (const pt of instruments) {
      const maturityMs = new Date(pt.maturity + 'T00:00:00Z').getTime();
      if (!Number.isFinite(maturityMs)) continue;          // malformed date
      if (maturityMs <= now) continue;                     // expired — reject, do not clamp
      activeInstruments.push(pt);
    }
    if (activeInstruments.length === 0) return [];          // no polling

    // ── Gate 2: fail closed when no validated price source is wired. ──
    // The production constructor passes no `priceSource`, so this branch
    // always returns [] today. No fabricated 0.98 / synthetic spread /
    // estimatedProfitUsd is ever produced.
    if (!this.deps.priceSource) return [];

    const fetchFn = this.deps.fetch ?? fetch;
    const alerts: PtKhypeAlert[] = [];

    for (const pt of activeInstruments) {
      try {
        // Total-supply query — only reached when a price source is present.
        // Gated behind Gate 2 so it is unreachable in production today.
        const tsRes = await fetchFn(HYPEREVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'eth_call',
            params: [{ to: pt.address, data: '0x18160ddd' }, 'latest'], id: 1,
          }),
        });
        const tsJson = await tsRes.json() as { result?: string };
        const totalSupply = BigInt('0x' + (tsJson.result || '0x').slice(2));
        const totalSupplyHuman = Number(totalSupply) / 1e18;
        if (totalSupplyHuman < 1) continue; // skip empty / malformed supply

        // ── Gate 3: validated, instrument-specific PT price. ──
        const ptPrice = await this.deps.priceSource.getPtPrice(pt.address);
        // Missing / malformed / non-positive / implausible (> 2× kHYPE) ⇒ skip.
        if (ptPrice === null) continue;
        if (!Number.isFinite(ptPrice)) continue;
        if (ptPrice <= 0) continue;
        if (ptPrice > 2) continue;

        const maturityMs = new Date(pt.maturity + 'T00:00:00Z').getTime();
        const daysToMaturity = (maturityMs - now) / MS_PER_DAY;
        // daysToMaturity is strictly > 0 here (Gate 1), no clamp applied.

        const impliedFixedYieldApr =
          ((1 - ptPrice) / ptPrice) * (365 / daysToMaturity) * 100;

        const yieldSpreadApr = impliedFixedYieldApr - this.params.khypeFloatingYieldApr;
        if (Math.abs(yieldSpreadApr) < this.params.minYieldSpreadPct) continue;

        const estimatedProfitUsd =
          (Math.abs(yieldSpreadApr) / 100 / 365 * daysToMaturity) * this.params.maxSizeUsd;

        alerts.push({
          ptToken: pt.name,
          ptAddress: pt.address,
          maturity: pt.maturity,
          daysToMaturity,
          ptTotalSupply: totalSupplyHuman,
          ptPrice,
          impliedFixedYieldApr,
          khypeFloatingYieldApr: this.params.khypeFloatingYieldApr,
          yieldSpreadApr,
          direction: yieldSpreadApr > 0 ? 'buy_pt' : 'buy_khype',
          estimatedProfitUsd,
          // EM-STRAT-014-B2: every emitted alert is research-only.
          researchOnly: true,
          ts: now,
        });
      } catch {
        // skip this instrument; do not surface a partial/fabricated signal
      }
    }

    alerts.sort((a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd);
    return alerts;
  }
}
