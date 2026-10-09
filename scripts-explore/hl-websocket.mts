// Explore Hyperliquid WebSocket API
// HL provides WebSocket for real-time data:
//   - Order book updates
//   - Trades
//   - User events (fills, positions)
//
// WebSocket URL: wss://api.hyperliquid.xyz/ws
//
// Subscription channels:
//   - allMids — all market mid prices
//   - l2Book { coin } — order book for specific coin
//   - trades { coin } — trades for specific coin
//   - userFills { user } — user's fills
//   - userEvents { user } — all user events
//   - candle { coin, interval } — OHLCV candles
//   - notification { user } — user notifications

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

const HL_WS = 'wss://api.hyperliquid.xyz/ws';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Hyperliquid WebSocket Explorer (30s test)');
  console.log('═══════════════════════════════════════════════════\n');

  let eventCount = 0;
  const eventTypes: Record<string, number> = {};

  const ws = new WebSocket(HL_WS);

  const connectPromise = new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      console.log('✅ Connected to HL WebSocket');
      resolve();
    };
    ws.onerror = (err) => {
      console.log(`❌ WebSocket error: ${err}`);
      reject(new Error('WebSocket error'));
    };
  });

  try {
    await connectPromise;
  } catch {
    console.log('Failed to connect');
    return;
  }

  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') {
        dataStr = ev.data;
      } else if (ev.data instanceof ArrayBuffer) {
        dataStr = new TextDecoder().decode(ev.data);
      } else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
        dataStr = await ev.data.text();
      } else {
        dataStr = String(ev.data);
      }
      const msg = JSON.parse(dataStr);
      eventCount++;
      const channel = msg.channel || 'unknown';
      eventTypes[channel] = (eventTypes[channel] || 0) + 1;

      if (eventCount <= 10 || eventCount % 100 === 0) {
        console.log(`[${eventCount}] ${channel}: ${JSON.stringify(msg).substring(0, 150)}`);
      }
    } catch (e: any) {
      console.log(`Parse error: ${e.message}`);
    }
  };

  // Subscribe to channels
  console.log('\n── Subscribing to channels ──\n');

  // 1. allMids
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  console.log('✅ Subscribed to allMids');

  // 2. l2Book for BTC
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: 'BTC' } }));
  console.log('✅ Subscribed to l2Book (BTC)');

  // 3. trades for BTC
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'BTC' } }));
  console.log('✅ Subscribed to trades (BTC)');

  // 4. trades for ETH
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'ETH' } }));
  console.log('✅ Subscribed to trades (ETH)');

  // 5. trades for SOL
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: 'SOL' } }));
  console.log('✅ Subscribed to trades (SOL)');

  // 6. candle for BTC (1m interval)
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin: 'BTC', interval: '1m' } }));
  console.log('✅ Subscribed to candle (BTC 1m)');

  // Listen for 30 seconds
  console.log('\n── Listening for 30 seconds ──\n');
  await new Promise(r => setTimeout(r, 30_000));

  ws.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  WebSocket Test Complete');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total events: ${eventCount}`);
  console.log('\nEvents by channel:');
  for (const [ch, count] of Object.entries(eventTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ch.padEnd(20)} ${count}`);
  }

  console.log('\n── Strategy Implications ──\n');
  console.log('  With WebSocket, we can build:');
  console.log('  ✅ Real-time price monitor (instant alerts)');
  console.log('  ✅ Order book imbalance strategy (l2Book)');
  console.log('  ✅ Trade flow analysis (trades channel)');
  console.log('  ✅ Real-time funding rate monitor (allMids)');
  console.log('  ✅ User fill tracking (userFills)');
  console.log('  ✅ OHLCV candle updates (candle)');
  console.log('');
  console.log('  Build opportunities:');
  console.log('  1. Replace polling with WebSocket (faster, less API load)');
  console.log('  2. Real-time liquidation detector (trades analysis)');
  console.log('  3. Order book imbalance signals');
  console.log('  4. Trade flow momentum signals');
}

main().catch(console.error);
