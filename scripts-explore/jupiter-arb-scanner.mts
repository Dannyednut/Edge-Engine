/**
 * Jupiter Aggregator Arb Scanner
 * 
 * Uses Jupiter Price API to find arb opportunities across Solana DEXs
 * Jupiter aggregates: Raydium, Meteora, Orca, Phoenix, PumpSwap
 * 
 * Strategy:
 *   1. Get prices for top Solana tokens via Jupiter
 *   2. Compare with HL perp prices for same tokens
 *   3. If spread > 0.5%, arb exists
 *   4. Execute via Jupiter swap on Solana + HL perp order
 * 
 * This works WITHOUT VOOI — direct Solana DEX ↔ HL
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getJupiterPrice(tokenMint: string): Promise<number | null> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${tokenMint}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.data?.[tokenMint]?.price ?? null;
  } catch { return null; }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Jupiter DEX Arb Scanner — Solana ↔ HL');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL perp prices
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];

  // 2. Top Solana tokens on HL
  const solanaTokens = [
    { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
    { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR97V4gzZd1r6P5c5eLXNw7' },
    { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEihjQZH3oW7N9C2t2R6A9w6Q2E' },
    { symbol: 'JTO', mint: 'jtojtomepa8beP8AuQc6eXt5FriJywfmZjsxxmMFHco' },
    { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pgPBw' },
    { symbol: 'MNGO', mint: 'MangoCzJ36AjZrKasBXjmpLgRUfkVYkBqzc2Jx5aTf1' },
  ];

  console.log('── Comparing HL Perp vs Jupiter DEX Prices ──\n');
  console.log('Token   | HL Perp $    | Jupiter $   | Spread %  | Direction');
  console.log('────────|──────────────|─────────────|───────────|───────────────────');

  const opportunities: any[] = [];

  for (const token of solanaTokens) {
    // Find on HL
    const hlIdx = universe.findIndex((u: any) => u.name === token.symbol);
    if (hlIdx < 0) continue;
    const hlPrice = parseFloat(ctxs[hlIdx]?.markPx || '0');
    if (hlPrice <= 0) continue;

    // Get Jupiter price
    const jupPrice = await getJupiterPrice(token.mint);
    if (!jupPrice || jupPrice <= 0) {
      console.log(`${token.symbol.padEnd(8)}| $${hlPrice.toFixed(6).padStart(12)}| N/A         | -         | Jupiter unavailable`);
      continue;
    }

    const spread = ((hlPrice - jupPrice) / jupPrice) * 100;
    const direction = spread > 0.5 ? 'SHORT HL / BUY DEX' : spread < -0.5 ? 'LONG HL / SELL DEX' : 'NEUTRAL';
    
    console.log(`${token.symbol.padEnd(8)}| $${hlPrice.toFixed(6).padStart(12)}| $${jupPrice.toFixed(6).padStart(11)}| ${spread.toFixed(3).padStart(9)}%| ${direction}`);

    if (Math.abs(spread) > 0.5) {
      opportunities.push({
        symbol: token.symbol,
        hlPrice,
        jupPrice,
        spread,
        direction,
      });
    }
    
    await new Promise(r => setTimeout(r, 200));
  }

  // 3. Show opportunities
  console.log('\n── Arb Opportunities (>0.5%) ──\n');
  if (opportunities.length === 0) {
    console.log('  No arbs > 0.5% — Solana DEX ↔ HL tracking efficiently');
  } else {
    for (const o of opportunities) {
      const profit5k = Math.abs(o.spread) / 100 * 5000;
      console.log(`  ${o.symbol}: ${o.spread.toFixed(3)}% — ${o.direction}`);
      console.log(`    HL: $${o.hlPrice.toFixed(6)} | DEX: $${o.jupPrice.toFixed(6)} | Profit on $5k: $${profit5k.toFixed(2)}`);
    }
  }

  console.log('\n── Strategy ──\n');
  console.log('  If spread exists:');
  console.log('    1. Flashloan USDC on Solana (or use own capital)');
  console.log('    2. Swap on Jupiter DEX (buy cheap)');
  console.log('    3. Place opposite order on HL perp (sell expensive)');
  console.log('    4. Close both when prices converge');
  console.log('');
  console.log('  Requirements:');
  console.log('    - Solana wallet with USDC (for DEX swap)');
  console.log('    - HL account with USDC (for perp order)');
  console.log('    - Jupiter API for price quotes');
  console.log('    - Both legs need to be placed quickly (price moves fast)');

  console.log('\n=== Verdict ===');
  console.log(`Found ${opportunities.length} Solana DEX ↔ HL arb opportunities`);
  console.log('  Currently no large spreads (markets efficient)');
  console.log('  Spikes occur during volatility — monitor continuously');
}

main().catch(console.error);
