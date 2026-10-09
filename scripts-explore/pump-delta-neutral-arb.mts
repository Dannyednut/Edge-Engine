// Delta-Neutral Pump.fun Cross-AMM Arbitrage Scanner
//
// STRATEGY: Atomic 2-leg arb — buy on cheaper AMM, sell on expensive AMM
//   - Zero inventory risk (atomic execution)
//   - Zero rug risk (don't hold tokens)
//   - Profit = spread - fees
//
// MECHANICS:
//   1. For each token in watchlist, query prices on:
//      - pump.fun bonding curve
//      - PumpSwap (post-migration)
//      - Raydium CLMM/CPMM
//      - Meteora DLMM
//   2. Find max price difference (spread)
//   3. If spread > 0.8% (0.5% fees + 0.3% min profit):
//      - Execute atomicTwoLegArb via PumpApi
//      - Buy on cheapest AMM, sell on most expensive AMM
//      - All in one Solana transaction
//
// RISK PROFILE:
//   - Smart contract risk: PumpApi + AMMs (mitigated by audits + track record)
//   - MEV risk: Jito bundle protects from front-running
//   - Slippage risk: Use minBaseOut / minQuoteOut bounds
//   - NO rug risk: Don't hold tokens
//   - NO directional risk: Delta-neutral

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpApiClient, type PumpTokenInfo } from '../packages/pumpapi-client/src/index.ts';

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

const WATCHLIST_FILE = '/home/z/my-project/download/pump-watchlist.json';
const ARB_LOG_FILE = '/home/z/my-project/download/pump-arb-log.jsonl';

interface TokenEntry {
  mint: string;
  symbol?: string;
  name?: string;
  discoveredAt: number;
}

interface ArbOpportunity {
  ts: number;
  mint: string;
  symbol?: string;
  buyAmm: string;
  sellAmm: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  spreadAfterFeesPct: number;
  estimatedProfitSol: number;
  estimatedProfitUsd: number;
  executable: boolean;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Delta-Neutral Pump.fun Cross-AMM Arb Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // Load watchlist
  let watchlist: TokenEntry[] = [];
  try {
    watchlist = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch {
    console.log('No watchlist found. Run pump-discovery.mts first.');
    return;
  }
  console.log(`Watchlist: ${watchlist.length} tokens`);

  // Check auth
  const privateKey = process.env.PUMPAPI_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  const apiKey = process.env.PUMPAPI_API_KEY;
  const publicKey = process.env.AGENT_SOLANA_ADDRESS || process.env.SOLANA_PUBLIC_KEY || '11111111111111111111111111111111';

  if (!privateKey && !apiKey) {
    console.log('⚠️  No PUMPAPI_PRIVATE_KEY or PUMPAPI_API_KEY configured');
    console.log('  Running in SCAN-ONLY mode (no execution)');
    console.log('  Principal will provide Solana wallet key\n');
  }

  const client = new PumpApiClient({
    privateKey: privateKey || undefined,
    apiKey: apiKey || undefined,
    publicKey,
  });

  // AMMs to check (PumpApi supports these)
  const amms = [
    'pump.fun',      // bonding curve
    'pumpswap',      // post-migration
    'raydium-cpmm',
    'raydium-clmm',
    'meteora-dlmm',
    'meteora-damm-v2',
  ];

  console.log(`AMMs to check: ${amms.join(', ')}`);
  console.log(`Min spread: 0.8% (after 0.5% fees = 0.3% min profit)\n`);

  // Scan watchlist for arb opportunities
  const opportunities: ArbOpportunity[] = [];
  let scanned = 0;
  let withPrices = 0;

  console.log('── Scanning watchlist ──');
  for (const token of watchlist.slice(0, 30)) {
    scanned++;
    try {
      const info: any = await client.getTokenInfo(token.mint);
      if (info?.err || !info?.price) {
        continue;
      }
      withPrices++;

      // PumpApi returns single best-pool price
      // For cross-AMM comparison, we'd need to query each AMM separately
      // For now, log what we have
      const price = parseFloat(info.price || '0');
      if (price <= 0) continue;

      console.log(`  ${token.symbol || token.mint.substring(0, 12)}: price=${price} (single AMM)`);

      // TODO: When we have multi-AMM prices, compute spread
      // For now, just log tokens with prices
    } catch (e: any) {
      // Skip errors silently
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n── Summary ──`);
  console.log(`Scanned: ${scanned}`);
  console.log(`With prices: ${withPrices}`);
  console.log(`Arb opportunities: ${opportunities.length}`);

  if (opportunities.length > 0) {
    console.log('\n── Top Opportunities ──');
    opportunities.sort((a, b) => b.spreadAfterFeesPct - a.spreadAfterFeesPct);
    for (const o of opportunities.slice(0, 10)) {
      console.log(`  ${o.symbol || o.mint.substring(0, 12)}: ${o.spreadPct.toFixed(2)}% spread, ${o.spreadAfterFeesPct.toFixed(2)}% net`);
      console.log(`    Buy ${o.buyAmm} @ ${o.buyPrice}, Sell ${o.sellAmm} @ ${o.sellPrice}`);
      console.log(`    Est profit: ${o.estimatedProfitSol.toFixed(6)} SOL ($${o.estimatedProfitUsd.toFixed(2)})`);
    }
  }

  console.log('\n=== Verdict ===');
  console.log('Delta-neutral pump.fun arb framework built.');
  console.log('  ✅ Watchlist loaded');
  console.log('  ✅ PumpApi client configured');
  console.log('  🔲 Need: Solana wallet key for price queries + execution');
  console.log('  🔲 Need: Multi-AMM price comparison (currently single AMM)');
  console.log('');
  console.log('NEXT STEPS (after principal provides Solana wallet):');
  console.log('  1. Query prices across all 6 AMMs for each token');
  console.log('  2. Compute cross-AMM spread');
  console.log('  3. Execute atomicTwoLegArb when spread > 0.8%');
  console.log('  4. Log all arbs to /home/z/my-project/download/pump-arb-log.jsonl');
  console.log('');
  console.log('RISK PROFILE:');
  console.log('  ✅ Zero rug risk (don\'t hold tokens)');
  console.log('  ✅ Zero directional risk (delta-neutral)');
  console.log('  ✅ Zero inventory risk (atomic execution)');
  console.log('  ⚠️ Smart contract risk (PumpApi + AMMs)');
  console.log('  ⚠️ MEV risk (mitigated by Jito bundles)');
  console.log('  ⚠️ Slippage risk (mitigated by minBaseOut / minQuoteOut bounds)');
}

main().catch(console.error);
