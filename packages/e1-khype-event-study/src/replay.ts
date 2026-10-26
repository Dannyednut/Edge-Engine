/**
 * EM-STRAT-014-E1 — replay orchestrator.
 *
 * Pure, offline, deterministic: manifest + raw archive (JSONL strings) in,
 * canonical report JSON out. NO network, NO clock, NO randomness, NO
 * filesystem access here (the CLI owns file reading). Any fail-closed
 * condition produces { ok:false, errors } with explicit, deterministic
 * reasons — the pipeline never fabricates, interpolates, or defaults.
 */

import { canonicalJsonString } from './study/canonical.js';
import { buildDiscountSeries, type PoolSeries } from './study/discount-series.js';
import { detectEvents, type DepthExclusion, type StudyEvent } from './study/events.js';
import { rat, ratAdd, ratMul, type Rational } from './math/rational.js';
import { validateManifest, WEI_PER_WHYPE, type ParsedManifest } from './study/manifest.js';
import { parseAnchorJsonl, parsePoolJsonl, type AnchorRecord, type PoolSampleRecord } from './study/raw-archive.js';
import { buildReport, sha256Hex } from './study/report.js';

export interface RawArchiveInput {
  anchorJsonl: string;
  /** pool address (lowercase) -> pool JSONL content */
  poolJsonls: Record<string, string>;
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

export function runReplay(manifestRaw: unknown, raw: RawArchiveInput): ReplayResult {
  const parsed = validateManifest(manifestRaw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map(e => `manifest:${e}`) };
  const pm: ParsedManifest = parsed.parsed;
  const m = pm.manifest;

  // --- anchor records ---
  const anchorParsed = parseAnchorJsonl(raw.anchorJsonl);
  if (!anchorParsed.ok) return { ok: false, errors: [`raw_archive:${anchorParsed.error}`] };
  const anchorByBlock = new Map<number, AnchorRecord>();
  for (const rec of anchorParsed.records) {
    if (!anchorByBlock.has(rec.blockHeight)) anchorByBlock.set(rec.blockHeight, rec);
    // Later duplicate anchor lines are ignored (first wins) — deterministic;
    // the pool-level duplicate rule is the one that counts exclusions.
  }

  // --- census coverage checks (fail-closed) ---
  const errors: string[] = [];
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
    for (const rec of records) {
      if (rec.fieldError === null && censusEntry.expectedFeeTier !== null && rec.feeTier !== censusEntry.expectedFeeTier) {
        // Recorded fee contradicts the census expectation: visible, counted.
        rec.fieldError = `fee_tier_mismatch_vs_census:expected_${censusEntry.expectedFeeTier}_recorded_${String(rec.feeTier)}`;
      }
    }

    const series = buildDiscountSeries(
      censusEntry.address,
      m.window.sampleCount,
      expectedBlockAt,
      { byBlock: anchorByBlock },
      records,
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
      const res = detectEvents(series, pm.grossEventThresholdPct, feesSum, pm.depthNotionalWei);
      events = res.events;
      depthExclusions = res.depthExclusions;
    }

    poolResults.push({ series, events, depthExclusions, venue: censusEntry.venue });
  }

  // --- canonical manifest digest (over the CANONICAL form of the manifest) ---
  const manifestCanonical = canonicalJsonString(m);
  const manifestSha = sha256Hex(manifestCanonical);

  const reportObject = buildReport(pm, manifestSha, poolResults);
  const reportJson = canonicalJsonString(reportObject);
  return { ok: true, reportObject, reportJson };
}

// Re-exports used by tests and the CLI.
export { WEI_PER_WHYPE, ratMul };
