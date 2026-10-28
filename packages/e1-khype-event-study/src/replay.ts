/**
 * EM-STRAT-014-E1 — replay orchestrator.
 *
 * Pure, offline, deterministic: manifest + raw archive (JSONL strings) in,
 * canonical report JSON out. NO network, NO clock, NO randomness, NO
 * filesystem access here (the CLI owns file reading). Any fail-closed
 * condition produces { ok:false, errors } with explicit, deterministic
 * reasons — the pipeline never fabricates, interpolates, or defaults.
 *
 * EM-STRAT-014-E1-R1 integrity additions:
 *   - chainId is PRESERVED on every decoded record and checked against the
 *     manifest's chainId. ANY mismatch (anchor, pool, or USD price record)
 *     fails the WHOLE replay — data from another chain can never enter a
 *     HyperEVM study, even when every other field looks valid.
 *   - Pool records carry token0/token1 addresses; they must agree exactly
 *     with the census (orientation integrity — the kHYPE-per-WHYPE
 *     interpretation is validated against actual token identity).
 *   - Duplicate anchor records: byte-identical decoded content -> counted
 *     exclusion (first kept, deterministic); conflicting values -> the
 *     replay FAILS CLOSED. Same policy for duplicate USD price records.
 *     Nothing is silently discarded by "first wins" anymore.
 *   - (R2) Same policy now applied to EVERY pool JSONL stream, keyed by
 *     (pool address, block height): identical duplicates are visibly
 *     counted (aggregate.duplicateRecords['duplicate_pool_record']);
 *     conflicting duplicates fail the WHOLE replay with the pool and block
 *     identified — BEFORE buildDiscountSeries runs and before any event or
 *     pass verdict can be built. The former silent first-record-wins
 *     handling inside buildDiscountSeries is superseded here.
 *   - D USD is converted to the walked WHYPE wei amount PER SAMPLE via the
 *     block-aligned, provenance-bearing USD reference price:
 *       depthWei = ceil(D_usd * 10^18 / usdPriceRaw)
 *     The former fixed `D * 10^18` (which silently assumed 1 WHYPE = $1)
 *     is REMOVED. Missing/not-aligned/malformed USD input excludes the
 *     sample from depth evaluation with a counted reason.
 */

import { canonicalJsonString } from './study/canonical.js';
import { buildDiscountSeries, type PoolSeries } from './study/discount-series.js';
import { detectEvents, type DepthExclusion, type DepthResolverResult, type StudyEvent } from './study/events.js';
import { mulDivCeil } from './math/bigint-math.js';
import { rat, ratAdd, ratMul, type Rational } from './math/rational.js';
import { validateManifest, WEI_PER_WHYPE, CONVENTION_DEPTH_CONVERSION, type ParsedManifest } from './study/manifest.js';
import { parseAnchorJsonl, parsePoolJsonl, parseUsdPriceJsonl, poolDuplicateKind, type AnchorRecord, type PoolSampleRecord, type UsdPriceRecord } from './study/raw-archive.js';
import { buildReport, sha256Hex } from './study/report.js';

export interface RawArchiveInput {
  anchorJsonl: string;
  /** pool address (lowercase) -> pool JSONL content */
  poolJsonls: Record<string, string>;
  /**
   * EM-STRAT-014-E1-R1: per-block WHYPE-to-USD reference price series
   * (provenance-bearing; required for the depth conversion).
   */
  usdPriceJsonl: string;
}

export type ReplayResult =
  | { ok: true; reportObject: ReturnType<typeof buildReport>; reportJson: string }
  | { ok: false; errors: string[] };

function expectedBlockAtFactory(startBlock: number, blockStep: number): (gridIndex: number) => number {
  return (gridIndex: number) => startBlock + gridIndex * blockStep;
}

/** feesSumPct = recordedFeeTier/10^4 + flashloanPct + redemptionPct (exact). */
function feesSumForPool(feeTier: number, extraFeesPct: Rational): Rational {
  const feeTierPct = rat(BigInt(feeTier), 10_000n);
  return ratAdd(feeTierPct, extraFeesPct);
}

/**
 * Duplicate policy (EM-STRAT-014-E1-R1): a duplicate record whose decoded
 * content is byte-identical to the kept one is a COUNTED exclusion (first
 * wins, deterministic). A duplicate that CONFLICTS on any decoded field
 * fails the replay — the archive contradicts itself and cannot be trusted.
 * Returns 'identical' | 'conflict'.
 */
function duplicateKind<T>(kept: T, dup: T, fields: Array<(r: T) => string | number | bigint | null>): 'identical' | 'conflict' {
  for (const f of fields) {
    if (f(kept) !== f(dup)) return 'conflict';
  }
  return 'identical';
}

export function runReplay(manifestRaw: unknown, raw: RawArchiveInput): ReplayResult {
  const parsed = validateManifest(manifestRaw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map(e => `manifest:${e}`) };
  const pm: ParsedManifest = parsed.parsed;
  const m = pm.manifest;

  // --- anchor records ---
  const anchorParsed = parseAnchorJsonl(raw.anchorJsonl);
  if (!anchorParsed.ok) return { ok: false, errors: [`raw_archive:${anchorParsed.error}`] };

  // --- usd price records (EM-STRAT-014-E1-R1) ---
  const usdParsed = parseUsdPriceJsonl(raw.usdPriceJsonl);
  if (!usdParsed.ok) return { ok: false, errors: [`raw_archive:${usdParsed.error}`] };

  const duplicateCounts: Record<string, number> = {};
  const bumpDuplicate = (reason: string): void => {
    duplicateCounts[reason] = (duplicateCounts[reason] ?? 0) + 1;
  };

  // --- chainId fail-closed (EM-STRAT-014-E1-R1) ---
  // ANY record from a different chain poisons the whole replay, even when
  // every other field looks valid: the archive cannot be attributed to the
  // studied chain.
  const errors: string[] = [];
  for (const rec of anchorParsed.records) {
    if (rec.chainId !== m.chainId) errors.push(`raw_archive:chain_id_mismatch:anchor:block_${rec.blockHeight}:expected_${m.chainId}_got_${rec.chainId}`);
  }
  for (const rec of usdParsed.records) {
    if (rec.chainId !== m.chainId) errors.push(`raw_archive:chain_id_mismatch:usd_price:block_${rec.blockHeight}:expected_${m.chainId}_got_${rec.chainId}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // --- anchor by-block map with duplicate policy ---
  const anchorByBlock = new Map<number, AnchorRecord>();
  for (const rec of anchorParsed.records) {
    const existing = anchorByBlock.get(rec.blockHeight);
    if (existing === undefined) {
      anchorByBlock.set(rec.blockHeight, rec);
      continue;
    }
    const kind = duplicateKind(existing, rec, [
      r => r.chainId,
      r => r.blockHeight,
      r => r.blockTimestampSec,
      r => r.anchorRaw,
      r => r.anchorReadAtSec,
      r => r.fieldError,
    ]);
    if (kind === 'identical') {
      bumpDuplicate('duplicate_anchor_record');
    } else {
      return { ok: false, errors: [`raw_archive:duplicate_anchor_conflict:block_${rec.blockHeight}:records_disagree_on_decoded_values`] };
    }
  }

  // --- usd price by-block map with duplicate policy ---
  const usdByBlock = new Map<number, UsdPriceRecord>();
  for (const rec of usdParsed.records) {
    const existing = usdByBlock.get(rec.blockHeight);
    if (existing === undefined) {
      usdByBlock.set(rec.blockHeight, rec);
      continue;
    }
    const kind = duplicateKind(existing, rec, [
      r => r.chainId,
      r => r.blockHeight,
      r => r.blockTimestampSec,
      r => r.priceRaw,
      r => r.source,
      r => r.fieldError,
    ]);
    if (kind === 'identical') {
      bumpDuplicate('duplicate_usd_price_record');
    } else {
      return { ok: false, errors: [`raw_archive:duplicate_usd_price_conflict:block_${rec.blockHeight}:records_disagree_on_decoded_values`] };
    }
  }

  // --- per-sample USD -> WHYPE depth resolver (EM-STRAT-014-E1-R1) ---
  // Exact-block alignment (no carry-forward, no interpolation — same
  // policy as the anchor gate). depthWei = ceil(D_usd * 10^18 / usdPriceRaw)
  // — ceil is conservative: the walked amount never understates D.
  const usdPriceSources = new Set<string>();
  for (const rec of usdByBlock.values()) {
    if (rec.source !== null) usdPriceSources.add(rec.source);
  }
  const scale = BigInt(WEI_PER_WHYPE);
  const resolveDepthWei = (s: { blockHeight: number }): DepthResolverResult => {
    const blockHeight = s.blockHeight;
    const rec = usdByBlock.get(blockHeight);
    if (rec === undefined) {
      return { ok: false, reason: 'usd_price_unavailable', detail: `no_usd_price_record_at_block_${blockHeight}` };
    }
    if (rec.fieldError !== null || rec.priceRaw === null) {
      return { ok: false, reason: 'usd_price_malformed', detail: rec.fieldError ?? 'usd_price_undecodable' };
    }
    // depthWei = ceil(D_usd[human] * 10^18[wei per WHYPE] * 10^18[price
    // scale] / (D.den * priceRaw[1e18-scale USD per WHYPE]))
    //   = ceil(D.num * 10^36 / (D.den * priceRaw))
    // e.g. $10,000 at $20/WHYPE -> 10^4*10^36 / (2*10^19) = 500*10^18 wei.
    const wei = mulDivCeil(pm.depthUsd.num * scale * scale, 1n, pm.depthUsd.den * rec.priceRaw);
    if (wei <= 0n) {
      return { ok: false, reason: 'usd_price_malformed', detail: 'depth_conversion_yielded_non_positive_wei' };
    }
    return { ok: true, wei, usdPriceRaw: rec.priceRaw.toString() };
  };

  // --- census coverage checks (fail-closed) ---
  const censusAddresses = m.poolCensus.map(p => p.address);
  const providedAddresses = Object.keys(raw.poolJsonls);
  for (const addr of censusAddresses) {
    if (!providedAddresses.includes(addr)) errors.push(`raw_archive:pool_file_missing:${addr}`);
  }
  for (const addr of providedAddresses) {
    if (!censusAddresses.includes(addr)) errors.push(`raw_archive:pool_file_not_in_census:${addr}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // --- per-pool series + events ---
  const expectedBlockAt = expectedBlockAtFactory(m.window.startBlock, m.window.blockStep);
  const poolResults: Array<{ series: PoolSeries; events: StudyEvent[]; depthExclusions: DepthExclusion[]; venue: string }> = [];

  for (const censusEntry of m.poolCensus) {
    const poolParsed = parsePoolJsonl(raw.poolJsonls[censusEntry.address], censusEntry.address);
    if (!poolParsed.ok) return { ok: false, errors: [`raw_archive:${poolParsed.error}`] };
    const records: PoolSampleRecord[] = poolParsed.records;

    // --- chainId + token-address integrity for pool records ---
    for (const rec of records) {
      if (rec.chainId !== m.chainId) {
        return { ok: false, errors: [`raw_archive:chain_id_mismatch:pool_${censusEntry.address}:block_${rec.blockHeight}:expected_${m.chainId}_got_${rec.chainId}`] };
      }
      // Orientation integrity: the recorded token addresses must agree
      // EXACTLY with the census (which already enforces token0=WHYPE,
      // token1=kHYPE). A record whose token set differs cannot be
      // attributed to this pool's declared market — fail closed.
      if (rec.token0Address !== null && rec.token0Address !== censusEntry.token0.address) {
        return { ok: false, errors: [`raw_archive:token_address_mismatch:pool_${censusEntry.address}:block_${rec.blockHeight}:token0_expected_${censusEntry.token0.address}_got_${rec.token0Address}`] };
      }
      if (rec.token1Address !== null && rec.token1Address !== censusEntry.token1.address) {
        return { ok: false, errors: [`raw_archive:token_address_mismatch:pool_${censusEntry.address}:block_${rec.blockHeight}:token1_expected_${censusEntry.token1.address}_got_${rec.token1Address}`] };
      }
      if (rec.fieldError === null && censusEntry.expectedFeeTier !== null && rec.feeTier !== censusEntry.expectedFeeTier) {
        // Recorded fee contradicts the census expectation: visible, counted.
        rec.fieldError = `fee_tier_mismatch_vs_census:expected_${censusEntry.expectedFeeTier}_recorded_${String(rec.feeTier)}`;
      }
    }

    // --- per-pool duplicate policy (EM-STRAT-014-E1-R2) ---
    // Same integrity rule as the anchor/USD streams, applied to each pool's
    // JSONL BEFORE any series, event, or pass verdict is built: two records
    // at the same (pool address, block height) must agree on EVERY decoded
    // field (incl. the full ordered tick data and fieldError state).
    // Identical duplicates are visibly counted in the aggregate duplicate
    // report; conflicting duplicates FAIL the whole replay with the pool
    // and block identified — buildDiscountSeries can no longer silently
    // keep a first conflicting record.
    const poolByBlock = new Map<number, PoolSampleRecord>();
    for (const rec of records) {
      const existing = poolByBlock.get(rec.blockHeight);
      if (existing === undefined) {
        poolByBlock.set(rec.blockHeight, rec);
        continue;
      }
      if (poolDuplicateKind(existing, rec) === 'identical') {
        bumpDuplicate('duplicate_pool_record');
      } else {
        return { ok: false, errors: [`raw_archive:duplicate_pool_conflict:pool_${censusEntry.address}:block_${rec.blockHeight}:records_disagree_on_decoded_values`] };
      }
    }

    const series = buildDiscountSeries(
      censusEntry.address,
      m.window.sampleCount,
      expectedBlockAt,
      { byBlock: anchorByBlock },
      [...poolByBlock.values()],
      m.conventions.anchorStalenessMaxSec,
      m.conventions.anchorFutureToleranceSec,
      pm.independenceBandPct,
    );

    // feesSum from the RECORDED fee tier (never assumed). Pools with no
    // usable sample get no events and surface as fully excluded.
    const feesSum = series.feeTierRecorded !== null
      ? feesSumForPool(series.feeTierRecorded, pm.extraFeesPct)
      : null;

    let events: StudyEvent[] = [];
    let depthExclusions: DepthExclusion[] = [];
    if (feesSum !== null) {
      const res = detectEvents(series, pm.grossEventThresholdPct, feesSum, resolveDepthWei);
      events = res.events;
      depthExclusions = res.depthExclusions;
    }

    poolResults.push({ series, events, depthExclusions, venue: censusEntry.venue });
  }

  // --- canonical manifest digest (over the CANONICAL form of the manifest) ---
  const manifestCanonical = canonicalJsonString(m);
  const manifestSha = sha256Hex(manifestCanonical);

  const reportObject = buildReport(pm, manifestSha, poolResults, {
    duplicateCounts,
    usdPriceSources: [...usdPriceSources].sort(),
    depthConversion: CONVENTION_DEPTH_CONVERSION,
  });
  const reportJson = canonicalJsonString(reportObject);
  return { ok: true, reportObject, reportJson };
}

// Re-exports used by tests and the CLI.
export { WEI_PER_WHYPE, CONVENTION_DEPTH_CONVERSION, ratMul };
