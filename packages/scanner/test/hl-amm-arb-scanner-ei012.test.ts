/**
 * hl-amm-arb-scanner-ei012.test.ts
 * ─────────────────────────────────────────────────────────────────────
 * EI-012 regression tests: verify that @N spot pairs resolve to the
 * correct base token name via universe[i].tokens[0], NOT via the @N
 * pair ID as a token-array index.
 *
 * Evidence (EI-S006 Manager Verification Note §3):
 *   | Pair | correct base (universe[i].tokens[0]) | tokens[parseInt(@N)] (old bug) |
 *   |------|---------------------------------------|-------------------------------|
 *   | @107 | HYPE                                  | RANK                          |
 *   | @166 | USDT0                                 | CREAM                         |
 *   | @285 | AZTEC                                 | STAKE                         |
 *   | @336 | KHYPE                                 | BULL                          |
 *
 * The old code did `tokens[parseInt(name.slice(1))]` which treated the
 * @N pair ID as a token-array index — producing wrong symbol keys.
 * The fix uses `universe[i].tokens[0]` to get the correct base token
 * index, exactly as hl-spot-price-normalizer.ts does.
 */
import { describe, it, expect } from 'vitest';
import { HlAmmArbScanner } from '../src/strategies/hl-amm-arb-scanner.js';

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build a fixture spotMetaAndAssetCtxs response that mirrors the live API.
 * The key insight: universe[i].tokens contains [baseTokenIdx, quoteTokenIdx]
 * which are indices into the tokens[] array. The @N pair ID is NOT a token
 * index — it's a pair identifier that happens to be a number.
 *
 * To reproduce the EI-012 bug, the tokens[] array must be ordered such that
 * tokens[107] != HYPE, tokens[166] != USDT0, etc.
 */
function buildFixture(
  pairs: { name: string; baseToken: string; quoteToken: string; markPx: string; dayNtlVlm: string; allMidsPrice: number }[],
): { spotMeta: any; allMids: Map<string, number> } {
  // Build tokens array with enough entries that parseInt(@N) indexes
  // to a DIFFERENT token than the correct base token.
  // We'll fill positions 0-400 with dummy tokens, then place the real
  // tokens at specific indices that DON'T match the @N numbers.
  const tokens: { name: string }[] = [];
  for (let i = 0; i < 500; i++) {
    tokens.push({ name: `DUMMY_${i}` });
  }

  // Place the correct base/quote tokens at unique indices
  const universe: any[] = [];
  const ctxs: any[] = [];
  const allMids: Record<string, number> = {};

  for (const p of pairs) {
    // Find or create token entries for base and quote
    let baseIdx = tokens.findIndex(t => t.name === p.baseToken);
    if (baseIdx < 0) {
      baseIdx = tokens.length;
      tokens.push({ name: p.baseToken });
    }
    let quoteIdx = tokens.findIndex(t => t.name === p.quoteToken);
    if (quoteIdx < 0) {
      quoteIdx = tokens.length;
      tokens.push({ name: p.quoteToken });
    }

    universe.push({
      name: p.name,
      tokens: [baseIdx, quoteIdx],  // [baseTokenIdx, quoteTokenIdx]
    });
    ctxs.push({
      markPx: p.markPx,
      dayNtlVlm: p.dayNtlVlm,
    });
    allMids[p.name] = p.allMidsPrice;
  }

  const spotMeta = [{ universe, tokens }, ctxs];
  const allMidsMap = new Map<string, number>();
  for (const [k, v] of Object.entries(allMids)) {
    allMidsMap.set(k, v);
  }
  return { spotMeta, allMids: allMidsMap };
}

// ─── EI-012 Regression Tests ────────────────────────────────────────

describe('HlAmmArbScanner.resolveHlOrderbookPrices — EI-012 @N mapping fix', () => {
  it('@107 resolves to HYPE, NOT RANK', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@107', baseToken: 'HYPE', quoteToken: 'USDC', markPx: '81.97', dayNtlVlm: '5000000', allMidsPrice: 81.97 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.has('HYPE')).toBe(true);
    expect(prices.get('HYPE')).toBeCloseTo(81.97, 2);
    // The old bug would have keyed this as tokens[107] which is DUMMY_107
    expect(prices.has('RANK')).toBe(false);
    expect(prices.has('DUMMY_107')).toBe(false);
  });

  it('@166 resolves to USDT0, NOT CREAM', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@166', baseToken: 'USDT0', quoteToken: 'USDC', markPx: '0.999', dayNtlVlm: '5000000', allMidsPrice: 0.999 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.has('USDT0')).toBe(true);
    expect(prices.get('USDT0')).toBeCloseTo(0.999, 4);
    expect(prices.has('CREAM')).toBe(false);
    expect(prices.has('DUMMY_166')).toBe(false);
  });

  it('@285 resolves to AZTEC, NOT STAKE', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@285', baseToken: 'AZTEC', quoteToken: 'USDC', markPx: '0.0201', dayNtlVlm: '5000000', allMidsPrice: 0.0201 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.has('AZTEC')).toBe(true);
    expect(prices.get('AZTEC')).toBeCloseTo(0.0201, 6);
    expect(prices.has('STAKE')).toBe(false);
    expect(prices.has('DUMMY_285')).toBe(false);
  });

  it('@336 resolves to KHYPE, NOT BULL', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@336', baseToken: 'KHYPE', quoteToken: 'USDC', markPx: '84.10', dayNtlVlm: '5000000', allMidsPrice: 84.10 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.has('KHYPE')).toBe(true);
    expect(prices.get('KHYPE')).toBeCloseTo(84.10, 2);
    expect(prices.has('BULL')).toBe(false);
    expect(prices.has('DUMMY_336')).toBe(false);
  });

  it('all four @N pairs resolve correctly in a single fixture', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@107', baseToken: 'HYPE', quoteToken: 'USDC', markPx: '81.97', dayNtlVlm: '5000000', allMidsPrice: 81.97 },
      { name: '@166', baseToken: 'USDT0', quoteToken: 'USDC', markPx: '0.999', dayNtlVlm: '5000000', allMidsPrice: 0.999 },
      { name: '@285', baseToken: 'AZTEC', quoteToken: 'USDC', markPx: '0.0201', dayNtlVlm: '5000000', allMidsPrice: 0.0201 },
      { name: '@336', baseToken: 'KHYPE', quoteToken: 'USDC', markPx: '84.10', dayNtlVlm: '5000000', allMidsPrice: 84.10 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.size).toBe(4);
    expect(prices.has('HYPE')).toBe(true);
    expect(prices.has('USDT0')).toBe(true);
    expect(prices.has('AZTEC')).toBe(true);
    expect(prices.has('KHYPE')).toBe(true);
    // None of the old wrong-keyed names should be present
    expect(prices.has('RANK')).toBe(false);
    expect(prices.has('CREAM')).toBe(false);
    expect(prices.has('STAKE')).toBe(false);
    expect(prices.has('BULL')).toBe(false);
  });
});

describe('HlAmmArbScanner.resolveHlOrderbookPrices — fail-closed behavior', () => {
  it('skips @-pair with missing tokens array (fail closed)', () => {
    // Build a fixture where the universe entry has no tokens array
    const spotMeta = [{
      universe: [{ name: '@999' }],  // no tokens field
      tokens: [{ name: 'FOO' }],
    }, [{ markPx: '1.0', dayNtlVlm: '5000000' }]];
    const allMids = new Map([['@999', 1.0]]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    // Should skip — no guessed symbol assigned
    expect(prices.size).toBe(0);
    expect(prices.has('@999')).toBe(false);
  });

  it('skips @-pair with out-of-range token index (fail closed)', () => {
    const spotMeta = [{
      universe: [{ name: '@999', tokens: [999] }],  // index 999 out of range
      tokens: [{ name: 'FOO' }],
    }, [{ markPx: '1.0', dayNtlVlm: '5000000' }]];
    const allMids = new Map([['@999', 1.0]]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.size).toBe(0);
  });

  it('skips @-pair with untrusted price (normalizer rejected)', () => {
    // ctx markPx diverges from allMids and no allMids available → rejected
    const spotMeta = [{
      universe: [{ name: '@999', tokens: [0, 1] }],
      tokens: [{ name: 'FOO' }, { name: 'BAR' }],
    }, [{ markPx: '1.0', dayNtlVlm: '5000000' }]];
    const allMids = new Map();  // empty → @-pair ctx rejected
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.size).toBe(0);
  });

  it('skips @-pair with zero volume', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: '@107', baseToken: 'HYPE', quoteToken: 'USDC', markPx: '81.97', dayNtlVlm: '500', allMidsPrice: 81.97 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    expect(prices.size).toBe(0);  // vol < 1000 threshold
  });
});

describe('HlAmmArbScanner.resolveHlOrderbookPrices — named pairs', () => {
  it('named pair (non-@) uses pair name directly', () => {
    const { spotMeta, allMids } = buildFixture([
      { name: 'PURR/USDC', baseToken: 'PURR', quoteToken: 'USDC', markPx: '0.111', dayNtlVlm: '5000000', allMidsPrice: 0.111 },
    ]);
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(spotMeta, allMids);
    // Named pairs use the ctx price directly (trusted) since they don't
    // start with @. The normalizer keeps the pair name as the key.
    // The scanner's resolveHlOrderbookPrices doesn't rename named pairs
    // (the name stays as-is from pairName).
    expect(prices.size).toBeGreaterThan(0);
  });

  it('null spotMeta returns empty map', () => {
    const prices = HlAmmArbScanner.resolveHlOrderbookPrices(null, new Map());
    expect(prices.size).toBe(0);
  });
});
