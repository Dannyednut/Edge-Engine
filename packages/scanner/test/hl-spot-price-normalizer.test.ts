/**
 * hl-spot-price-normalizer.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * Tests the @-pair price normalization against all 6 EI-supplied
 * reference values, plus regression tests for named pairs.
 *
 * Evidence source: EIS004_RESEARCH_REPORT.md §5.4b / table T7
 * Raw responses archived by EI at evidence/EI-S004/hl_spotmeta_final_*.json
 * and hl_allmids_final_*.json
 */
import { describe, it, expect } from 'vitest';
import { normalizeSpotPrices, parseAllMidsResponse } from '../src/strategies/hl-spot-price-normalizer.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Build a fake spotMetaAndAssetCtxs response for a list of pairs.
 *  Returns [meta, ctxs] where meta = { universe: [...], tokens: [...] }
 *  matching the actual HL API response structure. */
function buildSpotMeta(pairs: { name: string; markPx: string; tokens?: [string, string]; dayNtlVlm?: string }[]): any {
  // Collect unique token names in order of appearance
  const tokenList: string[] = [];
  for (const p of pairs) {
    if (p.tokens) {
      for (const t of p.tokens) {
        if (!tokenList.includes(t)) tokenList.push(t);
      }
    }
  }
  // Build tokens array: [{ name: 'HYPE' }, { name: 'USDC' }, ...]
  const tokens = tokenList.map(name => ({ name }));

  // Build universe: each entry has name + token indices
  const universe = pairs.map(p => {
    const tokenIndices = p.tokens
      ? p.tokens.map(t => tokenList.indexOf(t))
      : [0, 1];
    return { name: p.name, tokens: tokenIndices };
  });

  // Build ctxs: one per universe entry
  const ctxs = pairs.map(p => ({
    markPx: p.markPx,
    dayNtlVlm: p.dayNtlVlm ?? '100000',
  }));

  return [{ universe, tokens }, ctxs];
}

/** Build a fake allMids response. */
function buildAllMids(entries: Record<string, number>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [k, v] of Object.entries(entries)) {
    m.set(k, v);
  }
  return m;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('hl-spot-price-normalizer — EI-S004 @-pair reference values', () => {
  // The 6 verified @-pair values from EI-S004 table T7.
  // Each entry: [pairName, ctxMarkPx (simulating corrupted ctx), allMidsTruePrice]
  // Note: EI tested midPx; we simulate markPx corruption (same response object).
  // The normalizer cross-validates markPx against allMids regardless of
  // which ctx field was originally tested.
  const REFERENCE_PAIRS = [
    { name: '@107', tokens: ['HYPE', 'USDC'] as [string, string], ctxMarkPx: '0.081882', allMids: 80.8905 },
    { name: '@166', tokens: ['USDT0', 'USDC'] as [string, string], ctxMarkPx: '0.161245', allMids: 0.999095 },
    { name: '@285', tokens: ['AZTEC', 'USDC'] as [string, string], ctxMarkPx: '778.355', allMids: 0.0201265 },
    { name: '@336', tokens: ['KHYPE', 'USDC'] as [string, string], ctxMarkPx: '0.022722', allMids: 83.04 },
    { name: '@109', tokens: ['WOW', 'USDC'] as [string, string], ctxMarkPx: '80.8035', allMids: 0.00025758 },
    { name: '@144', tokens: ['NEKO', 'USDC'] as [string, string], ctxMarkPx: '83354.5', allMids: 0.000146 },
  ];

  it('all 6 @-pairs: ctx markPx is rejected in favor of allMids', () => {
    const spotMeta = buildSpotMeta(
      REFERENCE_PAIRS.map(p => ({ name: p.name, markPx: p.ctxMarkPx, tokens: p.tokens })),
    );
    const allMids = buildAllMids(
      Object.fromEntries(REFERENCE_PAIRS.map(p => [p.name, p.allMids])),
    );

    const result = normalizeSpotPrices(spotMeta, allMids);

    expect(result.fallbackCount).toBe(6);
    expect(result.rejectedCount).toBe(0);
    expect(result.trustedCount).toBe(0);

    for (const p of REFERENCE_PAIRS) {
      const np = result.prices.get(p.name);
      expect(np).toBeDefined();
      expect(np!.source).toBe('allmids');
      expect(np!.trusted).toBe(true);
      // The allMids value should be used (within floating-point tolerance)
      expect(np!.price).toBeCloseTo(p.allMids, 9);
    }
  });

  it('@107 HYPE/USDC: ctx 0.081882 → allMids 80.8905', () => {
    const spotMeta = buildSpotMeta([
      { name: '@107', markPx: '0.081882', tokens: ['HYPE', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@107': 80.8905 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@107')!;
    expect(np.price).toBeCloseTo(80.8905, 9);
    expect(np.source).toBe('allmids');
    expect(np.trusted).toBe(true);
  });

  it('@166 USDT0/USDC: ctx 0.161245 → allMids 0.999095', () => {
    const spotMeta = buildSpotMeta([
      { name: '@166', markPx: '0.161245', tokens: ['USDT0', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@166': 0.999095 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@166')!;
    expect(np.price).toBeCloseTo(0.999095, 9);
    expect(np.source).toBe('allmids');
  });

  it('@285 AZTEC/USDC: ctx 778.355 → allMids 0.0201265', () => {
    const spotMeta = buildSpotMeta([
      { name: '@285', markPx: '778.355', tokens: ['AZTEC', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@285': 0.0201265 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@285')!;
    expect(np.price).toBeCloseTo(0.0201265, 9);
    expect(np.source).toBe('allmids');
  });

  it('@336 KHYPE/USDC: ctx 0.022722 → allMids 83.04', () => {
    const spotMeta = buildSpotMeta([
      { name: '@336', markPx: '0.022722', tokens: ['KHYPE', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@336': 83.04 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@336')!;
    expect(np.price).toBeCloseTo(83.04, 9);
    expect(np.source).toBe('allmids');
  });

  it('@109 WOW/USDC: ctx 80.8035 → allMids 0.00025758', () => {
    const spotMeta = buildSpotMeta([
      { name: '@109', markPx: '80.8035', tokens: ['WOW', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@109': 0.00025758 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@109')!;
    expect(np.price).toBeCloseTo(0.00025758, 9);
    expect(np.source).toBe('allmids');
  });

  it('@144 NEKO/USDC: ctx 83354.5 → allMids 0.000146', () => {
    const spotMeta = buildSpotMeta([
      { name: '@144', markPx: '83354.5', tokens: ['NEKO', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@144': 0.000146 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@144')!;
    expect(np.price).toBeCloseTo(0.000146, 9);
    expect(np.source).toBe('allmids');
  });
});

describe('hl-spot-price-normalizer — named pairs (regression prevention)', () => {
  it('PURR/USDC named pair: ctx markPx is trusted when consistent with allMids', () => {
    // EI verified: PURR/USDC ctx 0.10964 ≈ allMids PURR 0.109735 — consistent
    const spotMeta = buildSpotMeta([
      { name: 'PURR/USDC', markPx: '0.10964', tokens: ['PURR', 'USDC'] },
    ]);
    const allMids = buildAllMids({ 'PURR': 0.109735 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('PURR/USDC')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('ctx');
    expect(np.price).toBeCloseTo(0.10964, 9);
  });

  it('named pair with no allMids reference: ctx is trusted (per EI evidence)', () => {
    // EI verified named pairs are correct; no allMids needed
    const spotMeta = buildSpotMeta([
      { name: 'SOME/USDC', markPx: '1.234', tokens: ['SOME', 'USDC'] },
    ]);
    const allMids = buildAllMids({});
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('SOME/USDC')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('ctx');
    expect(np.price).toBeCloseTo(1.234, 9);
  });

  it('named pair diverging from allMids: falls back to allMids', () => {
    const spotMeta = buildSpotMeta([
      { name: 'TEST/USDC', markPx: '100.0', tokens: ['TEST', 'USDC'] },
    ]);
    const allMids = buildAllMids({ 'TEST': 1.0 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('TEST/USDC')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('allmids');
    expect(np.price).toBeCloseTo(1.0, 9);
  });
});

describe('hl-spot-price-normalizer — edge cases', () => {
  it('@-pair with no allMids reference: marked untrusted', () => {
    const spotMeta = buildSpotMeta([
      { name: '@999', markPx: '5.0', tokens: ['UNK', 'USDC'] },
    ]);
    const allMids = buildAllMids({});
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@999')!;
    expect(np.trusted).toBe(false);
    expect(np.source).toBe('ctx');
    expect(np.rejectReason).toContain('no allMids reference');
  });

  it('@-pair with ctx markPx=0 and allMids available: uses allMids', () => {
    const spotMeta = buildSpotMeta([
      { name: '@100', markPx: '0', tokens: ['X', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@100': 42.5 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@100')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('allmids');
    expect(np.price).toBeCloseTo(42.5, 9);
  });

  it('@-pair with ctx markPx consistent with allMids: uses ctx', () => {
    // If ctx markPx is actually correct (within 5%), use it directly
    const spotMeta = buildSpotMeta([
      { name: '@200', markPx: '100.5', tokens: ['Y', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@200': 100.0 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@200')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('ctx');
    expect(np.price).toBeCloseTo(100.5, 9);
  });

  it('empty/null spotMeta: returns empty result', () => {
    const result1 = normalizeSpotPrices(null, new Map());
    expect(result1.prices.size).toBe(0);
    const result2 = normalizeSpotPrices([], new Map());
    expect(result2.prices.size).toBe(0);
  });

  it('counts are correct for mixed scenario', () => {
    const spotMeta = buildSpotMeta([
      { name: '@107', markPx: '0.081882', tokens: ['HYPE', 'USDC'] },  // fallback
      { name: '@200', markPx: '100.5', tokens: ['Y', 'USDC'] },         // trusted ctx
      { name: '@999', markPx: '5.0', tokens: ['Z', 'USDC'] },           // rejected
      { name: 'PURR/USDC', markPx: '0.10964', tokens: ['PURR', 'USDC'] }, // trusted named
    ]);
    const allMids = buildAllMids({
      '@107': 80.8905,
      '@200': 100.0,
      'PURR': 0.109735,
    });
    const result = normalizeSpotPrices(spotMeta, allMids);
    expect(result.fallbackCount).toBe(1);  // @107
    expect(result.trustedCount).toBe(2);    // @200 + PURR
    expect(result.rejectedCount).toBe(1);   // @999
  });
});

describe('hl-spot-price-normalizer — markPx vs midPx distinction', () => {
  it('the normalizer validates markPx (not midPx) independently', () => {
    // This test documents that the normalizer reads ctx.markPx, not ctx.midPx.
    // EI's evidence was about midPx; this module validates markPx separately.
    // If markPx is also corrupted (as simulated in the reference tests above),
    // the normalizer catches it via the allMids cross-check.
    const spotMeta = buildSpotMeta([
      { name: '@107', markPx: '0.081882', tokens: ['HYPE', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@107': 80.8905 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@107')!;
    // The normalizer read markPx (0.081882), found it diverged from allMids
    // (80.8905), and fell back to allMids. This proves markPx is validated
    // independently — we did NOT assume markPx has the same defect as midPx;
    // we detected it via cross-validation.
    expect(np.source).toBe('allmids');
    expect(np.ctxPrice).toBeCloseTo(0.081882, 9);
    expect(np.allMidsPrice).toBeCloseTo(80.8905, 9);
  });
});

// ─── parseAllMidsResponse tests ─────────────────────────────────────

describe('parseAllMidsResponse — live response shape', () => {
  // The actual live allMids response (verified 2026-10-14 07:28Z) is a
  // FLAT top-level map, NOT wrapped in { mids: {...} }.
  // The old code read resp.mids which returned undefined → empty map →
  // all normalizer fallbacks silently failed.

  it('parses a flat top-level map (the actual live shape)', () => {
    const liveResp = {
      '@107': '81.9725',
      '@166': '0.999145',
      '@285': '0.0200915',
      '@336': '84.135',
      '@109': '0.00025755',
      '@144': '0.000146',
      '#102220': '0.0012',
      'HYPE': '81.9455',
      'PURR': '0.11152',
    };
    const mids = parseAllMidsResponse(liveResp);
    expect(mids.size).toBe(9);
    expect(mids.get('@107')).toBeCloseTo(81.9725, 9);
    expect(mids.get('@166')).toBeCloseTo(0.999145, 9);
    expect(mids.get('@336')).toBeCloseTo(84.135, 9);
    expect(mids.get('HYPE')).toBeCloseTo(81.9455, 9);
    expect(mids.get('PURR')).toBeCloseTo(0.11152, 9);
  });

  it('contains @107, @166, @336 reference values from a live-like payload', () => {
    const liveResp = {
      '@107': '81.97',
      '@166': '0.999',
      '@336': '84.10',
    };
    const mids = parseAllMidsResponse(liveResp);
    expect(mids.has('@107')).toBe(true);
    expect(mids.has('@166')).toBe(true);
    expect(mids.has('@336')).toBe(true);
    expect(mids.get('@107')!).toBeGreaterThan(80);
    expect(mids.get('@166')!).toBeGreaterThan(0.99);
    expect(mids.get('@166')!).toBeLessThan(1.01);
  });

  it('also handles the wrapped shape { mids: {...} } for backward compat', () => {
    // Some SDKs or older docs may wrap the response
    const wrappedResp = {
      mids: {
        '@107': '81.97',
        'HYPE': '81.95',
      },
    };
    const mids = parseAllMidsResponse(wrappedResp);
    expect(mids.size).toBe(2);
    expect(mids.get('@107')).toBeCloseTo(81.97, 9);
    expect(mids.get('HYPE')).toBeCloseTo(81.95, 9);
  });

  it('handles numeric values (not just strings)', () => {
    const numericResp = {
      '@107': 81.97,
      'HYPE': 81.95,
    };
    const mids = parseAllMidsResponse(numericResp);
    expect(mids.size).toBe(2);
    expect(mids.get('@107')).toBeCloseTo(81.97, 9);
  });
});

describe('parseAllMidsResponse — malformed/edge cases', () => {
  it('returns empty map for null', () => {
    expect(parseAllMidsResponse(null).size).toBe(0);
  });

  it('returns empty map for undefined', () => {
    expect(parseAllMidsResponse(undefined).size).toBe(0);
  });

  it('returns empty map for empty object', () => {
    expect(parseAllMidsResponse({}).size).toBe(0);
  });

  it('returns empty map for array (wrong type)', () => {
    expect(parseAllMidsResponse(['81.97', '0.999']).size).toBe(0);
  });

  it('returns empty map for string (wrong type)', () => {
    expect(parseAllMidsResponse('not a response').size).toBe(0);
  });

  it('filters out invalid prices (zero, negative, NaN, Infinity)', () => {
    const malformedResp = {
      '@107': '81.97',      // valid
      '@166': '0',          // zero — filtered
      '@285': '-1.5',       // negative — filtered
      '@336': 'NaN',        // NaN — filtered
      '@109': 'Infinity',   // Infinity — filtered
      '@144': 'abc',        // non-numeric — filtered
      'HYPE': '81.95',      // valid
    };
    const mids = parseAllMidsResponse(malformedResp);
    expect(mids.size).toBe(2);  // only @107 and HYPE
    expect(mids.has('@107')).toBe(true);
    expect(mids.has('HYPE')).toBe(true);
    expect(mids.has('@166')).toBe(false);
    expect(mids.has('@285')).toBe(false);
    expect(mids.has('@336')).toBe(false);
  });

  it('filters out non-string/non-number values', () => {
    const weirdResp = {
      '@107': '81.97',
      '@166': { nested: 'object' },
      '@285': [1, 2, 3],
      '@336': null,
      '@109': true,
    };
    const mids = parseAllMidsResponse(weirdResp);
    expect(mids.size).toBe(1);  // only @107
    expect(mids.has('@107')).toBe(true);
  });

  it('does NOT treat an empty parsed map as a successful response', () => {
    // An empty map means no reference prices available. The normalizer
    // must mark @-pair ctx prices as untrusted (rejected), not silently
    // accept them. This is tested in the normalizer tests above
    // ("@-pair with no allMids reference: marked untrusted").
    const emptyResp = {};
    const mids = parseAllMidsResponse(emptyResp);
    expect(mids.size).toBe(0);
    // The caller (fetchAllMids) logs a warning when size===0, and the
    // normalizer rejects all @-pair ctx prices when allMids is empty.
  });
});

describe('parseAllMidsResponse — ensures untrusted @-pair ctx is never silently accepted', () => {
  it('when allMids is empty, @-pair ctx price is rejected (not silently accepted)', () => {
    // This is the critical safety property: if the allMids reference is
    // unavailable (empty map from a failed/malformed API response), the
    // normalizer must NOT fall back to trusting the corrupted ctx price.
    // It must mark it as untrusted (rejected).
    const spotMeta = buildSpotMeta([
      { name: '@107', markPx: '0.081882', tokens: ['HYPE', 'USDC'] },
    ]);
    const emptyAllMids = new Map<string, number>();  // empty — simulates API failure
    const result = normalizeSpotPrices(spotMeta, emptyAllMids);
    const np = result.prices.get('@107')!;
    expect(np.trusted).toBe(false);
    expect(np.source).toBe('ctx');  // ctx price is the only source, but it's untrusted
    expect(np.rejectReason).toContain('no allMids reference');
    expect(result.rejectedCount).toBe(1);
    expect(result.trustedCount).toBe(0);
    expect(result.fallbackCount).toBe(0);
  });

  it('when allMids has the reference, corrupted ctx price falls back to allMids', () => {
    // Contrast with above: when allMids IS available, the corrupted ctx
    // price is detected and the allMids value is used instead.
    const spotMeta = buildSpotMeta([
      { name: '@107', markPx: '0.081882', tokens: ['HYPE', 'USDC'] },
    ]);
    const allMids = buildAllMids({ '@107': 81.97 });
    const result = normalizeSpotPrices(spotMeta, allMids);
    const np = result.prices.get('@107')!;
    expect(np.trusted).toBe(true);
    expect(np.source).toBe('allmids');
    expect(np.price).toBeCloseTo(81.97, 9);
    expect(result.fallbackCount).toBe(1);
  });
});
