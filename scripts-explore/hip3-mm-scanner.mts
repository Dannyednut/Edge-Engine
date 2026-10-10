// HIP-3 Market Maker Scanner
// Identifies active HIP-3 prediction markets suitable for market making
// Strategy: Quote bid + ask with 1-5% spread on active markets
// Risk: Inventory risk (hold tokens), resolution risk
//
// This is a REAL strategy we can deploy with $5-10k capital

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

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HIP-3 Market Maker Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get all spot markets (HIP-3 prediction markets appear as spot)
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta[0].universe || [];
  const ctxs = spotMeta[1] || [];
  const tokens = spotMeta[0].tokens || [];

  // 2. Filter for prediction-style markets (price < $1.50, has volume)
  const predictionMarkets: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const dayPct = parseFloat(ctxs[i]?.dayNtlVlm || '0');

    // Prediction markets: price between $0.01 and $1.50, volume > $1k
    if (markPx > 0.01 && markPx < 1.50 && vol > 1000) {
      predictionMarkets.push({
        name,
        price: markPx,
        volume: vol,
        index: i,
        // For prediction markets, price = probability
        impliedProb: markPx * 100,
      });
    }
  }

  // Sort by volume descending
  predictionMarkets.sort((a, b) => b.volume - a.volume);

  console.log(`Found ${predictionMarkets.length} active prediction-style markets\n`);

  // 3. Display top 20
  console.log('── Top 20 by Volume (MM candidates) ──');
  console.log('Name                | Price      | Implied Prob | 24h Volume | MM Score');
  console.log('────────────────────|────────────|──────────────|────────────|─────────');

  const mmCandidates: any[] = [];
  for (const m of predictionMarkets.slice(0, 20)) {
    // MM score: higher volume + mid-range probability = better for MM
    // Markets near 0% or 100% have less trading (outcome is certain)
    const probScore = m.impliedProb > 10 && m.impliedProb < 90 ? 1 : 0.3;
    const volScore = Math.min(1, m.volume / 100_000);
    const mmScore = (volScore * 0.6 + probScore * 0.4) * 100;

    mmCandidates.push({ ...m, mmScore });
    console.log(`${m.name.padEnd(20)}| $${m.price.toFixed(4).padStart(10)}| ${m.impliedProb.toFixed(1).padStart(11)}% | $${(m.volume/1000).toFixed(0).padStart(9)}k | ${mmScore.toFixed(0).padStart(7)}`);
  }

  // 4. MM strategy economics
  console.log('\n── Market Maker Economics ──\n');
  console.log('  Strategy: Quote bid + ask with 1-5% spread');
  console.log('  Capital: $1-5k per market');
  console.log('  Max 10 markets simultaneously');
  console.log('');

  const topMarkets = mmCandidates.filter(m => m.mmScore > 30).slice(0, 10);
  let totalDailyProfit = 0;
  console.log('── Top 10 MM Candidates ──\n');
  for (const m of topMarkets) {
    // Assume 0.5% of daily volume captured at 2% spread
    const capturedVol = m.volume * 0.005;
    const spreadPct = 0.02;
    const dailyProfit = capturedVol * spreadPct;
    totalDailyProfit += dailyProfit;
    console.log(`  ${m.name.padEnd(20)} vol=$${(m.volume/1000).toFixed(0)}k  prob=${m.impliedProb.toFixed(0)}%  est profit=$${dailyProfit.toFixed(0)}/day`);
  }

  console.log(`\n  Total estimated daily profit: $${totalDailyProfit.toFixed(0)}`);
  console.log(`  Annual: $${(totalDailyProfit * 365).toFixed(0)}`);
  console.log(`  Capital needed: $${topMarkets.length * 2000} ($2k per market)`);
  console.log(`  APR: ${(totalDailyProfit * 365 / (topMarkets.length * 2000) * 100).toFixed(0)}%`);

  // 5. Risk analysis
  console.log('\n── Risk Analysis ──\n');
  console.log('  1. INVENTORY RISK');
  console.log('     - May accumulate one side if market moves');
  console.log('     - Mitigation: Max $500 per market, auto-rebalance');
  console.log('');
  console.log('  2. RESOLUTION RISK');
  console.log('     - Market may resolve unfavorably');
  console.log('     - Mitigation: Only MM markets > 7 days to resolution');
  console.log('');
  console.log('  3. ADVERSE SELECTION');
  console.log('     - Informed traders may pick off stale quotes');
  console.log('     - Mitigation: Tight spreads, fast updates');
  console.log('');

  console.log('=== Verdict ===');
  console.log(`Found ${mmCandidates.filter(m => m.mmScore > 30).length} viable MM markets`);
  console.log(`  Est. daily profit: $${totalDailyProfit.toFixed(0)}`);
  console.log(`  Est. annual: $${(totalDailyProfit * 365).toFixed(0)}`);
  console.log(`  Capital: $${topMarkets.length * 2000}`);
  console.log(`  APR: ${(totalDailyProfit * 365 / (topMarkets.length * 2000) * 100).toFixed(0)}%`);
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Build MM bot that quotes on top 5 markets');
  console.log('  2. Start with $500 per market ($2.5k total)');
  console.log('  3. Monitor for 7 days');
  console.log('  4. Scale to $5k per market if profitable');
}

main().catch(console.error);
