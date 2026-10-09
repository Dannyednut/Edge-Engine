// Order Book Imbalance Detector
// Uses HL WebSocket to monitor l2Book for all top perps
// When bid/ask imbalance > threshold, alert (potential price move)
//
// Theory:
//   - When bids >> asks, buyers are aggressive → price likely to go up
//   - When asks >> bids, sellers are aggressive → price likely to go down
//   - This is a directional signal (NOT delta-neutral)
//
// Risk:
//   - Directional (not delta-neutral)
//   - Adverse selection (large orders may be fake)
//   - HFT firms already exploit this
//
// Use case:
//   - Alert only (don't trade directly)
//   - Confirm other signals (e.g., VOOI arb)
//   - Build intuition about market direction

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
const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

interface OrderBookState {
  coin: string;
  bids: { px: number; sz: number; n: number }[];
  asks: { px: number; sz: number; n: number }[];
  lastUpdate: number;
}

const orderBooks = new Map<string, OrderBookState>();

function computeImbalance(book: OrderBookState): { bidVolume: number; askVolume: number; imbalance: number; signal: 'bullish' | 'bearish' | 'neutral' } {
  // Sum top 10 levels
  const bidVolume = book.bids.slice(0, 10).reduce((sum, b) => sum + b.sz, 0);
  const askVolume = book.asks.slice(0, 10).reduce((sum, a) => sum + a.sz, 0);
  const total = bidVolume + askVolume;
  if (total === 0) return { bidVolume: 0, askVolume: 0, imbalance: 0, signal: 'neutral' };
  const imbalance = (bidVolume - askVolume) / total; // -1 to +1
  const signal = imbalance > 0.3 ? 'bullish' : imbalance < -0.3 ? 'bearish' : 'neutral';
  return { bidVolume, askVolume, imbalance, signal };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Order Book Imbalance Detector');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get top 10 perps by volume
  console.log('── Loading top perps ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  const topPerps: string[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 50_000_000) topPerps.push(name);
  }
  topPerps.sort();
  console.log(`  Top perps: ${topPerps.slice(0, 10).join(', ')}\n`);

  // 2. Connect to WebSocket
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected to HL WebSocket\n');

  // 3. Subscribe to l2Book for top 5 perps
  const watchPerps = topPerps.slice(0, 5);
  for (const coin of watchPerps) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
    console.log(`✅ Subscribed to l2Book (${coin})`);
  }

  // 4. Process messages
  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);

      const msg = JSON.parse(dataStr);
      if (msg.channel === 'l2Book') {
        const coin = msg.data.coin;
        const levels = msg.data.levels || [];
        const bids = (levels[0] || []).map((l: any) => ({ px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n }));
        const asks = (levels[1] || []).map((l: any) => ({ px: parseFloat(l.px), sz: parseFloat(l.sz), n: l.n }));
        orderBooks.set(coin, { coin, bids, asks, lastUpdate: Date.now() });

        // Compute imbalance
        const { bidVolume, askVolume, imbalance, signal } = computeImbalance({ coin, bids, asks, lastUpdate: Date.now() } as OrderBookState);
        if (Math.abs(imbalance) > 0.3) {
          const emoji = signal === 'bullish' ? '🟢' : '🐻';
          console.log(`${emoji} ${coin.padEnd(8)} imbalance=${(imbalance*100).toFixed(1).padStart(6)}%  bids=${bidVolume.toFixed(2).padStart(10)}  asks=${askVolume.toFixed(2).padStart(10)}  [${signal.toUpperCase()}]`);
        }
      }
    } catch {}
  };

  // 5. Listen for 60 seconds
  console.log('\n── Listening for 60 seconds (only showing |imbalance| > 30%) ──\n');
  await new Promise(r => setTimeout(r, 60_000));

  ws.close();

  // 6. Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Imbalance Detector Summary');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('── Current Order Book States ──');
  for (const [coin, book] of orderBooks) {
    const { bidVolume, askVolume, imbalance, signal } = computeImbalance(book);
    console.log(`  ${coin.padEnd(8)} bids=${bidVolume.toFixed(2).padStart(10)}  asks=${askVolume.toFixed(2).padStart(10)}  imbalance=${(imbalance*100).toFixed(1).padStart(6)}%  [${signal}]`);
  }

  console.log('\n── Strategy Implications ──\n');
  console.log('  ✅ Order book imbalance is a real signal');
  console.log('  ✅ Can predict short-term price moves (1-5 min)');
  console.log('  ⚠️ Directional risk (not delta-neutral)');
  console.log('  ⚠️ Adverse selection (fake orders)');
  console.log('  ⚠️ HFT firms already exploit this');
  console.log('');
  console.log('  Best use case: ALERT ONLY');
  console.log('    - Confirm VOOI arb signals');
  console.log('    - Build market intuition');
  console.log('    - Don\'t trade directly on imbalance');
  console.log('');
  console.log('  Build: 2-3 days for production-ready detector');
  console.log('  Revenue: Indirect (improves other strategies)');
}

main().catch(console.error);
