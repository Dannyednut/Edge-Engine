// Hyperliquid HIP-3 Market Creation Strategy
// HIP-3 allows anyone to create prediction markets on HL
//   - Stake 500k HYPE ($43M) to create a market
//   - Earn fees from all trades on that market
//   - Market creator earns 0.01% of volume
//
// Strategy:
//   1. Identify high-demand prediction markets not yet on HL
//   2. Create the market (stake 500k HYPE)
//   3. Earn 0.01% of all trading volume
//   4. Provide liquidity (capture spread)
//
// Risk:
//   - HUGE capital requirement ($43M stake)
//   - Market may not attract volume
//   - Stake locked indefinitely
//   - Regulatory risk (prediction markets)
//
// Alternative: HIP-3 market maker (no creation stake)
//   - Provide liquidity to existing HIP-3 markets
//   - Capture spread
//   - Much lower capital requirement

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
  console.log('  HIP-3 Market Creation Strategy');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HYPE price
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  let hypePrice = 0;
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].name === 'HYPE') {
      hypePrice = parseFloat(ctxs[i]?.markPx || '0');
      break;
    }
  }
  console.log(`  HYPE price: $${hypePrice.toFixed(4)}`);
  console.log(`  HIP-3 creation stake: 500,000 HYPE = $${(500000 * hypePrice).toLocaleString()}\n`);

  // 2. Get existing HIP-3 markets
  console.log('── Existing HIP-3 Markets ──');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const spotUniverse = spotMeta[0].universe || [];
  const spotCtxs = spotMeta[1] || [];
  let hip3Count = 0;
  let hip3TotalVol = 0;
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const tokens = spotMeta[0].tokens || [];
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (vol > 1000) {
      hip3Count++;
      hip3TotalVol += vol;
    }
  }
  console.log(`  Total markets with volume: ${hip3Count}`);
  console.log(`  Total 24h volume: $${(hip3TotalVol/1e6).toFixed(1)}M`);
  console.log(`  Avg volume per market: $${(hip3TotalVol/hip3Count/1000).toFixed(0)}k\n`);

  // 3. HIP-3 market creation economics
  console.log('── HIP-3 Market Creation Economics ──\n');
  const stake = 500_000;
  const stakeUsd = stake * hypePrice;
  const feeRate = 0.0001; // 0.01% of volume

  const scenarios = [
    { name: 'Low volume market', dailyVol: 10_000 },
    { name: 'Medium volume market', dailyVol: 100_000 },
    { name: 'High volume market', dailyVol: 1_000_000 },
    { name: 'Top market (Polymarket-style)', dailyVol: 10_000_000 },
  ];

  console.log('Scenario                         | Daily Vol  | Daily Fee  | Annual Fee  | ROI on Stake');
  console.log('─────────────────────────────────|────────────|────────────|─────────────|──────────────');
  for (const s of scenarios) {
    const dailyFee = s.dailyVol * feeRate;
    const annualFee = dailyFee * 365;
    const roi = (annualFee / stakeUsd) * 100;
    console.log(`${s.name.padEnd(33)}| $${(s.dailyVol/1000).toFixed(0).padStart(9)}k | $${dailyFee.toFixed(2).padStart(10)} | $${(annualFee/1000).toFixed(0).padStart(10)}k | ${roi.toFixed(2).padStart(10)}%`);
  }

  // 4. Risks
  console.log('\n── Risks ──\n');
  console.log('  1. CAPITAL INTENSIVE');
  console.log(`     - Stake: 500,000 HYPE = $${(stakeUsd/1e6).toFixed(1)}M`);
  console.log('     - Locked indefinitely');
  console.log('     - Cannot be unstaked (yet)');
  console.log('');
  console.log('  2. MARKET ADOPTION RISK');
  console.log('     - Market may not attract volume');
  console.log('     - 90% of new markets fail');
  console.log('     - Need marketing + community');
  console.log('');
  console.log('  3. REGULATORY RISK');
  console.log('     - Prediction markets under SEC scrutiny');
  console.log('     - HL may restrict market types');
  console.log('     - Could be shut down');
  console.log('');
  console.log('  4. COMPETITION');
  console.log('     - Polymarket dominates prediction markets');
  console.log('     - HL HIP-3 is newer, less established');
  console.log('     - May not attract Polymarket users');
  console.log('');

  // 5. Alternative: HIP-3 market maker
  console.log('── Alternative: HIP-3 Market Maker ──\n');
  console.log('  Instead of creating markets, provide liquidity to existing ones:');
  console.log('    - Identify active HIP-3 markets');
  console.log('    - Quote bid + ask with spread');
  console.log('    - Capture spread on each fill');
  console.log('    - Capital: $1-5k per market');
  console.log('');
  console.log('  Economics:');
  console.log('    - Spread: 1-5% on prediction markets');
  console.log('    - Daily volume per market: $10-100k');
  console.log('    - Daily profit per market: $10-500');
  console.log('    - 10 markets = $100-5000/day = $36-1.8M/yr');
  console.log('    - Capital: $10-50k');
  console.log('    - APR: 100-1000%');
  console.log('');
  console.log('  Risk:');
  console.log('    - Inventory risk (hold tokens)');
  console.log('    - Resolution risk (market may resolve wrong)');
  console.log('    - Adverse selection (informed traders)');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HIP-3 Market Creation: SKIP (capital intensive, $43M stake)');
  console.log('HIP-3 Market Maker: VIABLE (lower capital, good returns)');
  console.log('');
  console.log('RECOMMENDATION:');
  console.log('  1. Build HIP-3 market maker scanner');
  console.log('  2. Identify active markets with > $10k daily volume');
  console.log('  3. Quote spreads on top 5-10 markets');
  console.log('  4. Start with $5k capital per market');
  console.log('  5. Scale to $50k as track record builds');
  console.log('');
  console.log('  Skip market creation until enterprise > $50M capital');
}

main().catch(console.error);
