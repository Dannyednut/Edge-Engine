// Pump.fun Scanner → Executor Pipeline
// Connects the token discovery stream to the arb executor
//
// Flow:
//   1. PumpStreamClient listens for new token launches
//   2. For each new token, add to watchlist
//   3. Periodically (every 30s), query prices across all AMMs
//   4. When cross-AMM spread > 0.8%, call executor
//   5. Executor executes atomicTwoLegArb
//   6. Log all activities

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
const ARB_LOG_FILE = '/home/z/my-project/download/pump-arb-log.jsonl';

interface TokenEntry {
  mint: string;
  symbol?: string;
  name?: string;
  discoveredAt: number;
  lastScan?: number;
  lastPrice?: number;
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

function logArb(entry: any) {
  if (existsSync(ARB_LOG_FILE)) {
    const existing = readFileSync(ARB_LOG_FILE, 'utf8').split('\n').filter(l => l.trim());
    existing.push(JSON.stringify(entry));
    writeFileSync(ARB_LOG_FILE, existing.join('\n') + '\n');
  } else {
    writeFileSync(ARB_LOG_FILE, JSON.stringify(entry) + '\n');
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Pump.fun Scanner → Executor Pipeline');
  console.log('═══════════════════════════════════════════════════\n');

  const privateKey = process.env.PUMPAPI_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
  const publicKey = process.env.AGENT_SOLANA_ADDRESS || process.env.SOLANA_PUBLIC_KEY || '11111111111111111111111111111111';

  console.log('── Configuration ──');
  console.log(`  Public key: ${publicKey}`);
  console.log(`  Private key: ${privateKey ? '(set)' : '(not set — scan only)'}`);
  console.log(`  Pipeline: Stream → Watchlist → Scanner → Executor`);
  console.log('');

  let watchlist = loadWatchlist();
  console.log(`Watchlist: ${watchlist.length} tokens\n`);

  let eventCount = 0;
  let launchCount = 0;
  let arbAttempts = 0;
  let arbSuccesses = 0;

  // 1. Start stream listener
  console.log('── Starting PumpApi Stream ──');
  const stream = new PumpStreamClient({
    onConnect: () => console.log('✅ Stream connected'),
    onDisconnect: (err) => console.log(`⚠️  Stream disconnected: ${err?.message || 'unknown'}`),
    onEvent: (event: any) => {
      eventCount++;
      const action = event.action || 'unknown';
      if (action === 'create' || event.type === 'create') {
        launchCount++;
        const mint = event.mint;
        if (mint && !watchlist.find(t => t.mint === mint)) {
          watchlist.push({
            mint,
            symbol: event.symbol,
            name: event.name,
            discoveredAt: Date.now(),
          });
          if (launchCount <= 5) {
            console.log(`🚀 NEW: ${event.symbol || mint.substring(0, 12)}`);
          }
        }
      }
    },
  });

  await stream.connect();

  // 2. Run pipeline for 60 seconds
  const PIPELINE_MS = 60_000;
  console.log(`\nRunning pipeline for ${PIPELINE_MS/1000} seconds...\n`);

  const client = new PumpApiClient({
    privateKey: privateKey || undefined,
    publicKey,
  });

  // Price scan loop (every 10 seconds)
  const scanInterval = setInterval(async () => {
    console.log(`\n── Price Scan (${watchlist.length} tokens) ──`);
    let scanned = 0;
    let withPrices = 0;
    const arbs: any[] = [];

    for (const token of watchlist.slice(0, 20)) {
      scanned++;
      try {
        const info: any = await client.getTokenInfo(token.mint);
        if (info?.err || !info?.price) continue;
        withPrices++;
        token.lastPrice = parseFloat(info.price);
        token.lastScan = Date.now();

        // TODO: Query other AMMs for cross-AMM comparison
        // For now, just log tokens with prices
        console.log(`  ${token.symbol || token.mint.substring(0, 12)}: ${token.lastPrice} SOL`);
      } catch (e: any) {
        // Skip
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`  Scanned: ${scanned}, With prices: ${withPrices}, Arbs: ${arbs.length}`);

    // Save watchlist
    saveWatchlist(watchlist);

    // Execute arbs (if any)
    for (const arb of arbs) {
      arbAttempts++;
      console.log(`  💰 ARB: ${arb.symbol} ${arb.spreadPct.toFixed(2)}% — would execute`);
      // TODO: Call executor.executeArb(arb)
      logArb({
        ts: Date.now(),
        ...arb,
        status: 'detected',
        note: 'Pipeline detected arb — executor not yet connected',
      });
    }
  }, 10_000);

  // Run for PIPELINE_MS
  await new Promise(r => setTimeout(r, PIPELINE_MS));
  clearInterval(scanInterval);

  stream.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Pipeline Summary');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Stream events: ${eventCount}`);
  console.log(`New launches: ${launchCount}`);
  console.log(`Watchlist size: ${watchlist.length}`);
  console.log(`Arb attempts: ${arbAttempts}`);
  console.log(`Arb successes: ${arbSuccesses}`);
  console.log('');
  console.log('Pipeline framework READY.');
  console.log('  ✅ Stream listener → watchlist');
  console.log('  ✅ Periodic price scan');
  console.log('  🔲 Cross-AMM price comparison (needs multi-AMM query)');
  console.log('  🔲 Executor connection (needs wallet funded)');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. Principal funds Solana wallet');
  console.log('  2. Build multi-AMM price query (Raydium/Meteora quoters)');
  console.log('  3. Connect scanner → executor');
  console.log('  4. Test with $5 trades first');
  console.log('  5. Scale to $50-200 per arb');
}

main().catch(console.error);
