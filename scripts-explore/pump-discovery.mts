// Pump.fun Token Discovery + Price Tracker
// Listens to PumpApi stream for new token launches
// Tracks prices and identifies arb opportunities

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PumpStreamClient, PumpApiClient } from '../packages/pumpapi-client/src/index.ts';

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
const PRICE_LOG_FILE = '/home/z/my-project/download/pump-price-log.jsonl';

interface TokenEntry {
  mint: string;
  symbol?: string;
  name?: string;
  discoveredAt: number;
  lastPrice?: number;
  lastPriceAt?: number;
  volume24h?: number;
  marketCap?: number;
}

function loadWatchlist(): TokenEntry[] {
  if (existsSync(WATCHLIST_FILE)) {
    return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8'));
  }
  return [];
}

function saveWatchlist(list: TokenEntry[]) {
  writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2));
}

function logPrice(entry: TokenEntry) {
  const line = JSON.stringify({
    ts: Date.now(),
    mint: entry.mint,
    symbol: entry.symbol,
    price: entry.lastPrice,
    volume24h: entry.volume24h,
    marketCap: entry.marketCap,
  }) + '\n';
  if (existsSync(PRICE_LOG_FILE)) {
    const existing = readFileSync(PRICE_LOG_FILE, 'utf8').split('\n').filter(l => l.trim());
    existing.push(JSON.stringify({
      ts: Date.now(),
      mint: entry.mint,
      symbol: entry.symbol,
      price: entry.lastPrice,
      volume24h: entry.volume24h,
      marketCap: entry.marketCap,
    }));
    writeFileSync(PRICE_LOG_FILE, existing.join('\n') + '\n');
  } else {
    writeFileSync(PRICE_LOG_FILE, line);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Pump.fun Token Discovery + Price Tracker');
  console.log('═══════════════════════════════════════════════════\n');

  const publicKey = process.env.AGENT_SOLANA_ADDRESS || process.env.SOLANA_PUBLIC_KEY || '11111111111111111111111111111111';
  const client = new PumpApiClient({ publicKey });

  let watchlist = loadWatchlist();
  console.log(`Loaded watchlist: ${watchlist.length} tokens`);

  let eventCount = 0;
  let launchCount = 0;
  let tradeCount = 0;
  const newLaunches: TokenEntry[] = [];

  // Listen for 60 seconds
  const LISTEN_MS = 30_000;

  const stream = new PumpStreamClient({
    onConnect: () => console.log('✅ Connected to PumpApi stream'),
    onDisconnect: (err) => console.log(`⚠️  Disconnected: ${err?.message || 'unknown'}`),
    onEvent: (event: any) => {
      eventCount++;
      const action = event.action || 'unknown';
      const type = event.type || '';

      // Detect new token launches
      if (action === 'create' || type === 'create' || action === 'token_created') {
        launchCount++;
        const mint = event.mint;
        if (mint && !watchlist.find(t => t.mint === mint)) {
          const entry: TokenEntry = {
            mint,
            symbol: event.symbol,
            name: event.name,
            discoveredAt: Date.now(),
          };
          watchlist.push(entry);
          newLaunches.push(entry);
          if (launchCount <= 10) {
            console.log(`🚀 NEW TOKEN: ${entry.symbol || mint.substring(0, 12)} (${mint.substring(0, 20)}...)`);
          }
        }
      }

      // Count trades
      if (action === 'buy' || action === 'sell') {
        tradeCount++;
      }

      // Print summary every 500 events
      if (eventCount % 500 === 0) {
        console.log(`[${new Date().toISOString().substring(11, 19)}] ${eventCount} events, ${launchCount} launches, ${tradeCount} trades, watchlist=${watchlist.length}`);
      }
    },
  });

  console.log('Connecting to stream...');
  await stream.connect();
  console.log(`Listening for ${LISTEN_MS/1000} seconds...\n`);

  await new Promise(r => setTimeout(r, LISTEN_MS));

  console.log('\n── Stream Listen Complete ──');
  console.log(`Total events: ${eventCount}`);
  console.log(`Token launches: ${launchCount}`);
  console.log(`Trades: ${tradeCount}`);
  console.log(`Watchlist size: ${watchlist.length}`);
  console.log(`New tokens discovered: ${newLaunches.length}`);

  // Save watchlist
  saveWatchlist(watchlist);
  console.log(`\nWatchlist saved to ${WATCHLIST_FILE}`);

  // Query prices for top 10 new tokens
  if (newLaunches.length > 0) {
    console.log('\n── Querying prices for top 10 new tokens ──');
    for (const token of newLaunches.slice(0, 10)) {
      try {
        const info: any = await client.getTokenInfo(token.mint);
        if (info && !info.err) {
          token.lastPrice = info.price;
          token.volume24h = info.volume24h;
          token.marketCap = info.marketCap;
          console.log(`  ${token.symbol || token.mint.substring(0, 12)}: price=${info.price} vol24h=${info.volume24h} mc=${info.marketCap}`);
          logPrice(token);
        } else {
          console.log(`  ${token.symbol || token.mint.substring(0, 12)}: ${info?.err || 'no data'}`);
        }
      } catch (e: any) {
        console.log(`  ${token.symbol || token.mint.substring(0, 12)}: ERROR ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  stream.close();

  console.log('\n=== Verdict ===');
  console.log(`Discovered ${newLaunches.length} new pump.fun tokens in ${LISTEN_MS/1000}s`);
  console.log(`Annual run rate: ~${(newLaunches.length * 60 * 60 * 24 * 365 / LISTEN_MS).toFixed(0)} tokens/yr`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Build price tracker (query every 30s for watchlist)');
  console.log('  2. Detect cross-AMM spreads (need Raydium/Meteora quoters)');
  console.log('  3. Execute via atomicTwoLegArb when spread > 0.8%');
  console.log('  4. Need: Solana wallet key for execution');
}

main().catch(console.error);
