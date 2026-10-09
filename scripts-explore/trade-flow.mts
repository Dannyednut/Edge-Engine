// Trade Flow Analysis Tool
// Monitor trade flow for all top HL perps
// Detect momentum / reversal patterns
// Alert on unusual volume spikes

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

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Trade Flow Analysis (60s WebSocket)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get top 5 perps by volume
  console.log('── Loading top perps ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  const topPerps: { coin: string; vol: number }[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 100_000_000) topPerps.push({ coin: name, vol });
  }
  topPerps.sort((a, b) => b.vol - a.vol);
  const watchPerps = topPerps.slice(0, 5).map(p => p.coin);
  console.log(`  Top 5: ${watchPerps.join(', ')}\n`);

  // 2. Connect to WebSocket
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected to HL WebSocket\n');

  // 3. Subscribe to trades
  for (const coin of watchPerps) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  }
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  console.log(`✅ Subscribed to trades for ${watchPerps.length} perps\n`);

  // 4. Track trade flow
  const tradeFlow = new Map<string, { buys: number; sells: number; buyVol: number; sellVol: number; totalVol: number; trades: any[] }>();
  for (const coin of watchPerps) {
    tradeFlow.set(coin, { buys: 0, sells: 0, buyVol: 0, sellVol: 0, totalVol: 0, trades: [] });
  }

  let totalTrades = 0;

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
          const flow = tradeFlow.get(t.coin);
          if (!flow) continue;
          const px = parseFloat(t.px);
          const sz = parseFloat(t.sz);
          const notional = sz * px;
          if (t.side === 'B') {
            flow.buys++;
            flow.buyVol += notional;
          } else {
            flow.sells++;
            flow.sellVol += notional;
          }
          flow.totalVol += notional;
          flow.trades.push({ ts: t.time, side: t.side, px, sz, notional });
          if (flow.trades.length > 1000) flow.trades.shift();
        }
      }
    } catch {}
  };

  // 5. Listen for 60 seconds
  console.log('── Listening for 60 seconds ──\n');
  await new Promise(r => setTimeout(r, 60_000));
  ws.close();

  // 6. Analysis
  console.log('═══════════════════════════════════════════════════');
  console.log('  Trade Flow Analysis (60s)');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total trades: ${totalTrades}\n`);

  console.log('── Per-Pump Trade Flow ──');
  console.log('Coin      | Buys  | Sells | Buy Vol      | Sell Vol     | Total Vol    | Buy/Sell Ratio | Signal');
  console.log('──────────|───────|───────|──────────────|──────────────|──────────────|────────────────|──────────');
  for (const [coin, flow] of tradeFlow) {
    const ratio = flow.sells > 0 ? flow.buyVol / flow.sellVol : Infinity;
    const signal = ratio > 1.5 ? 'BULLISH' : ratio < 0.67 ? 'BEARISH' : 'NEUTRAL';
    console.log(`${coin.padEnd(10)}| ${flow.buys.toString().padStart(5)} | ${flow.sells.toString().padStart(5)} | $${(flow.buyVol/1000).toFixed(0).padStart(11)}k | $${(flow.sellVol/1000).toFixed(0).padStart(11)}k | $${(flow.totalVol/1000).toFixed(0).padStart(11)}k | ${ratio.toFixed(2).padStart(14)} | ${signal}`);
  }

  // 7. Volume spike detection
  console.log('\n── Volume Spike Detection ──\n');
  for (const [coin, flow] of tradeFlow) {
    if (flow.trades.length < 10) continue;
    // Compute average trade size
    const avgSize = flow.totalVol / flow.trades.length;
    // Find largest trade
    const largest = flow.trades.reduce((max, t) => t.notional > max.notional ? t : max, flow.trades[0]);
    const spikeRatio = largest.notional / avgSize;
    if (spikeRatio > 5) {
      console.log(`  ${coin}: Largest trade $${largest.notional.toFixed(0)} (${spikeRatio.toFixed(1)}x avg) ${largest.side === 'B' ? 'BUY' : 'SELL'}`);
    }
  }

  // 8. Strategy implications
  console.log('\n── Strategy Implications ──\n');
  console.log('  Trade flow analysis enables:');
  console.log('  1. MOMENTUM SIGNALS');
  console.log('     - Buy/sell ratio > 1.5 = bullish momentum');
  console.log('     - Buy/sell ratio < 0.67 = bearish momentum');
  console.log('     - Use as confirmation for other signals');
  console.log('');
  console.log('  2. VOLUME SPIKE DETECTION');
  console.log('     - Large trades (> 5x avg) = institutional activity');
  console.log('     - Often precedes price moves');
  console.log('     - Alert on spikes');
  console.log('');
  console.log('  3. WHALE TRACKING');
  console.log('     - Identify large traders via userFillsByTime');
  console.log('     - Track their patterns');
  console.log('     - Front-run or follow (risky)');
  console.log('');
  console.log('  4. LIQUIDITY DETECTION');
  console.log('     - High volume = good liquidity');
  console.log('     - Low volume = wider spreads');
  console.log('     - Use for execution timing');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Trade flow analysis is USEFUL for signal confirmation.');
  console.log('  ✅ Real-time data via WebSocket');
  console.log('  ✅ Identifies momentum + spikes');
  console.log('  ⚠️ Directional (not delta-neutral)');
  console.log('  ⚠️ Best as confirmation, not standalone');
  console.log('');
  console.log('ACTION: Add as confirmation signal for VOOI + funding arbs');
}

main().catch(console.error);
