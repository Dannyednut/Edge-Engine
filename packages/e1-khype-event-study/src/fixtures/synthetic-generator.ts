/**
 * EM-STRAT-014-E1 — deterministic SYNTHETIC fixture generator.
 *
 * PROVENANCE: the committed fixture files under fixtures/synthetic-48h/
 * are byte-for-byte the output of buildSyntheticFixtures(). A test
 * regenerates them in-memory and compares bytes, so the fixture provenance
 * is machine-verified: nobody can hand-edit a fixture without the
 * provenance test failing.
 *
 * Everything here is a declared constant; there is no clock, no randomness,
 * no floating point. The generator uses the SAME BigInt/tick-math modules
 * as the replay tool, so fixture values are exactly representable in the
 * tool's conventions (sqrtPriceX96 = floor(isqrt(P * 2^192)) etc.).
 *
 * SCENARIO MAP (48h window, 10-minute grid, 289 samples, anchorRate = 1.0
 * everywhere — kHYPEToHYPE = 1e18, a declared synthetic simplification):
 *
 *   pool-a1 "primary"    fee 0.01%: one 19-sample discount dip at +0.6%
 *                        (E1-T1: exactly 1 event, d_max ~= 0.6%, net ~=
 *                        0.50%, duration exactly 3h).
 *   pool-a2 "independence" fee 0.01%: dip pair separated by reversion to
 *                        +0.005% (INSIDE the 0.01% band -> two independent
 *                        events, E1-T2), then a dip pair separated by
 *                        reversion to +0.015% (OUTSIDE the band -> merged
 *                        into ONE event, E1-T3).
 *   pool-a3 "highfee"    fee 1.00%: one +0.6% dip that fails the rule
 *                        (E1-T5: counted as failing, not passing).
 *   pool-a4 "zeroliq"    fee 0.01%, zero liquidity: +0.6% dip where depth
 *                        is unmeasurable (E1-T8 integration: fails closed,
 *                        counted exclusion `depth_quote_failed`).
 *   anchor.jsonl         constant anchor; blocks at grid indices 260..263
 *                        carry the E1-T4 defects: record missing, "0x"
 *                        raw, stale read (1200s > 300s), future read
 *                        (900s > 60s) -> anchor_unusable exclusions.
 *
 * LIQUIDITY TUNING: pools a1/a2/a3 share liquidity L computed EXACTLY so
 * that a 500 WHYPE swap from the dip price P = 1.006 yields impact(D) =
 * 0.05% (i.e. the average realized price is 1.0055 = sqrt(Ps * Pend) with
 * Pend = (Ps - 0.0005)^2 / Ps). This makes the E1-T1 arithmetic exact:
 * net = 0.6 - 0.01 - 0.04 - 0.05.
 *
 * USD DEPTH (EM-STRAT-014-E1-R1): the declared $10,000 depth is converted
 * PER SAMPLE via the committed usd-price.jsonl series at the synthetic
 * reference $20 per WHYPE (source 'synthetic-usd-reference'):
 * depthWei = ceil(10000 * 10^18 / 20*10^18) = 500 * 10^18 wei EXACTLY.
 * `1 WHYPE = $1` is NOT assumed anywhere; the conversion is explicit,
 * provenance-bearing, and block-aligned.
 */

import { floorDiv, isqrt } from '../math/bigint-math.js';
import { Q192, tickFromSqrtPrice } from '../v3/tick-math.js';
import { canonicalJsonString } from '../study/canonical.js';
import { TOOL_VERSION } from '../study/manifest.js';

export const POOL_PRIMARY = '0x00000000000000000000000000000000000000a1';
export const POOL_INDEPENDENCE = '0x00000000000000000000000000000000000000a2';
export const POOL_HIGHFEE = '0x00000000000000000000000000000000000000a3';
export const POOL_ZEROLIQ = '0x00000000000000000000000000000000000000a4';

/**
 * EM-STRAT-014-E1-R1: synthetic token addresses (clearly synthetic; the
 * orientation is validated against these on every pool record).
 */
export const WHYPE_ADDRESS = '0x' + '11'.repeat(20);
export const KHYPE_ADDRESS = '0x' + '22'.repeat(20);

export const START_BLOCK = 5_000_000;
export const BLOCK_STEP = 50;
export const SAMPLE_COUNT = 289;
export const START_TS = 1_700_000_000;
export const GRID_STEP_SEC = 600;

const ANCHOR_RAW = 1_000_000_000_000_000_000n; // kHYPEToHYPE = 1.0 (synthetic)
const ANCHOR_RAW_HEX = '0x' + ANCHOR_RAW.toString(16);

/** EM-STRAT-014-E1-R1: synthetic USD reference — $20 per WHYPE, 1e18 scale. */
export const USD_PRICE_RAW = 20n * 1_000_000_000_000_000_000n;
export const USD_PRICE_SOURCE = 'synthetic-usd-reference';

/** Grid index -> block height. */
export function blockAt(gridIndex: number): number {
  return START_BLOCK + gridIndex * BLOCK_STEP;
}

/** Grid index -> block timestamp. */
export function tsAt(gridIndex: number): number {
  return START_TS + gridIndex * GRID_STEP_SEC;
}

/** sqrtPriceX96 for price P = num/den, exact convention. */
export function sqrtPriceX96For(num: bigint, den: bigint): bigint {
  return isqrt(floorDiv(num * Q192, den));
}

/**
 * Liquidity L such that swapping DELTA_X wei of WHYPE from price PS_NUM/PS_DEN
 * realizes average price PS - IMPACT (ratio units): avgP = sqrt(Ps*Pend),
 * Pend = (Ps - IMPACT)^2 / Ps, L = dx * sqrt(Ps) * sqrt(Pend) / (sqrt(Ps) - sqrt(Pend)).
 * Computed at scale SCALE^2 so the floor error is ~1e-20 relative.
 */
export function tunedLiquidity(psNum: bigint, psDen: bigint, impactNumOver10000: bigint, dxWei: bigint): bigint {
  const SCALE = 10n ** 40n;
  // impact is given as impactNumOver10000 / 10000 (ratio units).
  const impactDen = 10_000n;
  // avg = Ps - impact (exact rational)
  const avgN = psNum * impactDen - impactNumOver10000 * psDen;
  const avgD = psDen * impactDen;
  // Pend = avg^2 / Ps
  const pendN = avgN * avgN * psDen;
  const pendD = avgD * avgD * psNum;
  // Scaled square roots (sqrt of price * 10^20).
  const sPs = isqrt(floorDiv(psNum * SCALE, psDen));
  const sPend = isqrt(floorDiv(pendN * SCALE, pendD));
  return floorDiv(dxWei * sPs * sPend, (sPs - sPend) * 10n ** 20n);
}

const DIP_NUM = 1006n;
const DIP_DEN = 1000n;
const IMPACT_NUM = 5n; // 5/10000 = 0.0005
/**
 * $10,000 at the synthetic $20/WHYPE reference = 500 WHYPE = 500*10^18 wei
 * (EXACT — no remainder, no ceil slack). EM-STRAT-014-E1-R1: this is a
 * CONVERTED amount, not an assumed 1 WHYPE = $1 identity.
 */
export const DEPTH_WHYPE_WEI = 500n * 1_000_000_000_000_000_000n;

/** Shared tuned liquidity for pools a1/a2/a3. */
export const TUNED_L: bigint = tunedLiquidity(DIP_NUM, DIP_DEN, IMPACT_NUM, DEPTH_WHYPE_WEI);

const RANGE_LOW = -6000;
const RANGE_HIGH = 6000;

function tickDataFor(L: bigint): Array<{ tick: number; liquidityNetDec: string }> {
  if (L === 0n) return [];
  return [
    { tick: RANGE_LOW, liquidityNetDec: L.toString() },
    { tick: RANGE_HIGH, liquidityNetDec: `-${L.toString()}` },
  ];
}

/** Price scenario per grid index (as exact rational num/den over 1). */
function priceForPool(pool: 'primary' | 'independence' | 'highfee' | 'zeroliq', i: number): [bigint, bigint] {
  const one: [bigint, bigint] = [1000n, 1000n];
  const dip: [bigint, bigint] = [1006n, 1000n]; // d = +0.6%
  const dip7: [bigint, bigint] = [1007n, 1000n]; // d = +0.7%
  const dip8: [bigint, bigint] = [1008n, 1000n]; // d = +0.8%
  const revInBand: [bigint, bigint] = [100005n, 100000n]; // d = +0.005% (inside 0.01% band)
  const revOutOfBand: [bigint, bigint] = [100015n, 100000n]; // d = +0.015% (outside band, below gross 0.02%)
  const inRange = (i: number, a: number, b: number) => i >= a && i <= b;

  switch (pool) {
    case 'primary':
      return inRange(i, 48, 66) ? dip : one;
    case 'independence':
      if (inRange(i, 20, 30)) return dip;
      if (inRange(i, 31, 39)) return revInBand;
      if (inRange(i, 40, 50)) return dip7;
      if (inRange(i, 100, 110)) return dip;
      if (inRange(i, 111, 119)) return revOutOfBand;
      if (inRange(i, 120, 130)) return dip8;
      return one;
    case 'highfee':
      return inRange(i, 60, 72) ? dip : one;
    case 'zeroliq':
      return inRange(i, 150, 160) ? dip : one;
  }
}

export interface SyntheticFixtures {
  'SYNTHETIC-manifest.json': string;
  'raw/anchor.jsonl': string;
  'raw/usd-price.jsonl': string;
  [poolFile: `raw/${string}.jsonl`]: string;
}

export function buildSyntheticManifest(): Record<string, unknown> {
  return {
    toolVersion: TOOL_VERSION,
    manifestId: 'SYNTHETIC-E1-TOOLING-VALIDATION-001',
    synthetic: true,
    chainId: 999,
    window: {
      startBlock: START_BLOCK,
      blockStep: BLOCK_STEP,
      sampleCount: SAMPLE_COUNT,
      startTimestampSec: START_TS,
      gridStepSec: GRID_STEP_SEC,
    },
    conventions: {
      priceConvention: 'khype_per_whype',
      discountFormula: 'd = marketPrice * anchorRate - 1',
      discountSign: 'd > 0 => kHYPE below redemption value (discount)',
      whypeEqualsHype: 'ASSUMPTION_NOT_FACT',
      weiPerWhype: '1000000000000000000',
      anchorStalenessMaxSec: 300,
      anchorFutureToleranceSec: 60,
      impactMeasuredWithFeeZero: true,
    },
    costs: {
      flashloanFeePct: '0.04',
      redemptionFeePct: '0',
    },
    parameters: {
      nEventsPerWeek: '2',
      depthUsd: '10000',
      grossEventThresholdPct: '0.02',
      independenceBandPct: '0.01',
    },
    poolCensus: [
      {
        address: POOL_PRIMARY,
        venue: 'synthetic-hyperswap-v3',
        token0: { symbol: 'WHYPE', decimals: 18, address: WHYPE_ADDRESS },
        token1: { symbol: 'KHYPE', decimals: 18, address: KHYPE_ADDRESS },
        expectedFeeTier: 100,
      },
      {
        address: POOL_INDEPENDENCE,
        venue: 'synthetic-hyperswap-v3',
        token0: { symbol: 'WHYPE', decimals: 18, address: WHYPE_ADDRESS },
        token1: { symbol: 'KHYPE', decimals: 18, address: KHYPE_ADDRESS },
        expectedFeeTier: 100,
      },
      {
        address: POOL_HIGHFEE,
        venue: 'synthetic-hyperswap-v3',
        token0: { symbol: 'WHYPE', decimals: 18, address: WHYPE_ADDRESS },
        token1: { symbol: 'KHYPE', decimals: 18, address: KHYPE_ADDRESS },
        expectedFeeTier: 10000,
      },
      {
        address: POOL_ZEROLIQ,
        venue: 'synthetic-hyperswap-v3',
        token0: { symbol: 'WHYPE', decimals: 18, address: WHYPE_ADDRESS },
        token1: { symbol: 'KHYPE', decimals: 18, address: KHYPE_ADDRESS },
        expectedFeeTier: 100,
      },
    ],
  };
}

/** Anchor records; grid indices 260..263 carry the E1-T4 defects. */
function buildAnchorJsonl(): string {
  const lines: string[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    // i=260: record intentionally MISSING (anchor_unusable:record_missing)
    if (i === 260) continue;
    const ts = tsAt(i);
    let anchorRawHex = ANCHOR_RAW_HEX;
    let anchorReadAtSec = ts;
    if (i === 261) {
      anchorRawHex = '0x'; // undecodable raw -> anchor_unusable:invalid_hex
    } else if (i === 262) {
      anchorReadAtSec = ts - 1200; // stale: 1200s > 300s
    } else if (i === 263) {
      anchorReadAtSec = ts + 900; // future: 900s > 60s
    }
    lines.push(
      JSON.stringify({
        chainId: 999,
        blockHeight: blockAt(i),
        blockTimestampSec: ts,
        anchorRawHex,
        anchorReadAtSec,
      }),
    );
  }
  return lines.join('\n') + '\n';
}

function buildPoolJsonl(pool: 'primary' | 'independence' | 'highfee' | 'zeroliq', address: string, feeTier: number, L: bigint): string {
  const lines: string[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const [pn, pd] = priceForPool(pool, i);
    const S = sqrtPriceX96For(pn, pd);
    const tick = tickFromSqrtPrice(S);
    lines.push(
      JSON.stringify({
        chainId: 999,
        poolAddress: address,
        blockHeight: blockAt(i),
        blockTimestampSec: tsAt(i),
        token0Address: WHYPE_ADDRESS,
        token1Address: KHYPE_ADDRESS,
        sqrtPriceX96Hex: '0x' + S.toString(16),
        tick,
        liquidityHex: '0x' + L.toString(16),
        feeTierMillionths: feeTier,
        tickData: tickDataFor(L),
      }),
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * EM-STRAT-014-E1-R1: per-block USD reference series ($20/WHYPE at every
 * grid block, provenance-bearing). Missing/malformed USD scenarios are
 * constructed by tests, not committed fixtures.
 */
function buildUsdPriceJsonl(): string {
  const lines: string[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    lines.push(
      JSON.stringify({
        chainId: 999,
        blockHeight: blockAt(i),
        blockTimestampSec: tsAt(i),
        priceRawHex: '0x' + USD_PRICE_RAW.toString(16),
        source: USD_PRICE_SOURCE,
      }),
    );
  }
  return lines.join('\n') + '\n';
}

export function buildSyntheticFixtures(): SyntheticFixtures {
  const manifest = canonicalJsonString(buildSyntheticManifest());
  const a1 = `raw/${POOL_PRIMARY}.jsonl` as const;
  const a2 = `raw/${POOL_INDEPENDENCE}.jsonl` as const;
  const a3 = `raw/${POOL_HIGHFEE}.jsonl` as const;
  const a4 = `raw/${POOL_ZEROLIQ}.jsonl` as const;
  return {
    'SYNTHETIC-manifest.json': manifest,
    'raw/anchor.jsonl': buildAnchorJsonl(),
    'raw/usd-price.jsonl': buildUsdPriceJsonl(),
    [a1]: buildPoolJsonl('primary', POOL_PRIMARY, 100, TUNED_L),
    [a2]: buildPoolJsonl('independence', POOL_INDEPENDENCE, 100, TUNED_L),
    [a3]: buildPoolJsonl('highfee', POOL_HIGHFEE, 10000, TUNED_L),
    [a4]: buildPoolJsonl('zeroliq', POOL_ZEROLIQ, 100, 0n),
  };
}
