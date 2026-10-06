/**
 * Pendle V2 API Client — query PT markets, prices, and implied yields.
 *
 * Pendle V2 API: https://api-v2.pendle.finance/core/v2
 * Supports all chains including Hyperliquid (chainId 999).
 *
 * Key endpoints:
 *   GET /markets/all?limit=N&skip=M  — list all markets (paginated)
 *   Market object contains: name, address, expiry, pt, yt, sy, underlyingAsset,
 *     details.underlyingApy, details.impliedApy, details.totalTvl, details.totalPt
 */

const PENDLE_API = 'https://api-v2.pendle.finance/core/v2';

export interface PendleMarket {
  name: string;
  protocol: string;
  address: string;
  expiry: string;
  pt: string;              // format: "chainId-address"
  yt: string;
  sy: string;
  underlyingAsset: string;
  chainId: number;
  details: {
    liquidity: number;
    totalTvl: number;
    tradingVolume: number;
    underlyingApy: number;     // floating yield of the underlying (e.g., kHYPE staking yield)
    impliedApy: number;       // PT implied fixed yield (0 if illiquid)
    aggregatedApy: number;
    totalPt: number;          // total PT supply
    totalSy: number;
    totalSupply: number;
  };
}

export interface PendleClientOptions {
  fetchImpl?: typeof fetch;
}

export class PendleClient {
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PendleClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Get all markets across all chains, paginated. */
  async getAllMarkets(maxPages: number = 10): Promise<PendleMarket[]> {
    const markets: PendleMarket[] = [];
    for (let page = 0; page < maxPages; page++) {
      const skip = page * 100;
      const res = await this.fetchImpl(`${PENDLE_API}/markets/all?limit=100&skip=${skip}`);
      if (!res.ok) break;
      const json = await res.json() as { results?: PendleMarket[] };
      const results = json.results ?? [];
      if (results.length === 0) break;
      markets.push(...results);
      if (results.length < 100) break;
    }
    return markets;
  }

  /** Get markets on a specific chain (e.g., 999 for Hyperliquid). */
  async getMarketsByChain(chainId: number): Promise<PendleMarket[]> {
    const all = await this.getAllMarkersByChain(chainId);
    return all.filter(m => m.chainId === chainId);
  }

  private async getAllMarkersByChain(chainId: number): Promise<PendleMarket[]> {
    const all = await this.getAllMarkets(10);
    return all;
  }

  /** Find markets for a specific asset (e.g., 'kHYPE', 'stHYPE'). */
  async findMarkets(assetName: string, chainId?: number): Promise<PendleMarket[]> {
    const all = await this.getAllMarkets(10);
    return all.filter(m => {
      const nameMatch = m.name.toLowerCase() === assetName.toLowerCase();
      const chainMatch = chainId ? m.chainId === chainId : true;
      return nameMatch && chainMatch;
    });
  }

  /** Get all HL (chain 999) LST markets — kHYPE, stHYPE, beHYPE, etc. */
  async getHlLstMarkets(): Promise<PendleMarket[]> {
    const all = await this.getAllMarkets(10);
    return all.filter(m => {
      if (m.chainId !== 999) return false;
      const name = m.name.toLowerCase();
      return name.includes('hype') || name.includes('k_hype') || name.includes('st_hype');
    });
  }

  /** Compare yields across LSTs on Hyperliquid. */
  async compareHlLstYields(): Promise<Array<{
    name: string;
    address: string;
    expiry: string;
    underlyingApy: number;
    impliedApy: number;
    tvl: number;
    totalPt: number;
  }>> {
    const markets = await this.getHlLstMarkets();
    return markets.map(m => ({
      name: m.name,
      address: m.address,
      expiry: m.expiry,
      underlyingApy: m.details.underlyingApy,
      impliedApy: m.details.impliedApy,
      tvl: m.details.totalTvl,
      totalPt: m.details.totalPt,
    })).sort((a, b) => b.underlyingApy - a.underlyingApy);
  }
}
