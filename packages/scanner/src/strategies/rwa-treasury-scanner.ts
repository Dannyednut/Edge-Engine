/**
 * RwaTreasuryScanner — scans RWA (Real World Asset) tokenized Treasury yields.
 *
 * Covers:
 *   - BlackRock BUIDL (tokenized T-bills, $3B+ TVL)
 *   - Ondo USDY / OUSG (yield-bearing USD, $2.5B+ TVL)
 *   - Circle USYC (yield-bearing stablecoin, $2.4B+ TVL)
 *   - Invesco USTB (tokenized T-bills, $600M+ TVL)
 *   - Mountain Protocol USDM (wrapped Treasury)
 *   - OpenEden TBILL
 *   - VanEck VBILL
 *
 * Also covers institutional credit:
 *   - Maple Finance ($4B+ TVL — largest institutional credit protocol)
 *   - Centrifuge ($900M+ TVL)
 *   - Midas RWA, Pareto Credit
 *
 * All pools are US Treasury-backed = lowest risk in DeFi.
 *
 * MIGRATED FROM scripts-explore:
 *   - rwa-treasury-scanner.mts
 *   - institutional-credit-scanner.mts
 *   - maple-finance-scanner.mts
 */

import type { DataPoint, TradeOrder, RiskParams, Strategy } from '@edge/types';

const LLAMA_API = 'https://yields.llama.fi';

export interface RwaTreasuryParams {
  /** Min TVL to report (default $1M) */
  minTvlUsd: number;
  /** Include institutional credit (Maple, Centrifuge) (default true) */
  includeInstitutionalCredit: boolean;
}

export interface RwaYieldAlert {
  symbol: string;
  project: string;
  chain: string;
  apy: number;
  tvlUsd: number;
  backingAsset: string;
  category: 'treasury' | 'institutional_credit' | 'tokenized_etf';
  riskScore: number;
  dailyProfitOn100k: number;
  ts: number;
}

const RWA_KEYWORDS = [
  'buidl', 'usdy', 'usyc', 'ustb', 'tbill', 'usdm', 'ousg',
  'blackrock', 'ondo', 'invesco', 'circle-usyc', 'mountain',
  'openeden', 'vaneck',
];

const INSTITUTIONAL_PROJECTS = [
  'maple', 'centrifuge-protocol', 'huma', 'clearpool-lending',
  'midas-rwa', 'pareto-credit',
];

export class RwaTreasuryScanner implements Strategy {
  readonly id = 'rwa_treasury';
  readonly landscape = 'F_perps_funding' as const;

  constructor(private params: RwaTreasuryParams) {}

  subscribesTo(): string[] { return []; }
  evaluate(_data: DataPoint): TradeOrder[] | null { return null; }

  riskParams(): RiskParams {
    return {
      minProfitUsd: 0,
      maxSizeUsd: 1_000_000,
      maxConcurrent: 5,
      cooldownMs: 60 * 60_000,  // 1 hour
      gasPriceCapMultiplier: 3,
    };
  }

  async scan(): Promise<RwaYieldAlert[]> {
    const alerts: RwaYieldAlert[] = [];

    try {
      const res = await fetch(`${LLAMA_API}/pools`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      });
      if (!res.ok) return alerts;

      const j = await res.json() as any;
      const pools = j?.data || [];

      for (const p of pools) {
        if ((p.tvlUsd || 0) < this.params.minTvlUsd) continue;
        if ((p.apy || 0) <= 0) continue;

        const sym = (p.symbol || '').toLowerCase();
        const proj = (p.project || '').toLowerCase();

        // Check if RWA/Treasury
        const isRwa = RWA_KEYWORDS.some(k => sym.includes(k) || proj.includes(k));
        const isInstitutional = INSTITUTIONAL_PROJECTS.includes(proj);

        if (!isRwa && !(this.params.includeInstitutionalCredit && isInstitutional)) continue;

        // Determine category
        let category: 'treasury' | 'institutional_credit' | 'tokenized_etf' = 'treasury';
        if (isInstitutional) category = 'institutional_credit';
        else if (sym.includes('ousg')) category = 'tokenized_etf';

        // Determine backing
        let backing = 'US Treasuries';
        if (sym.includes('buidl')) backing = 'BlackRock BUIDL (T-bills)';
        else if (sym.includes('usdy')) backing = 'Ondo USDY (T-bills + bank deposits)';
        else if (sym.includes('ousg')) backing = 'Ondo OUSG (BlackRock iShares ETF)';
        else if (sym.includes('usyc')) backing = 'Circle USYC (T-bills)';
        else if (sym.includes('ustb')) backing = 'Invesco USTB (T-bills)';
        else if (sym.includes('tbill')) backing = 'OpenEden TBILL (T-bills)';
        else if (sym.includes('usdm')) backing = 'Mountain USDM (T-bills)';
        else if (isInstitutional) backing = 'Institutional credit (loans, invoices)';

        alerts.push({
          symbol: p.symbol || '',
          project: p.project || '',
          chain: p.chain || '',
          apy: p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          backingAsset: backing,
          category,
          riskScore: category === 'treasury' ? 1 : 2,  // Treasury = lowest risk
          dailyProfitOn100k: 100000 * (p.apy || 0) / 100 / 365,
          ts: Date.now(),
        });
      }

      // Sort by TVL (largest = safest)
      alerts.sort((a, b) => b.tvlUsd - a.tvlUsd);

    } catch (e: any) {
      console.warn(`[rwa_treasury] scan failed: ${e.message}`);
    }

    return alerts;
  }
}
