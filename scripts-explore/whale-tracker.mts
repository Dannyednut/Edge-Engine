// Whale Activity Tracker
// Identify whale wallets on HL via large fills
// Track their patterns
// Alert on big moves
//
// Approach:
//   1. Query userFills for known whale addresses (need to discover)
//   2. Or: Monitor trades channel for large fills, identify whales
//   3. Track whale positions over time
//   4. Alert when whales make big moves

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const HL_API = 'https://api.hyperliquid.xyz/info';
const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const WHALE_DB = '/home/z/my-project/download/whale-tracker.json';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function loadWhaleDb(): { whales: Record<string, { firstSeen: number; totalVol: number; trades: number; lastSeen: number }> } {
  if (existsSync(WHALE_DB)) {
    return JSON.parse(readFileSync(WHALE_DB, 'utf8'));
  }
  return { whales: {} };
}

function saveWhaleDb(db: any) {
  writeFileSync(WHALE_DB, JSON.stringify(db, null, 2));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Whale Activity Tracker (60s)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get top 5 perps
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  const topPerps: string[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 100_000_000) topPerps.push(name);
  }
  topPerps.sort();
  console.log(`  Top perps: ${topPerps.slice(0, 5).join(', ')}\n`);

  // 2. Connect to WebSocket
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected to HL WebSocket\n');

  // 3. Subscribe to trades for top 5 perps
  const watchPerps = topPerps.slice(0, 5);
  for (const coin of watchPerps) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  }
  console.log(`✅ Subscribed to trades for ${watchPerps.length} perps\n`);

  // 4. Track large trades (potential whale activity)
  let db = loadWhaleDb();
  const largeTrades: any[] = [];
  let totalTrades = 0;

  // Note: HL WebSocket trades channel doesn't include user address
  // We can only identify whales by trade size (not by address)
  // For address-based tracking, need to use userFillsByTime on specific addresses

  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);

      const msg = JSON.parse(dataStr);
      if (msg.channel === 'trades') {
        const trades = msg.data || [];
        for (const t of trades) {
          totalTrades++;
          const px = parseFloat(t.px);
          const sz = parseFloat(t.sz);
          const notional = sz * px;
          // Define whale threshold: $50k+ per trade
          if (notional > 50_000) {
            largeTrades.push({
              ts: t.time,
              coin: t.coin,
              side: t.side,
              px,
              sz,
              notional,
              hash: t.hash,
            });
          }
        }
      }
    } catch {}
  };

  // 5. Listen for 60 seconds
  console.log('── Listening for 60 seconds (whale threshold: $50k+) ──\n');
  await new Promise(r => setTimeout(r, 60_000));
  ws.close();

  // 6. Analysis
  console.log('═══════════════════════════════════════════════════');
  console.log('  Whale Activity Summary');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total trades: ${totalTrades}`);
  console.log(`Whale trades (>$50k): ${largeTrades.length}`);
  console.log(`Whale trade rate: ${(largeTrades.length / 60).toFixed(2)} per minute\n`);

  // Group by coin
  const byCoin: Record<string, { count: number; totalVol: number; buys: number; sells: number }> = {};
  for (const t of largeTrades) {
    if (!byCoin[t.coin]) byCoin[t.coin] = { count: 0, totalVol: 0, buys: 0, sells: 0 };
    byCoin[t.coin].count++;
    byCoin[t.coin].totalVol += t.notional;
    if (t.side === 'B') byCoin[t.coin].buys++;
    else byCoin[t.coin].sells++;
  }

  console.log('── Whale Activity by Coin ──');
  console.log('Coin      | Whale Trades | Total Vol    | Buys | Sells | Bias');
  console.log('──────────|──────────────|──────────────|──────|───────|──────');
  for (const [coin, data] of Object.entries(byCoin)) {
    const bias = data.buys > data.sells * 1.5 ? 'BULLISH' : data.sells > data.buys * 1.5 ? 'BEARISH' : 'NEUTRAL';
    console.log(`${coin.padEnd(10)}| ${data.count.toString().padStart(12)} | $${(data.totalVol/1000).toFixed(0).padStart(11)}k | ${data.buys.toString().padStart(4)} | ${data.sells.toString().padStart(5)} | ${bias}`);
  }

  // Show largest whale trades
  console.log('\n── Top 10 Largest Whale Trades ──');
  largeTrades.sort((a, b) => b.notional - a.notional);
  for (const t of largeTrades.slice(0, 10)) {
    console.log(`  ${new Date(t.ts).toISOString().substring(11, 19)} ${t.coin.padEnd(8)} ${t.side === 'B' ? 'BUY ' : 'SELL'} $${t.notional.toFixed(0).padStart(10)}  sz=${t.sz.toFixed(4)}  px=$${t.px.toFixed(2)}`);
  }

  // 7. Strategy implications
  console.log('\n── Strategy Implications ──\n');
  console.log('  Whale tracking enables:');
  console.log('  1. MARKET INTELLIGENCE');
  console.log('     - Large trades = institutional activity');
  console.log('     - Track bias (buy-heavy vs sell-heavy)');
  console.log('     - Confirm other signals');
  console.log('');
  console.log('  2. FRONT-RUNNING (RISKY)');
  console.log('     - Detect large orders before they fill');
  console.log('     - Trade in same direction');
  console.log('     - Risk: adverse selection, MEV');
  console.log('');
  console.log('  3. CONTRARIAN SIGNALS');
  console.log('     - Large trades often mark tops/bottoms');
  console.log('     - Counter-trade whales at extremes');
  console.log('     - Risk: timing is difficult');
  console.log('');
  console.log('  4. LIQUIDITY DETECTION');
  console.log('     - Whale presence = good liquidity');
  console.log('     - Absence = thin market');
  console.log('     - Use for execution timing');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Whale tracking is USEFUL for market intelligence.');
  console.log('  ✅ Real-time detection via WebSocket');
  console.log('  ✅ Identifies institutional activity');
  console.log('  ⚠️ No address tracking (HL WebSocket doesn\'t expose addresses)');
  console.log('  ⚠️ Best as confirmation signal');
  console.log('');
  console.log('ACTION: Add as market intelligence feed');
  console.log('  Alert when whale bias conflicts with our strategy direction');
}

main().catch(console.error);
