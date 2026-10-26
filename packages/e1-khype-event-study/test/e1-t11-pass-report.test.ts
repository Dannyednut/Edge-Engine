/**
 * EM-STRAT-014-E1 — E1-T11 pass-rule report test: the verdict is BOUND to
 * the pre-registered manifest parameters. It changes ONLY when N or D (or
 * the data) change, and the tool refuses to run when they are missing.
 */

import { describe, expect, it } from 'vitest';
import { cloneManifest, loadCommittedFixtures, replayCommitted } from './_helpers.js';
import { runReplay } from '../src/replay.js';

function replayVariant(mutate: (m: Record<string, unknown>) => void): ReturnType<typeof runReplay> {
  const fx = loadCommittedFixtures();
  const m = cloneManifest(fx.manifest);
  mutate(m);
  return runReplay(m, { anchorJsonl: fx.anchorJsonl, poolJsonls: fx.poolJsonls });
}

describe('E1-T11 — the pass-rule report binds to the pre-registered N and D', () => {
  it('base run: N=2, D=$10k -> 4 qualifying events, 14/week >= 2 -> synthetic ADVANCE', () => {
    const result = replayCommitted();
    const a = result.reportObject.aggregate;
    expect(a.qualifyingEvents).toBe(4);
    expect(a.failingEvents).toBe(2);
    expect(a.eventsPerWeekExact).toBe('14/1');
    expect(result.reportObject.verdict.advance).toBe(true);
    expect(result.reportObject.verdict.verdict).toBe('ADVANCE_TO_CONTROLLED_PAPER_VALIDATION');
    expect(result.reportObject.verdict.basis).toBe('synthetic-tooling-validation-only');
    // the report states N, D, and the window explicitly
    expect(result.reportObject.parameters.nEventsPerWeek).toBe('2');
    expect(result.reportObject.parameters.depthUsd).toBe('10000');
    expect(result.reportObject.window.windowSec).toBe(172800);
    // every exclusion is present with a reason (nothing silently dropped)
    expect(a.exclusionsTotal).toBe(17);
    expect(a.exclusionsByReason['anchor_unusable']).toBe(16);
    expect(a.exclusionsByReason['depth_quote_failed']).toBe(1);
  });

  it('raising N to 20 flips the verdict to RETAIN — nothing else changes', () => {
    const result = replayVariant(m => {
      (m.parameters as Record<string, unknown>).nEventsPerWeek = '20';
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // same events, same exclusions — only the threshold moved
    expect(result.reportObject.aggregate.qualifyingEvents).toBe(4);
    expect(result.reportObject.aggregate.exclusionsTotal).toBe(17);
    expect(result.reportObject.verdict.advance).toBe(false);
    expect(result.reportObject.verdict.verdict).toBe('RETAIN_MONITORING_ONLY');
  });

  it('raising D to $5M makes impact(D) dominate: all qualifying events fail -> RETAIN', () => {
    const result = replayVariant(m => {
      (m.parameters as Record<string, unknown>).depthUsd = '5000000';
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reportObject.aggregate.qualifyingEvents).toBe(0);
    expect(result.reportObject.aggregate.failingEvents).toBe(6);
    expect(result.reportObject.verdict.verdict).toBe('RETAIN_MONITORING_ONLY');
    // events are still DETECTED (gross dislocations exist) — they fail on
    // depth economics, which is exactly the pass-rule semantics
    const totalEvents = result.reportObject.pools.reduce((acc, p) => acc + p.events.length, 0);
    expect(totalEvents).toBe(6);
  });

  it('boundary: N = 14 exactly still advances (>= semantics), N slightly above does not', () => {
    const atThreshold = replayVariant(m => {
      (m.parameters as Record<string, unknown>).nEventsPerWeek = '14';
    });
    expect(atThreshold.ok).toBe(true);
    if (atThreshold.ok) expect(atThreshold.reportObject.verdict.advance).toBe(true);

    const above = replayVariant(m => {
      (m.parameters as Record<string, unknown>).nEventsPerWeek = '14.000001';
    });
    expect(above.ok).toBe(true);
    if (above.ok) expect(above.reportObject.verdict.advance).toBe(false);
  });
});
