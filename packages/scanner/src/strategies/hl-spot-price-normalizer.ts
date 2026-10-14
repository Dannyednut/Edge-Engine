/**
 * HL Spot Price Normalizer
 * ─────────────────────────────────────────────────────────────────────
 * Purpose:
 *   Hyperliquid's `spotMetaAndAssetCtxs` endpoint returns corrupted
 *   `midPx` (and potentially `markPx`) values for builder-deployed `@`-pairs.
 *   The values can be wrong by up to 6 orders of magnitude, and there is
 *   no single power-of-ten scaling factor that explains the discrepancy.
 *
 *   The `allMids` endpoint returns correct mid prices for all assets,
 *   keyed by `@N` for spot pairs and by name for perps.
 *
 *   This module cross-validates `spotMetaAndAssetCtxs` ctx prices against
 *   `allMids` and returns only trusted prices. For @-pairs where the ctx
 *   value diverges from allMids by more than MAX_DIVERGENCE_PCT, the
 *   allMids value is used and the quote is marked as `source: 'allmids'`.
 *   For named pairs (non-@), the ctx value is used directly (EI verified
 *   these are correct).
 *
 * Evidence (EI-S004, 2026-10-13 16:12-16:16Z):
 *   | Pair         | ctx midPx  | allMids @N | Notes                     |
 *   |--------------|------------|------------|---------------------------|
 *   | @107 HYPE    | 0.081882   | 80.8905    | HYPE perp 80.9545 ✓       |
 *   | @166 USDT0   | 0.161245   | 0.999095   | parity -0.09%             |
 *   | @285 AZTEC   | 778.355    | 0.0201265  | AZTEC perp 0.020141 ✓     |
 *   | @336 KHYPE   | 0.022722   | 83.04      | /HYPE 80.95 = 1.0258 ✓    |
 *   | @109 WOW     | 80.8035    | 0.00025758 | —                         |
 *   | @144 NEKO    | 83354.5    | 0.000146   | —                         |
 *   | PURR (named) | 0.10964    | 0.109735   | consistent ✓              |
 *
 *   EI tested `midPx`; this module also validates `markPx` independently
 *   by cross-checking against allMids. If `markPx` diverges, the allMids
 *   value is used.
 *
 * Zero-capital: read-only public API data, no trades, no wallet.
 */

const HL_API = 'https://api.hyperliquid.xyz/info';

/** Maximum allowed divergence between ctx price and allMids before the
 *  ctx value is rejected. 5% is conservative — the observed divergences
 *  are orders of magnitude, so any real corruption will far exceed this. */
const MAX_DIVERGENCE_PCT = 5.0;

export interface NormalizedPrice {
  /** The trusted price to use for calculations */
  price: number;
  /** Whether the price is trusted (true) or was rejected/fallback (false) */
  trusted: boolean;
  /** Source of the price: 'ctx' (original), 'allmids' (fallback), 'none' (unavailable) */
  source: 'ctx' | 'allmids' | 'none';
  /** Reason for rejection if trusted=false */
  rejectReason?: string;
  /** The original ctx price (for diagnostic logging) */
  ctxPrice?: number;
  /** The allMids reference price (for diagnostic logging) */
  allMidsPrice?: number;
  /** The spot pair name (e.g. "@107", "PURR/USDC") */
  pairName: string;
}

export interface NormalizationResult {
  /** Map of pair name → normalized price */
  prices: Map<string, NormalizedPrice>;
  /** Count of prices that used allMids fallback */
  fallbackCount: number;
  /** Count of prices that were fully rejected (no trusted source) */
  rejectedCount: number;
  /** Count of prices that used ctx directly (trusted) */
  trustedCount: number;
}

async function hlInfo(req: any): Promise<any> {
  try {
    const r = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * Fetch allMids and return a Map keyed by asset name.
 * For spot @-pairs, the key is `@N` (e.g. `@107`).
 * For perps, the key is the perp name (e.g. `HYPE`).
 */
export async function fetchAllMids(): Promise<Map<string, number>> {
  const mids = new Map<string, number>();
  const resp = await hlInfo({ type: 'allMids' });
  if (!resp?.mids) return mids;
  for (const [key, val] of Object.entries(resp.mids)) {
    const px = parseFloat(val as string);
    if (px > 0 && isFinite(px)) mids.set(key, px);
  }
  return mids;
}

/**
 * Normalize spotMetaAndAssetCtxs prices against allMids.
 *
 * @param spotMeta - The raw response from `spotMetaAndAssetCtxs` API
 * @param allMids - The Map from `fetchAllMids()`
 * @returns NormalizationResult with trusted prices and diagnostics
 */
export function normalizeSpotPrices(
  spotMeta: any,
  allMids: Map<string, number>,
): NormalizationResult {
  const prices = new Map<string, NormalizedPrice>();
  let fallbackCount = 0;
  let rejectedCount = 0;
  let trustedCount = 0;

  if (!spotMeta || !Array.isArray(spotMeta) || spotMeta.length < 2) {
    return { prices, fallbackCount, rejectedCount, trustedCount };
  }

  const [spotUniverse, spotCtxs] = spotMeta;
  if (!spotUniverse?.universe || !Array.isArray(spotCtxs)) {
    return { prices, fallbackCount, rejectedCount, trustedCount };
  }

  const tokens = spotUniverse.tokens || [];

  for (let i = 0; i < spotUniverse.universe.length; i++) {
    const u = spotUniverse.universe[i];
    if (!u?.name) continue;

    const ctx = spotCtxs[i] || {};
    const ctxMarkPx = parseFloat(ctx.markPx || '0');
    const pairName = u.name;

    // Get the base token name for named pairs
    let baseTokenName = pairName;
    const isAtPair = pairName.startsWith('@');

    if (isAtPair) {
      // For @-pairs, resolve the token name from the tokens array
      const tokenIdx = u.tokens?.[0];
      if (tokenIdx !== undefined && tokens[tokenIdx]) {
        baseTokenName = tokens[tokenIdx].name || pairName;
      }
    } else {
      // For named pairs (e.g. "PURR/USDC"), extract the base token name
      // (e.g. "PURR") to match the allMids key
      const slashIdx = pairName.indexOf('/');
      if (slashIdx > 0) {
        baseTokenName = pairName.slice(0, slashIdx);
      }
    }

    // Look up the allMids reference price
    // For @-pairs, allMids is keyed by `@N` (the pair name itself)
    // For named pairs, allMids is keyed by the base token name (e.g. "PURR")
    const allMidsKey = isAtPair ? pairName : baseTokenName;
    const allMidsPrice = allMids.get(allMidsKey);

    if (isAtPair) {
      // @-pair: cross-validate ctx markPx against allMids
      if (allMidsPrice && allMidsPrice > 0) {
        if (ctxMarkPx > 0 && isFinite(ctxMarkPx)) {
          const divergencePct = Math.abs((ctxMarkPx - allMidsPrice) / allMidsPrice * 100);
          if (divergencePct <= MAX_DIVERGENCE_PCT) {
            // ctx markPx is consistent with allMids — use it
            prices.set(pairName, {
              price: ctxMarkPx,
              trusted: true,
              source: 'ctx',
              pairName,
              ctxPrice: ctxMarkPx,
              allMidsPrice,
            });
            trustedCount++;
          } else {
            // ctx markPx diverges from allMids — use allMids as fallback
            prices.set(pairName, {
              price: allMidsPrice,
              trusted: true,
              source: 'allmids',
              pairName,
              ctxPrice: ctxMarkPx,
              allMidsPrice,
              rejectReason: `ctx markPx ${ctxMarkPx} diverges ${divergencePct.toFixed(2)}% from allMids ${allMidsPrice}`,
            });
            fallbackCount++;
          }
        } else {
          // ctx markPx is 0/NaN — use allMids if available
          prices.set(pairName, {
            price: allMidsPrice,
            trusted: true,
            source: 'allmids',
            pairName,
            ctxPrice: ctxMarkPx,
            allMidsPrice,
            rejectReason: `ctx markPx invalid (${ctxMarkPx})`,
          });
          fallbackCount++;
        }
      } else {
        // No allMids reference for this @-pair — cannot verify, mark untrusted
        prices.set(pairName, {
          price: ctxMarkPx > 0 ? ctxMarkPx : 0,
          trusted: false,
          source: ctxMarkPx > 0 ? 'ctx' : 'none',
          pairName,
          ctxPrice: ctxMarkPx,
          rejectReason: 'no allMids reference available for @-pair',
        });
        rejectedCount++;
      }
    } else {
      // Named pair: EI verified these are correct — use ctx directly
      if (ctxMarkPx > 0 && isFinite(ctxMarkPx)) {
        // Cross-check against allMids if available (defense in depth)
        if (allMidsPrice && allMidsPrice > 0) {
          const divergencePct = Math.abs((ctxMarkPx - allMidsPrice) / allMidsPrice * 100);
          if (divergencePct <= MAX_DIVERGENCE_PCT) {
            prices.set(pairName, {
              price: ctxMarkPx,
              trusted: true,
              source: 'ctx',
              pairName,
              ctxPrice: ctxMarkPx,
              allMidsPrice,
            });
            trustedCount++;
          } else {
            // Named pair diverges — unusual, log and use allMids
            prices.set(pairName, {
              price: allMidsPrice,
              trusted: true,
              source: 'allmids',
              pairName,
              ctxPrice: ctxMarkPx,
              allMidsPrice,
              rejectReason: `named pair ${pairName} ctx ${ctxMarkPx} diverges ${divergencePct.toFixed(2)}% from allMids ${allMidsPrice}`,
            });
            fallbackCount++;
          }
        } else {
          // No allMids reference — trust ctx for named pairs per EI evidence
          prices.set(pairName, {
            price: ctxMarkPx,
            trusted: true,
            source: 'ctx',
            pairName,
            ctxPrice: ctxMarkPx,
          });
          trustedCount++;
        }
      } else {
        prices.set(pairName, {
          price: 0,
          trusted: false,
          source: 'none',
          pairName,
          ctxPrice: ctxMarkPx,
          rejectReason: `ctx markPx invalid for named pair`,
        });
        rejectedCount++;
      }
    }
  }

  return { prices, fallbackCount, rejectedCount, trustedCount };
}

/**
 * Fetch and normalize HL spot prices in one call.
 * Returns a Map of pair name → trusted price (untrusted prices are excluded).
 */
export async function getNormalizedSpotPrices(): Promise<Map<string, number>> {
  const [spotMeta, allMids] = await Promise.all([
    hlInfo({ type: 'spotMetaAndAssetCtxs' }),
    fetchAllMids(),
  ]);

  if (!spotMeta) return new Map();

  const result = normalizeSpotPrices(spotMeta, allMids);

  // Log diagnostics for rejected/fallback prices
  if (result.fallbackCount > 0 || result.rejectedCount > 0) {
    for (const [name, np] of result.prices) {
      if (!np.trusted || np.source === 'allmids') {
        console.warn(`[hl-normalize] ${name}: ${np.rejectReason || 'fallback to allMids'} (ctx=${np.ctxPrice ?? 'n/a'}, allMids=${np.allMidsPrice ?? 'n/a'})`);
      }
    }
  }

  // Return only trusted prices
  const trusted = new Map<string, number>();
  for (const [name, np] of result.prices) {
    if (np.trusted && np.price > 0) {
      trusted.set(name, np.price);
    }
  }
  return trusted;
}
