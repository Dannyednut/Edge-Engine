// Raydium CLMM Price Quoter for Solana
// Queries Raydium CLMM pools for token prices
// Used for cross-AMM comparison with pump.fun bonding curve

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

// Raydium API endpoints
const RAYDIUM_API = 'https://api.raydium.io/v2';
const RAYDIUM_CLMM_POOLS = 'https://api.raydium.io/v2/clmm/pools';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Raydium Price Quoter Test');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Try Raydium API
  console.log('── Test 1: Raydium CLMM Pools API ──');
  try {
    const res = await fetch(`${RAYDIUM_CLMM_POOLS}?pageSize=10`);
    if (res.ok) {
      const data = await res.json() as any;
      console.log(`✅ Success! Got ${data?.data?.length || 0} pools`);
      if (data?.data?.[0]) {
        console.log('Sample pool:', JSON.stringify(data.data[0], null, 2).substring(0, 500));
      }
    } else {
      console.log(`❌ Status: ${res.status}`);
    }
  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
  }

  // 2. Try Jupiter Price API V6 (already tested — works for migrated tokens)
  console.log('\n── Test 2: Jupiter Price API V6 ──');
  try {
    const testMints = [
      { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' }, // WIF (migrated)
      { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' }, // BONK
      { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' }, // USDC
    ];
    for (const t of testMints) {
      const res = await fetch(`https://price.jup.ag/v6/price?ids=${t.mint}`);
      if (res.ok) {
        const data = await res.json() as any;
        const price = data?.data?.[t.mint]?.price;
        if (price) {
          console.log(`  ✅ ${t.symbol}: $${price}`);
        } else {
          console.log(`  ❌ ${t.symbol}: no price`);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
  }

  // 3. Load pump.fun watchlist and check which tokens are on Jupiter
  console.log('\n── Test 3: Pump.fun watchlist on Jupiter ──');
  try {
    const watchlist = JSON.parse(readFileSync('/home/z/my-project/download/pump-watchlist.json', 'utf8'));
    console.log(`Watchlist: ${watchlist.length} tokens`);

    let onJupiter = 0;
    let notOnJupiter = 0;
    for (const token of watchlist.slice(0, 30)) {
      try {
        const res = await fetch(`https://price.jup.ag/v6/price?ids=${token.mint}`);
        if (res.ok) {
          const data = await res.json() as any;
          const price = data?.data?.[token.mint]?.price;
          if (price) {
            onJupiter++;
            console.log(`  ✅ ${token.symbol || token.mint.substring(0, 12)}: $${price}`);
          } else {
            notOnJupiter++;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    console.log(`\n  On Jupiter (migrated): ${onJupiter}`);
    console.log(`  Not on Jupiter (still on bonding curve): ${notOnJupiter}`);
  } catch (e: any) {
    console.log(`Error: ${e.message}`);
  }

  console.log('\n=== Verdict ===');
  console.log('Cross-AMM price comparison:');
  console.log('  - For migrated tokens: Jupiter API works (free, no auth)');
  console.log('  For bonding curve tokens: Need PumpApi (Lightning mode)');
  console.log('');
  console.log('Cross-AMM arb opportunities:');
  console.log('  1. Bonding curve → PumpSwap (during migration event)');
  console.log('  2. PumpSwap → Raydium CLMM (post-migration spread)');
  console.log('  3. Raydium CLMM → Meteora DLMM (cross-AMM)');
  console.log('');
  console.log('NEXT: Build scanner that detects these spreads');
}

main().catch(console.error);
