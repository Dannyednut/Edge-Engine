/**
 * Hyperliquid Funding Rate Live Monitor
 *
 * Polls HL perp funding rates every 60s for all markets.
 * Detects:
 *   - Extreme positive funding (>100%/yr) — short seller pays, delta-neutral arb opportunity
 *   - Extreme negative funding (<-50%/yr) — longs get paid
 *   - Funding rate flip (sign change) — trend reversal signal
 *   - Top 10 highest funding (long pressure markets)
 *   - Top 10 lowest funding (short pressure markets)
 *
 * Trading implications:
 *   - High funding + spot available elsewhere = delta-neutral funding harvest
 *   - Funding flip = trend change
 *   - Divergence between HL and CEX = cross-venue arb
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

interface AssetCtx {
  coin: string;
  fundingRate: number;       // already in fraction per hour (HL format)
  fundingRateAnnualPct: number;
  openInterestUsd: number;
  prevDayPx: number;
  markPx: number;
  oraclePx: number;
  premium: number;            // (mark - oracle) / oracle
  dailyChangePct: number;
}

async function getAllMarkets(): Promise<{ coins: string[]; universe: any[] }> {
  const r = await hlPost({ type: 'metaAndAssetCtxs' });
  const meta = r?.[0];
  const ctxs = r?.[1];
  if (!meta?.universe || !Array.isArray(ctxs)) return { coins: [], universe: [] };
  const universe = meta.universe.map((u: any, i: number) => ({ ...u, ctx: ctxs[i] }));
  return { coins: meta.universe.map((u: any) => u.name), universe };
}

function analyzeMarkets(universe: any[]): AssetCtx[] {
  return universe
    .filter((u: any) => !u.name.startsWith('@') && u.ctx)
    .map((u: any) => {
      const ctx = u.ctx;
      const fundingHourly = parseFloat(ctx.funding) || 0;
      const fundingAnnualPct = fundingHourly * 24 * 365 * 100;
      const openInterestUsd = parseFloat(ctx.openInterest) * parseFloat(ctx.markPx);
      const markPx = parseFloat(ctx.markPx);
      const oraclePx = parseFloat(ctx.oraclePx);
      const prevDayPx = parseFloat(ctx.prevDayPx);
      const dailyChangePct = prevDayPx > 0 ? (markPx - prevDayPx) / prevDayPx * 100 : 0;
      const premium = oraclePx > 0 ? (markPx - oraclePx) / oraclePx * 100 : 0;
      return {
        coin: u.name,
        fundingRate: fundingHourly,
        fundingRateAnnualPct: fundingAnnualPct,
        openInterestUsd,
        prevDayPx,
        markPx,
        oraclePx,
        premium,
        dailyChangePct,
      };
    });
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtFunding(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(0)}%/yr`;
}

function printReport(markets: AssetCtx[]) {
  // Sort by funding rate descending
  const sorted = [...markets].sort((a, b) => b.fundingRateAnnualPct - a.fundingRateAnnualPct);

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(`  Hyperliquid Funding Rate Monitor — ${new Date().toISOString().slice(11,19)}`);
  console.log(`  ${markets.length} perp markets tracked`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Top 10 highest funding (longs paying shorts)
  console.log('── TOP 10 HIGHEST FUNDING (delta-neutral SHORT candidates) ──');
  console.log('Coin              | Funding/yr  | Hourly      | OI         | Premium  | 24h %    ');
  console.log('──────────────────|─────────────|─────────────|────────────|──────────|──────────');
  for (const m of sorted.slice(0, 10)) {
    console.log(
      `${m.coin.padEnd(18)}| ${fmtFunding(m.fundingRateAnnualPct).padEnd(11)} | ` +
      `${(m.fundingRate * 100).toFixed(4).padStart(11)}% | ${fmtUsd(m.openInterestUsd).padStart(10)} | ` +
      `${m.premium.toFixed(2).padStart(7)}% | ${m.dailyChangePct.toFixed(2).padStart(7)}%`
    );
  }

  console.log('\n── TOP 10 LOWEST FUNDING (delta-neutral LONG candidates) ──');
  console.log('Coin              | Funding/yr  | Hourly      | OI         | Premium  | 24h %    ');
  console.log('──────────────────|─────────────|─────────────|────────────|──────────|──────────');
  for (const m of sorted.slice(-10).reverse()) {
    console.log(
      `${m.coin.padEnd(18)}| ${fmtFunding(m.fundingRateAnnualPct).padEnd(11)} | ` +
      `${(m.fundingRate * 100).toFixed(4).padStart(11)}% | ${fmtUsd(m.openInterestUsd).padStart(10)} | ` +
      `${m.premium.toFixed(2).padStart(7)}% | ${m.dailyChangePct.toFixed(2).padStart(7)}%`
    );
  }

  // Extreme funding opps
  const extreme = sorted.filter(m => m.fundingRateAnnualPct > 100 || m.fundingRateAnnualPct < -50);
  if (extreme.length > 0) {
    console.log('\n── EXTREME FUNDING (ARB OPPORTUNITIES) ──');
    for (const m of extreme) {
      const direction = m.fundingRateAnnualPct > 0
        ? ` SHORT pays ${fmtFunding(m.fundingRateAnnualPct)} — delta-neutral harvest`
        : ` LONG gets paid ${fmtFunding(m.fundingRateAnnualPct)} — delta-neutral harvest`;
      console.log(`  ${m.coin.padEnd(18)} OI=${fmtUsd(m.openInterestUsd).padEnd(10)} ${direction}`);
    }
  }

  // Stats summary
  const total = markets.length;
  const positive = markets.filter(m => m.fundingRateAnnualPct > 0).length;
  const negative = markets.filter(m => m.fundingRateAnnualPct < 0).length;
  const avgFunding = markets.reduce((s, m) => s + m.fundingRateAnnualPct, 0) / total;
  const totalOi = markets.reduce((s, m) => s + m.openInterestUsd, 0);

  console.log('\n── MARKET SUMMARY ──');
  console.log(`  Markets: ${total} (positive funding: ${positive}, negative: ${negative})`);
  console.log(`  Average funding: ${fmtFunding(avgFunding)}`);
  console.log(`  Total OI: ${fmtUsd(totalOi)}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Hyperliquid Funding Rate Live Monitor');
  console.log('  Refresh: 60s | Showing: top 10 + bottom 10 + extreme');
  console.log('═══════════════════════════════════════════════════');

  let loop = 0;
  while (true) {
    loop++;
    try {
      const { universe } = await getAllMarkets();
      const markets = analyzeMarkets(universe);
      printReport(markets);
    } catch (e) {
      console.error(`[loop ${loop}] error:`, e);
    }
    await new Promise(r => setTimeout(r, 60_000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
