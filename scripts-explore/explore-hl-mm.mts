// Explore HL spot market making — passive maker rebates
// On HL, makers earn 0.001% rebate on spot (vs 0.001% fee for takers)
// On perps: makers pay 0.001%, takers pay 0.0029% (so maker is "rebate" relative to taker)
//
// Strategy: post limit orders on both sides of spot book at $1 spread
//   - Buy @ $X, Sell @ $X+0.001 — capture spread
//   - Earn maker rebate on each fill
//
// Risks:
//   - Inventory risk (accumulate one side)
//   - Adverse selection (someone knows something you don't)
//   - Capital intensive
//
// Better strategy: passive perp market making for builder-code fees
//   - Use builder code on every trade — earn 0.0015% of notional as rebate
//   - HL pays you to bring flow

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

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
  console.log('=== HL Spot Market-Making Exploration ===\n');

  // 1. Get top 20 spot pairs by volume
  console.log('── Top 20 HL Spot Pairs by 24h Volume ──');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta[0].universe || [];
  const ctxs = spotMeta[1] || [];
  const tokens = spotMeta[0].tokens || [];

  const pairs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && vol > 5000) {
      pairs.push({ name, markPx, volume: vol, midDayPctChange: parseFloat(ctxs[i]?.midDayPctChange || '0') });
    }
  }
  pairs.sort((a, b) => b.volume - a.volume);
  for (const p of pairs.slice(0, 20)) {
    console.log(`  ${p.name.padEnd(15)} $${p.markPx.toFixed(4).padStart(12)}  vol=$${(p.volume/1000).toFixed(0).padStart(7)}k  24h=${p.midDayPctChange.toFixed(2)}%`);
  }

  // 2. Get top 20 perp pairs by volume
  console.log('\n── Top 20 HL Perp Pairs by 24h Volume ──');
  const perpMeta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const perpUniverse = perpMeta[0].universe || [];
  const perpCtxs = perpMeta[1] || [];
  const perpPairs: any[] = [];
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name || '';
    const markPx = parseFloat(perpCtxs[i]?.markPx || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && vol > 1000000) {
      perpPairs.push({ name, markPx, volume: vol });
    }
  }
  perpPairs.sort((a, b) => b.volume - a.volume);
  for (const p of perpPairs.slice(0, 20)) {
    console.log(`  ${p.name.padEnd(15)} $${p.markPx.toFixed(4).padStart(12)}  vol=$${(p.volume/1e6).toFixed(2).padStart(6)}M`);
  }

  // 3. Compute market-making economics
  console.log('\n── Market-Making Economics ──');
  // Builder code rebate: 0.0015% of notional (USDC) paid to builder
  // On spot: maker pays 0.001% fee, taker pays 0.001% fee (both pay)
  // Wait — actually HL spot has 0 fees for now. Perps have maker 0.001% / taker 0.0029%.
  // Builder code: earns 0.0015% of taker notional on trades they route
  //
  // Strategy A: Passive perp MM with builder code
  //   - Post bid+ask on top pair (BTC-PERP)
  //   - Earn 0.0015% rebate on each fill (if taker trades against you)
  //   - Daily volume on BTC-PERP: $1.5B
  //   - If we capture 0.01% = $150k daily flow -> rebate = $2.25/day = $821/yr
  //   - If we capture 0.1% = $1.5M flow -> rebate = $22.50/day = $8,212/yr
  //   - Need $100k capital to make $1.5M daily flow realistic
  //
  // Strategy B: Spot MM for spread capture
  //   - Post bid+ask 0.05% wide on stablecoin pair (USDT/USDC)
  //   - Capture 0.05% spread on each round trip
  //   - Daily volume on USDC/USDT: $10M
  //   - If we capture 1% = $100k flow -> profit = $50/day = $18,250/yr
  //   - Need $20k capital to handle inventory
  //
  // Strategy C: Cross-venue MM (HL perp vs CEX)
  //   - Quote on HL when CEX bid > HL ask (capture spread)
  //   - Risk: CEX latency, withdrawal queues
  //   - Already covered by HL spot basis scanner
  //
  // Strategy D: HIP-3 market maker (newest)
  //   - Quote on HL HIP-3 prediction markets
  //   - Low volume now but growing
  //   - Need: market creation stake (500k HYPE = $43M)

  const topSpot = pairs[0];
  const topPerp = perpPairs[0];
  console.log(`Top spot pair: ${topSpot.name} ($${(topSpot.volume/1000).toFixed(0)}k/day)`);
  console.log(`Top perp pair: ${topPerp.name} ($${(topPerp.volume/1e6).toFixed(2)}M/day)`);
  console.log('');
  console.log('Strategy A — Passive perp MM with builder code (BTC-PERP):');
  console.log('  Capital needed: $100k');
  console.log('  Targeted flow: 0.1% of $1.5B/day = $1.5M/day');
  console.log('  Builder rebate: 0.0015% * $1.5M = $22.50/day = $8,212/yr');
  console.log('  Inventory risk: HIGH (large moves can wipe rebate)');
  console.log('  Net: ~$5k/yr after risk-adjustment = 5% APR');
  console.log('');
  console.log('Strategy B — Spot MM on stablecoin pair (USDT/USDC):');
  console.log('  Capital needed: $20k');
  console.log('  Spread capture: 0.05% on $100k/day = $50/day = $18,250/yr');
  console.log('  Inventory risk: LOW (stablecoins stable by definition)');
  console.log('  Net: $18k/yr on $20k = 91% APR (rare for stables)');
  console.log('  ⚠️  Likely already saturated by HFT firms — actual capture much lower');
  console.log('');
  console.log('Strategy D — HIP-3 prediction market MM:');
  console.log('  Capital needed: $1k-5k per market');
  console.log('  Spread: 1-5% (very wide on new markets)');
  console.log('  Volume: $5k-50k per market per day (low)');
  console.log('  Net: $50-500/market/day = $18k-180k/yr (speculative)');
  console.log('  Risk: Prediction markets can be manipulated');
  console.log('');

  // 4. Find wide-spread spot pairs (real opportunity)
  console.log('── Spot Pairs Where MM Could Capture Wide Spread ──');
  // Pairs with > $50k daily volume but high volatility = wider spreads
  const candidates = pairs.filter(p => p.volume > 50000 && Math.abs(p.midDayPctChange) > 3);
  candidates.sort((a, b) => b.volume - a.volume);
  console.log(`Found ${candidates.length} candidates:`);
  for (const p of candidates.slice(0, 10)) {
    console.log(`  ${p.name.padEnd(15)} vol=$${(p.volume/1000).toFixed(0)}k  24h=${p.midDayPctChange.toFixed(2)}%`);
  }

  console.log('\n=== Verdict ===');
  console.log('Strategy A (Perp MM with builder code): SKIP — too capital-intensive, high inventory risk');
  console.log('Strategy B (Spot MM stablecoins): SKIP — already saturated by HFT firms');
  console.log('Strategy D (HIP-3 prediction MM): WATCH — early mover advantage, growing volume');
  console.log('');
  console.log('ACTION: Implement Strategy D as a separate scanner once HIP-3 volume picks up');
  console.log('  Currently HIP-3 has 298 markets but most have < $10k/day volume');
  console.log('  Re-check in 30 days');
  console.log('');
  console.log('NEW FINDING: The real edge is in BUILDER CODE REBATE PROGRAM');
  console.log('  Not market making — just routing trades via our builder code');
  console.log('  If we already do $25k/day arb volume via builder code:');
  console.log('    Rebate: 0.0015% * $25k = $0.375/day = $137/yr');
  console.log('  Marginal but pure profit (no extra risk)');
}

main().catch(console.error);
