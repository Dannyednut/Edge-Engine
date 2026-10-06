/**
 * HlSpotBasisScanner — Hyperliquid spot vs perp basis arbitrage.
 *
 * DISCOVERY (Oct 13 2026):
 *   HL has 329 spot trading pairs (@1 through @N) including:
 *     @288 QQQ/USDC   $1,375   $14M daily volume (tokenized Nasdaq-100 ETF)
 *     @276 GLD/USDC   $562     $2.9M daily volume (tokenized Gold ETF)
 *     @271 HOOD/USDC  $93      $17k volume (tokenized Robinhood stock)
 *     @226 AVAX0/USDC $14      $32k volume (AVAX)
 *     @109 WOW/USDC   $93      $63.7M volume
 *     @144 NEKO/USDC  $86,517  $23.1M volume
 *     @155 QUANT/USDC $2,720   $13.6M volume
 *
 * ARB OPPORTUNITY:
 *   For tokens that have BOTH HL spot AND HL perp (e.g., AVAX0 spot vs AVAX perp):
 *     - If spot at premium to perp: buy perp, short spot (capture basis)
 *     - If spot at discount: buy spot, short perp
 *   For tokens with CEX equivalent (AVAX0 vs Binance AVAX):
 *     - Cross-venue spot arb
 *
 *   Also: tokenized equities (QQQ, GLD, HOOD) vs real-world prices.
 *   Yahoo Finance API currently blocked — need alternative equity price source.
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const HL_API = 'https://api.hyperliquid.xyz/info';

export interface HlSpotBasisParams {
  /** Min basis % to alert (default 0.5%) */
  minBasisPct: number;
  /** Min 24h volume to consider (default $50k) */
  minVolume24h: number;
  /** Mapping of HL spot pair names to perp names for basis comparison.
   *  Example: { 'AVAX0': 'AVAX', 'BTC0': 'BTC' }
   *  Only pairs in this map will be checked for basis. */
  perpNameMapping?: Record<string, string>;
}

export interface HlSpotBasisAlert {
  spotName: string;          // @226
  pair: string;              // AVAX0/USDC
  baseToken: string;         // AVAX0
  spotPrice: number;
  perpName?: string;         // AVAX (if mapped)
  perpPrice?: number;
  basisPct?: number;         // (perp - spot) / spot × 100
  basisDirection?: 'buy_spot_short_perp' | 'buy_perp_short_spot';
  volume24h: number;
  ts: number;
}

async function hlInfo(req: any): Promise<any> {
  const r = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return r.ok ? await r.json() : null;
}

export class HlSpotBasisScanner implements Strategy {
  readonly id = 'hl_spot_basis';
  readonly landscape = 'A_dex_cex' as const;

  constructor(private params: HlSpotBasisParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 10,
      maxSizeUsd: 2_000,
      maxConcurrent: 3,
      cooldownMs: 5 * 60_000,
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<HlSpotBasisAlert[]> {
    const alerts: HlSpotBasisAlert[] = [];

    // 1. Fetch spot meta + perp meta in parallel
    const [spotMeta, perpMeta] = await Promise.all([
      hlInfo({ type: 'spotMetaAndAssetCtxs' }),
      hlInfo({ type: 'metaAndAssetCtxs' }),
    ]);
    if (!spotMeta || !perpMeta) return alerts;

    const [spotUniverse, spotCtxs] = spotMeta;
    const [perpUniverse, perpCtxs] = perpMeta;

    // Build perp name → price map
    const perpPrices = new Map<string, number>();
    for (let i = 0; i < perpUniverse.universe.length; i++) {
      const u = perpUniverse.universe[i];
      const ctx = perpCtxs[i] || {};
      const markPx = parseFloat(ctx.markPx || '0');
      if (markPx > 0) perpPrices.set(u.name, markPx);
    }

    // Build token index → name map for spot
    const tokenNames = new Map<number, string>();
    for (let i = 0; i < spotUniverse.tokens.length; i++) {
      tokenNames.set(i, spotUniverse.tokens[i].name);
    }

    // 2. For each @-prefixed spot pair, check if there's a matching perp
    const perpMap = this.params.perpNameMapping || {};
    for (let i = 0; i < spotUniverse.universe.length; i++) {
      const u = spotUniverse.universe[i];
      if (!u.name?.startsWith('@')) continue;

      const ctx = spotCtxs[i] || {};
      const spotPrice = parseFloat(ctx.markPx || '0');
      const vol24h = parseFloat(ctx.dayNtlVlm || '0');

      if (spotPrice <= 0) continue;
      if (vol24h < this.params.minVolume24h) continue;

      const baseToken = tokenNames.get(u.tokens[0]) || '?';
      const quoteToken = tokenNames.get(u.tokens[1]) || '?';
      const pair = `${baseToken}/${quoteToken}`;

      // Check if this base token has a mapped perp name
      const perpName = perpMap[baseToken];
      const perpPrice = perpName ? perpPrices.get(perpName) : undefined;

      if (perpName && perpPrice) {
        const basisPct = ((perpPrice - spotPrice) / spotPrice) * 100;
        if (Math.abs(basisPct) >= this.params.minBasisPct) {
          alerts.push({
            spotName: u.name,
            pair,
            baseToken,
            spotPrice,
            perpName,
            perpPrice,
            basisPct,
            basisDirection: basisPct > 0 ? 'buy_spot_short_perp' : 'buy_perp_short_spot',
            volume24h: vol24h,
            ts: Date.now(),
          });
        }
      } else {
        // No perp mapping — still record the spot price for monitoring
        // (useful for tokenized equities like QQQ, GLD, HOOD)
        alerts.push({
          spotName: u.name,
          pair,
          baseToken,
          spotPrice,
          volume24h: vol24h,
          ts: Date.now(),
        });
      }
    }

    // Sort: actionable basis alerts first, then by volume
    alerts.sort((a, b) => {
      if (a.basisPct !== undefined && b.basisPct !== undefined) {
        return Math.abs(b.basisPct) - Math.abs(a.basisPct);
      }
      if (a.basisPct !== undefined) return -1;
      if (b.basisPct !== undefined) return 1;
      return b.volume24h - a.volume24h;
    });

    return alerts;
  }
}
