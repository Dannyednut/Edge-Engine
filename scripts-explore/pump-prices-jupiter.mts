// Query token prices via Jupiter Aggregator API (free, no auth)
// Jupiter is the largest Solana DEX aggregator

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

const WATCHLIST_FILE = '/home/z/my-project/download/pump-watchlist.json';

async function getJupiterPrice(mint: string): Promise<{ price: number | null; source: string } | null> {
  try {
    // Jupiter Price API V6
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const price = data?.data?.[mint]?.price;
    if (price !== undefined && price !== null) {
      return { price, source: 'jupiter-v6' };
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Jupiter Price Query for Pump.fun Tokens');
  console.log('═══════════════════════════════════════════════════\n');

  let watchlist: any[] = [];
  try {
    watchlist = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch {
    console.log('No watchlist found. Run pump-discovery.mts first.');
    return;
  }

  console.log(`Watchlist: ${watchlist.length} tokens\n`);

  console.log('Token                  | Mint (first 20)            | Price (SOL)  | Source');
  console.log('───────────────────────|────────────────────────────|──────────────|──────────');

  let found = 0;
  for (const t of watchlist) {
    const result = await getJupiterPrice(t.mint);
    if (result && result.price !== null) {
      found++;
      console.log(`${(t.symbol || '?').padEnd(22)}| ${t.mint.substring(0, 28).padEnd(28)}| ${result.price.toFixed(8).padStart(12)} | ${result.source}`);
    } else {
      console.log(`${(t.symbol || '?').padEnd(22)}| ${t.mint.substring(0, 28).padEnd(28)}| ${'N/A'.padStart(12)} | (not on Jupiter)`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n── Summary ──`);
  console.log(`Total tokens: ${watchlist.length}`);
  console.log(`Prices found: ${found}`);
  console.log(`Not on Jupiter: ${watchlist.length - found}`);
  console.log('');
  console.log('NOTE: New pump.fun tokens may not be on Jupiter immediately.');
  console.log('  Jupiter aggregates Raydium, Meteora, PumpSwap, etc.');
  console.log('  Tokens appear on Jupiter only after migrating from pump.fun bonding curve.');
  console.log('');
  console.log('For fresh launches (still on bonding curve):');
  console.log('  - Use PumpApi getTokenInfo (needs auth)');
  console.log('  - Or query pump.fun bonding curve directly');
}

main().catch(console.error);
