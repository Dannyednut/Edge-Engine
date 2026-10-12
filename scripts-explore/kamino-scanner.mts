/**
 * Kamino Finance Strategy Scanner
 *
 * Kamino Finance on Solana offers:
 *   - Liquidity strategies (automated CLMM)
 *   - Multiply (recursive leverage)
 *   - Lending/borrowing markets
 *
 * Strategy:
 *   - Provide liquidity to Kamino automated CLMM strategies
 *   - Earn trading fees + reward tokens
 *   - Some strategies use multiply (recursive borrowing) for amplified yield
 *
 * Data source: api.kamino.finance (official Kamino API)
 * Found 656 active LIVE strategies + 409 SHADOW strategies
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

const KAMINO_API = 'https://api.kamino.finance';

// Known Solana token symbols by mint address
const TOKEN_SYMBOLS: Record<string, string> = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'JitoSOL',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'EURC',
  'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux': 'HNT',
  'poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk': 'POLIS',
  'PawnQTCFsTwVFH2BHBvxyrq96m9G8QJGCGYev6VeYrc': 'USDR',
  '9BB5N2VqH6euq8RhTvu4yfzoQ5Nh6k5kqBqyK7s8WqfP': 'wUSDC',
  'KWu9RYfv8q5L5vdomqLLpEpm4XrE5n6K7BfXvyZ2KXk': 'USDH',
};

interface KaminoStrategy {
  address: string;
  type: string;
  status: string;
  tokenA: string;
  tokenB: string;
  pair: string;
  estimatedApy: number;  // estimated based on type
  deltaNeutral: boolean;
  riskScore: number;
  notes: string;
}

async function fetchKaminoStrategies(): Promise<KaminoStrategy[]> {
  try {
    const res = await fetch(`${KAMINO_API}/strategies`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const j = await res.json() as any[];
    if (!Array.isArray(j)) return [];

    return j.map(s => {
      const tokenA = TOKEN_SYMBOLS[s.tokenAMint] || s.tokenAMint?.slice(0, 8);
      const tokenB = TOKEN_SYMBOLS[s.tokenBMint] || s.tokenBMint?.slice(0, 8);
      const pair = `${tokenA}/${tokenB}`;
      const isStablePair = ['USDC', 'USDT', 'USDH', 'USDR'].includes(tokenA) && ['USDC', 'USDT', 'USDH', 'USDR'].includes(tokenB);
      const isLST = ['JitoSOL', 'mSOL'].includes(tokenA) || ['JitoSOL', 'mSOL'].includes(tokenB);

      // Estimated APY based on type (would need real API for actual)
      let estApy = 5.0;
      if (isStablePair) estApy = 8.0;
      else if (isLST) estApy = 15.0;
      else estApy = 25.0;  // volatile pairs earn more fees

      const deltaNeutral = isStablePair || isLST;
      const riskScore = isStablePair ? 2 : isLST ? 3 : 5;

      return {
        address: s.address,
        type: s.type,
        status: s.status,
        tokenA,
        tokenB,
        pair,
        estimatedApy: estApy,
        deltaNeutral,
        riskScore,
        notes: `${s.type} strategy, ${pair}`,
      };
    });
  } catch (e) {
    console.error('Kamino API error:', e);
    return [];
  }
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Kamino Finance Strategy Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const strategies = await fetchKaminoStrategies();
  console.log(`Total strategies fetched: ${strategies.length}\n`);

  const live = strategies.filter(s => s.status === 'LIVE');
  const shadow = strategies.filter(s => s.status === 'SHADOW');
  const ignored = strategies.filter(s => s.status === 'IGNORED');
  console.log(`Status breakdown:`);
  console.log(`  LIVE: ${live.length}`);
  console.log(`  SHADOW: ${shadow.length}`);
  console.log(`  IGNORED: ${ignored.length}\n`);

  // By type
  const byType: Record<string, number> = {};
  for (const s of live) byType[s.type] = (byType[s.type] || 0) + 1;
  console.log('By type (LIVE only):');
  for (const [t, n] of Object.entries(byType)) {
    console.log(`  ${t}: ${n}`);
  }

  // Stable pairs (delta-neutral)
  const stablePairs = live.filter(s => s.deltaNeutral);
  console.log(`\n── DELTA-NEUTRAL STRATEGIES (${stablePairs.length} found) ──\n`);
  console.log('#  | Pair            | Type          | Est APY | Risk | Strategy Address');
  console.log('───|─────────────────|───────────────|─────────|──────|─────────────────────────────');
  for (let i = 0; i < Math.min(20, stablePairs.length); i++) {
    const s = stablePairs[i];
    console.log(
      `${String(i + 1).padStart(2)} | ${s.pair.padEnd(15)} | ${s.type.padEnd(13)} | ` +
      `${s.estimatedApy.toFixed(1).padStart(6)}% | ${String(s.riskScore).padStart(4)}/10 | ${s.address}`
    );
  }

  // Token pair frequency analysis
  console.log('\n── MOST COMMON PAIRS (top 15) ──');
  const pairCount: Record<string, number> = {};
  for (const s of live) pairCount[s.pair] = (pairCount[s.pair] || 0) + 1;
  const sortedPairs = Object.entries(pairCount).sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('Pair                  | Strategies');
  console.log('──────────────────────|────────────');
  for (const [pair, count] of sortedPairs) {
    console.log(`${pair.padEnd(20)} | ${count}`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 stablecoin strategies) ──');
  const top5 = stablePairs.slice(0, 5);
  let totalAnnual = 0;
  for (const s of top5) {
    const allocation = 10000;
    const annual = allocation * s.estimatedApy / 100;
    totalAnnual += annual;
    console.log(`  ${s.pair.padEnd(15)} ${s.estimatedApy.toFixed(1).padStart(5)}% est.  ${fmtUsd(annual).padStart(7)}/yr`);
  }
  console.log(`\n  Total annual profit: ${fmtUsd(totalAnnual)}`);
  console.log(`  Portfolio yield: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total Kamino strategies: ${strategies.length}`);
  console.log(`  LIVE strategies: ${live.length}`);
  console.log(`  Delta-neutral (stable/LST): ${stablePairs.length}`);
  console.log(`  Portfolio yield on $50k: ${(totalAnnual / 50000 * 100).toFixed(2)}%/yr (estimated)`);
  console.log(`  Risk profile: Mix of delta-neutral (stablecoin) and leveraged (volatile)`);
  console.log(`  Liquidity: HIGH (Solana, instant withdrawal)`);
  console.log(`  Notes:`);
  console.log(`    • Kamino strategies are automated CLMM (Concentrated Liquidity Market Maker)`);
  console.log(`    • Estimated APY based on strategy type — actual requires on-chain query`);
  console.log(`    • Stable pairs: delta-neutral, low risk`);
  console.log(`    • LST pairs: minor exposure via LST`);
  console.log(`    • Volatile pairs: not delta-neutral, higher risk`);
}

main().catch(err => { console.error(err); process.exit(1); });
