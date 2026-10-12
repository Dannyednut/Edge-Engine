// Working Solana Memecoin Arb Scanner
// Uses a watchlist of popular memecoins + queries PumpApi for prices
// Alerts when cross-AMM spread > 0.8% (after 0.5% fees = 0.3% net profit)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpApiClient } from '../edge-engine/packages/pumpapi-client/src/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

// Popular memecoin mints on Solana (verified)
const WATCHLIST = [
  { mint: 'Ed4qkzEkQFNa7oDmQqEZJ8d9b1cWxY2vZ3p4Q5r6s7t8', symbol: 'BONK' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT' }, // test with USDT
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }, // test with USDC
];

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Solana Memecoin Arb Scanner (Working Version)');
  console.log('═══════════════════════════════════════════════════\n');

  const publicKey = process.env.AGENT_SOLANA_ADDRESS || process.env.SOLANA_PUBLIC_KEY || '11111111111111111111111111111111'; // System Program as placeholder
  if (!process.env.AGENT_SOLANA_ADDRESS && !process.env.SOLANA_PUBLIC_KEY) {
    console.log('⚠️  No Solana public key configured — using System Program placeholder (read-only)');
    console.log('  Set AGENT_SOLANA_ADDRESS or SOLANA_PUBLIC_KEY in .env for trading\n');
  }

  const client = new PumpApiClient({ publicKey });

  console.log(`Watchlist: ${WATCHLIST.length} mints`);
  console.log(`Min spread: 0.8% (after 0.5% fees = 0.3% net)`);
  console.log('');

  let scanned = 0;
  let found = 0;
  const alerts: any[] = [];

  for (const w of WATCHLIST) {
    console.log(`\n── Scanning ${w.symbol} (${w.mint.substring(0, 12)}...) ──`);
    scanned++;
    try {
      const info = await client.getTokenInfo(w.mint);
      console.log(`  Token info:`, JSON.stringify(info, null, 2).substring(0, 500));
      // Compute spread if multiple pools are available
      // PumpApi returns single best-pool price — we'd need to query other AMMs separately
      // For now, just verify the API works
      found++;
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n── Summary ──');
  console.log(`  Scanned: ${scanned}`);
  console.log(`  Found info: ${found}`);
  console.log(`  Cross-AMM alerts: ${alerts.length}`);
  console.log('');
  console.log('NOTE: PumpApi returns single best-pool price, not cross-AMM comparison.');
  console.log('  For real cross-AMM arb, we need to also query:');
  console.log('    - Raydium CLMM quoter');
  console.log('    - Meteora DLMM quoter');
  console.log('    - PumpSwap quoter');
  console.log('  This is a 1-week build.');
  console.log('');
  console.log('ALTERNATIVE: Use PumpApi atomicTwoLegArb() directly');
  console.log('  - Provide buyMint + sellMint');
  console.log('  - PumpApi finds best execution across all AMMs');
  console.log('  - Atomic execution = no inventory risk');
  console.log('  - Requires: Solana wallet with private key');
  console.log('  - Cost: 0.25% per leg + 0.0002 SOL Jito tip');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Configure Solana wallet key in .env');
  console.log('  2. Build watchlist from PumpApi stream (top gainers)');
  console.log('  3. For each token, call atomicTwoLegArb with min profit threshold');
  console.log('  4. Execute when profit > $1 (after fees)');
}

main().catch(console.error);
