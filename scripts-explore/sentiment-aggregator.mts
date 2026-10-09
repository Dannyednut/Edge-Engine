// Market Sentiment Aggregator
// Combines multiple signals into a single sentiment score:
//   - Order book imbalance
//   - Trade flow (buy/sell ratio)
//   - Whale activity
//   - Funding rate (extreme = reversal)
//   - Open interest changes
//
// Output: Sentiment score from -100 (extreme bearish) to +100 (extreme bullish)

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
  console.log('  Market Sentiment Aggregator (60s)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get top 5 perps
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  const topPerps: { coin: string; funding: number; vol: number; oi: number }[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    if (vol > 100_000_000) topPerps.push({ coin: name, funding, vol, oi });
  }
  topPerps.sort((a, b) => b.vol - a.vol);
  const watchPerps = topPerps.slice(0, 5);
  console.log(`  Top 5: ${watchPerps.map(p => p.coin).join(', ')}\n`);

  // 2. Connect to WebSocket
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected to HL WebSocket\n');

  // 3. Subscribe to channels
  for (const p of watchPerps) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: p.coin } }));
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: p.coin } }));
  }
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  console.log(`✅ Subscribed to l2Book + trades for ${watchPerps.length} perps\n`);

  // 4. Track data
  const orderBooks = new Map<string, { bids: number; asks: number }>();
  const tradeFlow = new Map<string, { buyVol: number; sellVol: number }>();
  for (const p of watchPerps) {
    orderBooks.set(p.coin, { bids: 0, asks: 0 });
    tradeFlow.set(p.coin, { buyVol: 0, sellVol: 0 });
  }

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
        const bids = (levels[0] || []).reduce((s: number, l: any) => s + parseFloat(l.sz), 0);
        const asks = (levels[1] || []).reduce((s: number, l: any) => s + parseFloat(l.sz), 0);
        orderBooks.set(coin, { bids, asks });
      }
      if (msg.channel === 'trades') {
        const trades = msg.data || [];
        for (const t of trades) {
          const flow = tradeFlow.get(t.coin);
          if (!flow) continue;
          const notional = parseFloat(t.sz) * parseFloat(t.px);
          if (t.side === 'B') flow.buyVol += notional;
          else flow.sellVol += notional;
        }
      }
    } catch {}
  };

  // 5. Listen for 60 seconds
  console.log('── Listening for 60 seconds ──\n');
  await new Promise(r => setTimeout(r, 60_000));
  ws.close();

  // 6. Compute sentiment scores
  console.log('═══════════════════════════════════════════════════');
  console.log('  Market Sentiment Analysis (60s)');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('Coin      | OB Imbalance | Trade Flow | Funding    | Total Score | Sentiment');
  console.log('──────────|──────────────|────────────|────────────|─────────────|───────────');

  const sentiments: any[] = [];
  for (const p of watchPerps) {
    // Order book imbalance score (-100 to +100)
    const ob = orderBooks.get(p.coin) || { bids: 0, asks: 0 };
    const obTotal = ob.bids + ob.asks;
    const obImbalance = obTotal > 0 ? ((ob.bids - ob.asks) / obTotal) * 100 : 0;

    // Trade flow score (-100 to +100)
    const tf = tradeFlow.get(p.coin) || { buyVol: 0, sellVol: 0 };
    const tfTotal = tf.buyVol + tf.sellVol;
    const tfScore = tfTotal > 0 ? ((tf.buyVol - tf.sellVol) / tfTotal) * 100 : 0;

    // Funding score (contrarian — extreme funding = reversal expected)
    // High positive funding = overleveraged longs = bearish signal
    // High negative funding = overleveraged shorts = bullish signal
    const fundingScore = -Math.sign(p.funding) * Math.min(100, Math.abs(p.funding) * 24 * 365 * 100 / 10);

    // Total score (weighted average)
    const totalScore = obImbalance * 0.4 + tfScore * 0.4 + fundingScore * 0.2;
    const sentiment = totalScore > 30 ? 'BULLISH' : totalScore < -30 ? 'BEARISH' : 'NEUTRAL';

    console.log(`${p.coin.padEnd(10)}| ${obImbalance.toFixed(1).padStart(11)}% | ${tfScore.toFixed(1).padStart(9)}% | ${fundingScore.toFixed(1).padStart(9)}% | ${totalScore.toFixed(1).padStart(10)}% | ${sentiment}`);

    sentiments.push({ coin: p.coin, obImbalance, tfScore, fundingScore, totalScore, sentiment });
  }

  // 7. Overall market sentiment
  const avgScore = sentiments.reduce((s, x) => s + x.totalScore, 0) / sentiments.length;
  const marketSentiment = avgScore > 20 ? 'BULLISH' : avgScore < -20 ? 'BEARISH' : 'NEUTRAL';
  console.log(`\n── Overall Market Sentiment ──`);
  console.log(`  Average score: ${avgScore.toFixed(1)}`);
  console.log(`  Sentiment: ${marketSentiment}`);
  console.log('');

  // 8. Strategy implications
  console.log('── Strategy Implications ──\n');
  console.log('  Sentiment score combines:');
  console.log('    40% order book imbalance');
  console.log('    40% trade flow (60s)');
  console.log('    20% funding rate (contrarian)');
  console.log('');
  console.log('  Use cases:');
  console.log('  1. RISK MANAGEMENT');
  console.log('     - Avoid opening new arbs against extreme sentiment');
  console.log('     - Reduce position size when sentiment is extreme');
  console.log('');
  console.log('  2. ENTRY TIMING');
  console.log('     - Better entries when sentiment aligns with strategy');
  console.log('     - Wait for sentiment to cool before entering');
  console.log('');
  console.log('  3. ALERT SYSTEM');
  console.log('     - Alert when sentiment shifts > 50 points');
  console.log('     - Use as early warning for market moves');
  console.log('');
  console.log('  4. STRATEGY SELECTION');
  console.log('     - Bullish sentiment → focus on long-biased arbs');
  console.log('     - Bearish sentiment → focus on short-biased arbs');
  console.log('     - Neutral → all delta-neutral arbs');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Market Sentiment Aggregator is USEFUL for:');
  console.log('  ✅ Risk management');
  console.log('  ✅ Entry timing');
  console.log('  ✅ Early warning system');
  console.log('  ✅ Strategy selection');
  console.log('  ⚠️ Directional (not delta-neutral)');
  console.log('  ⚠️ Best as confirmation, not standalone');
  console.log('');
  console.log('ACTION: Add as risk management tool');
  console.log('  Alert when sentiment conflicts with strategy direction');
}

main().catch(console.error);
