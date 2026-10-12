// Opportunity Heatmap Generator
// Visual representation of all opportunities
// Shows which strategies + assets are hottest right now

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
const VOI_API = 'https://perps-api.vooi.io';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Opportunity Heatmap');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get all opportunities
  const [vooiPrice, vooiFunding, hlMeta] = await Promise.all([
    vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.001 }),
    vooiScan({ limit: 50, orderBy: 'fundingSpread1h', orderDirection: 'desc', minFundingSpread: 0.0001 }),
    hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  ]);

  // 2. Build heatmap data
  const heatmap: { asset: string; type: string; spread: number; profit5k: number; venues: string }[] = [];

  // VOOI Price Spread
  for (const item of (vooiPrice?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.3) continue;
      heatmap.push({
        asset: item.asset,
        type: 'PRICE',
        spread,
        profit5k: 5000 * spread / 100 - 15,
        venues: `${p.long?.exchange}→${p.short?.exchange}`,
      });
    }
  }

  // VOOI Funding
  for (const item of (vooiFunding?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.fundingSpread1h || 0) * 100;
      const annualApr = spread * 24 * 365;
      if (annualApr < 30) continue;
      heatmap.push({
        asset: item.asset,
        type: 'FUNDING',
        spread: annualApr,
        profit5k: 5000 * annualApr / 100 / 365 * 12, // 12h hold
        venues: `${p.long?.exchange}→${p.short?.exchange}`,
      });
    }
  }

  // HL Perp Funding
  const universe = hlMeta[0].universe || [];
  const ctxs = hlMeta[1] || [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const annualApr = funding * 24 * 365 * 100;
    if (Math.abs(annualApr) > 30 && vol > 5_000_000) {
      heatmap.push({
        asset: name,
        type: 'HL-FUNDING',
        spread: annualApr,
        profit5k: 5000 * annualApr / 100 / 365,
        venues: 'HL perp',
      });
    }
  }

  // 3. Sort by profit potential
  heatmap.sort((a, b) => b.profit5k - a.profit5k);

  // 4. Display heatmap
  console.log('── Top 30 Opportunities (ranked by profit on $5k) ──\n');

  // Heat intensity (1-5 based on profit)
  function getHeat(profit: number): string {
    if (profit > 200) return '🔥🔥🔥🔥🔥';
    if (profit > 100) return '🔥🔥🔥🔥 ';
    if (profit > 50) return '🔥🔥🔥  ';
    if (profit > 20) return '🔥🔥   ';
    if (profit > 5) return '🔥    ';
    return '      ';
  }

  console.log('#  | Heat       | Type       | Asset              | Spread       | Profit $5k  | Venues');
  console.log('───|────────────|────────────|────────────────────|──────────────|─────────────|───────────────────────');
  for (let i = 0; i < Math.min(30, heatmap.length); i++) {
    const o = heatmap[i];
    const heat = getHeat(o.profit5k);
    const spreadStr = o.type === 'PRICE' ? `${o.spread.toFixed(2)}%` : `${o.spread.toFixed(0)}%/yr`;
    console.log(`${(i+1).toString().padStart(2)} | ${heat} | ${o.type.padEnd(10)} | ${o.asset.padEnd(18)} | ${spreadStr.padEnd(12)} | $${o.profit5k.toFixed(0).padStart(9)} | ${o.venues}`);
  }

  // 5. Summary by type
  console.log('\n── Summary by Type ──\n');
  const byType: Record<string, { count: number; totalProfit: number; maxProfit: number }> = {};
  for (const o of heatmap) {
    if (!byType[o.type]) byType[o.type] = { count: 0, totalProfit: 0, maxProfit: 0 };
    byType[o.type].count++;
    byType[o.type].totalProfit += o.profit5k;
    byType[o.type].maxProfit = Math.max(byType[o.type].maxProfit, o.profit5k);
  }
  console.log('Type       | Count | Total Profit (5k each) | Max Profit | Avg Profit');
  console.log('───────────|───────|────────────────────────|────────────|───────────');
  for (const [type, data] of Object.entries(byType).sort((a, b) => b[1].totalProfit - a[1].totalProfit)) {
    const avg = data.totalProfit / data.count;
    console.log(`${type.padEnd(11)}| ${data.count.toString().padStart(5)} | $${data.totalProfit.toFixed(0).padStart(22)} | $${data.maxProfit.toFixed(0).padStart(10)} | $${avg.toFixed(0)}`);
  }

  // 6. Top assets
  console.log('\n── Top Assets (by number of opportunities) ──\n');
  const byAsset: Record<string, number> = {};
  for (const o of heatmap) {
    byAsset[o.asset] = (byAsset[o.asset] || 0) + 1;
  }
  const topAssets = Object.entries(byAsset).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [asset, count] of topAssets) {
    const bar = '█'.repeat(count);
    console.log(`  ${asset.padEnd(20)} ${bar} ${count}`);
  }

  // 7. Actionable summary
  console.log('\n── Actionable Summary ──\n');
  const actionable = heatmap.filter(o => o.profit5k > 20);
  console.log(`Total opportunities: ${heatmap.length}`);
  console.log(`Actionable (>$20 profit on $5k): ${actionable.length}`);
  console.log(`Total potential profit (all actionable): $${actionable.reduce((s, o) => s + o.profit5k, 0).toFixed(0)}`);
  console.log('');
  console.log('If we deploy $5k to each of top 10:');
  const top10 = heatmap.slice(0, 10);
  const totalProfit = top10.reduce((s, o) => s + o.profit5k, 0);
  console.log(`  Capital needed: $50,000 (10 × $5k)`);
  console.log(`  Total profit per cycle: $${totalProfit.toFixed(0)}`);
  console.log(`  If 1 cycle/day: $${(totalProfit * 365).toFixed(0)}/yr`);
  console.log(`  ROI: ${(totalProfit * 365 / 50000 * 100).toFixed(0)}%`);

  console.log('\n=== Verdict ===');
  console.log(`Heatmap shows ${heatmap.length} live opportunities.`);
  console.log(`  ${actionable.length} are actionable (>$20 profit on $5k)`);
  console.log(`  Top 10 total profit: $${totalProfit.toFixed(0)} per cycle`);
  console.log('');
  console.log('ACTION: Deploy capital to top opportunities');
  console.log('  Start with top 5 ($25k capital)');
  console.log('  Scale to top 10 ($50k) after 7-day track record');
}

main().catch(console.error);
