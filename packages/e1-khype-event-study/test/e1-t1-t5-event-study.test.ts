/**
 * EM-STRAT-014-E1 — event-study replay tests (E1-T1..T5) over the
 * committed synthetic 48h fixture set. Scenario map + provenance:
 * fixtures/synthetic-48h/PROVENANCE.md.
 */

import { describe, expect, it } from 'vitest';
import { poolByAddress, replayCommitted, expectRatNear } from './_helpers.js';

describe('E1-T1 — single 3h dip detected with exact net arithmetic', () => {
  const result = replayCommitted();

  it('detects exactly 1 event on the primary pool', () => {
    const pool = poolByAddress(result, '00a1');
    expect(pool.events).toHaveLength(1);
  });

  it('d_max ~= 0.6%, duration == 3h, and the event passes the rule at depth D', () => {
    const ev = poolByAddress(result, '00a1').events[0];
    expectRatNear(ev.dMaxPctExact, '0.6', '0.000000000001');
    expect(ev.durationSec).toBe(10800); // exactly 3h on the 10-min grid
    expect(ev.startTsSec).toBe(1700000000 + 48 * 600);
    expect(ev.endTsSec).toBe(1700000000 + 66 * 600);
    expect(ev.spannedExclusionGap).toBe(false);
    expect(ev.passed).toBe(true);
    expect(ev.qualifyingSampleBlock).toBe(5002400); // first dip sample
    // fees = 0.01 (pool fee tier, RECORDED not assumed) + 0.04 (flashloan)
    //      + 0 (redemption; synthetic manifest) = 0.05 percent
    expectRatNear(ev.feesPctExact, '0.05', '0.000000000001');
    // impact(D) measured by the tick-walk at the tuned fixture liquidity
    expectRatNear(ev.impactAtDMaxPctExact as string, '0.05', '0.000000001');
    // net = 0.6 - 0.01 - 0.04 - 0.05 = 0.50 percent > 0 (the T1 identity)
    expectRatNear(ev.netAtDMaxPctExact as string, '0.5', '0.000000001');
    // depth quote exists and crossed no ticks (wide single range)
    expect(ev.depthQuote).not.toBeNull();
    expect(ev.depthQuote?.ticksCrossed).toEqual([]);
    expect(BigInt(ev.depthQuote?.amountOut as string)).toBeGreaterThan(0n);
  });
});

describe('E1-T2 — reversion INSIDE the band separates two independent events', () => {
  const result = replayCommitted();

  it('yields exactly 2 events for the first dip pair (not 1 merged, not 3 split)', () => {
    const pool = poolByAddress(result, '00a2');
    expect(pool.events).toHaveLength(3); // 2 from the T2 pair + 1 merged T3 event
    const [e1, e2] = pool.events;
    // strictly separated in blocks, no gap spanning
    expect(e1.endBlockHeight).toBeLessThan(e2.startBlockHeight);
    expect(e1.spannedExclusionGap).toBe(false);
    expect(e2.spannedExclusionGap).toBe(false);
    // depths follow the fixture scenario (0.6% and 0.7% dips)
    expectRatNear(e1.dMaxPctExact, '0.6', '0.000000000001');
    expectRatNear(e2.dMaxPctExact, '0.7', '0.000000000001');
    // each dip is 11 samples on the grid => duration 6000s
    expect(e1.durationSec).toBe(6000);
    expect(e2.durationSec).toBe(6000);
    // both qualify economically
    expect(e1.passed).toBe(true);
    expect(e2.passed).toBe(true);
  });
});

describe('E1-T3 — reversion OUTSIDE the band merges into ONE event (manifest rule == code)', () => {
  const result = replayCommitted();

  it('counts the second dip pair as exactly 1 merged event spanning the failed reversion', () => {
    const pool = poolByAddress(result, '00a2');
    const merged = pool.events[2];
    // spans dip1 start (i=100) through dip2 end (i=130): 30 grid steps
    expect(merged.startBlockHeight).toBe(5000000 + 100 * 50);
    expect(merged.endBlockHeight).toBe(5000000 + 130 * 50);
    expect(merged.durationSec).toBe(30 * 600);
    expect(merged.sampleCount).toBe(31);
    expect(merged.spannedExclusionGap).toBe(false);
    // d_max is the deeper second dip (0.8%)
    expectRatNear(merged.dMaxPctExact, '0.8', '0.000000000001');
    expect(merged.passed).toBe(true);
  });
});

describe('E1-T4 — unusable anchors exclude samples, never interpolate, never carry forward', () => {
  const result = replayCommitted();
  const BAD_BLOCKS = [5013000, 5013050, 5013100, 5013150];

  it('excludes all four defective anchor blocks with reason anchor_unusable + explicit details', () => {
    const pool = poolByAddress(result, '00a1');
    const anchorEx = pool.exclusions.filter(e => e.reason === 'anchor_unusable');
    expect(anchorEx.map(e => e.blockHeight)).toEqual(BAD_BLOCKS);
    const details = anchorEx.map(e => e.detail ?? '').join('|');
    expect(details).toContain('anchor_record_missing_at_declared_block');
    expect(details).toContain('invalid_hex:anchorRawHex:"0x"');
    expect(details).toContain('anchor_read_stale:1200s>300s');
    expect(details).toContain('anchor_read_future:900s>60s');
    // every pool in the census is affected identically (anchor is global)
    for (const suffix of ['00a1', '00a2', '00a3', '00a4']) {
      expect(poolByAddress(result, suffix).samplesUsable).toBe(285);
    }
  });

  it('produces NO discount value for excluded blocks (no interpolation, no carry-forward)', () => {
    const pool = poolByAddress(result, '00a1');
    for (const b of BAD_BLOCKS) {
      expect(pool.series.find(s => s.blockHeight === b)).toBeUndefined();
    }
    // neighbors keep their OWN values: baseline 0 before, baseline 0 after
    expect(pool.series.find(s => s.blockHeight === 5012950)?.dPct).toBe('0.000000000000');
    expect(pool.series.find(s => s.blockHeight === 5013200)?.dPct).toBe('0.000000000000');
  });
});

describe('E1-T5 — fee-heavy pool: dip detected but FAILS the rule (counted as failing)', () => {
  const result = replayCommitted();

  it('detects the dip, records fees 1.04% > d_max 0.6%, and fails without a qualifying sample', () => {
    const pool = poolByAddress(result, '00a3');
    expect(pool.events).toHaveLength(1);
    const ev = pool.events[0];
    expect(ev.passed).toBe(false);
    expect(ev.failingReason).toBe('net_never_positive');
    expectRatNear(ev.dMaxPctExact, '0.6', '0.000000000001');
    expectRatNear(ev.feesPctExact, '1.04', '0.000000000001'); // 1.00 tier + 0.04 flashloan
    // impact was never measured (d_max <= feesSum everywhere -> skip-safe)
    expect(ev.depthQuote).toBeNull();
    expect(ev.impactAtDMaxPctExact).toBeNull();
    expect(ev.netAtDMaxPctExact).toBeNull();
    expect(ev.qualifyingSampleBlock).toBeNull();
    // the failing event is reflected in the aggregate
    expect(result.reportObject.aggregate.failingEvents).toBeGreaterThanOrEqual(1);
    expect(result.reportObject.aggregate.qualifyingEvents).toBe(4);
  });
});
