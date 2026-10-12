/**
 * DEEP DIVE: HL WebSocket — 5 min real-time data collection
 * Collect and analyze:
 * - allMids (all prices)
 * - trades (top 5 perps)
 * - l2Book (order book for top 3)
 */
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

async function main() {
  console.log('── DEEP DIVE: HL WebSocket 5-min Analysis ──\n');

  // Get top perps
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  const topPerps: string[] = [];
  for (let i = 0; i < universe.length; i++) {
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 100_000_000) topPerps.push(universe[i].name);
  }
  topPerps.sort();
  console.log(`Top perps: ${topPerps.slice(0, 5).join(', ')}\n`);

  let eventCount = 0;
  const tradeData: Record<string, { buys: number; sells: number; buyVol: number; sellVol: number; prices: number[] }> = {};
  const midPrices: Record<string, number[]> = {};
  const bookUpdates: Record<string, number> = {};

  for (const coin of topPerps.slice(0, 5)) {
    tradeData[coin] = { buys: 0, sells: 0, buyVol: 0, sellVol: 0, prices: [] };
    midPrices[coin] = [];
    bookUpdates[coin] = 0;
  }

  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected\n');

  // Subscribe
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  for (const coin of topPerps.slice(0, 5)) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
  }
  console.log('✅ Subscribed to allMids + trades + l2Book for top 5 perps\n');

  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);

      const msg = JSON.parse(dataStr);
      eventCount++;

      if (msg.channel === 'allMids') {
        const mids = msg.data.mids || {};
        for (const [coin, px] of Object.entries(mids)) {
          if (midPrices[coin]) {
            midPrices[coin].push(parseFloat(px as string));
          }
        }
      }

      if (msg.channel === 'trades') {
        for (const t of (msg.data || [])) {
          if (tradeData[t.coin]) {
            const px = parseFloat(t.px);
            const sz = parseFloat(t.sz);
            const notional = px * sz;
            if (t.side === 'B') {
              tradeData[t.coin].buys++;
              tradeData[t.coin].buyVol += notional;
            } else {
              tradeData[t.coin].sells++;
              tradeData[t.coin].sellVol += notional;
            }
            tradeData[t.coin].prices.push(px);
          }
        }
      }

      if (msg.channel === 'l2Book') {
        if (bookUpdates[msg.data.coin] !== undefined) {
          bookUpdates[msg.data.coin]++;
        }
      }
    } catch {}
  };

  console.log('── Collecting data for 5 minutes ──\n');
  await new Promise(r => setTimeout(r, 300_000)); // 5 minutes
  ws.close();

  // Analysis
  console.log('═══════════════════════════════════════════════════');
  console.log('  5-Minute WebSocket Analysis');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total events: ${eventCount}\n`);

  console.log('── Trade Flow (5 min) ──\n');
  console.log('Coin      | Buys  | Sells | Buy Vol      | Sell Vol     | Buy/Sell Ratio | Avg Price');
  console.log('──────────|───────|───────|──────────────|──────────────|────────────────|───────────');
  for (const [coin, data] of Object.entries(tradeData)) {
    const total = data.buys + data.sells;
    if (total === 0) continue;
    const ratio = data.sells > 0 ? data.buyVol / data.sellVol : Infinity;
    const avgPx = data.prices.length > 0 ? data.prices.reduce((s, p) => s + p, 0) / data.prices.length : 0;
    console.log(`${coin.padEnd(10)}| ${data.buys.toString().padStart(5)} | ${data.sells.toString().padStart(5)} | $${(data.buyVol/1000).toFixed(1).padStart(10)}k | $${(data.sellVol/1000).toFixed(1).padStart(10)}k | ${ratio.toFixed(2).padStart(14)} | $${avgPx.toFixed(2)}`);
  }

  console.log('\n── Price Volatility (5 min) ──\n');
  for (const [coin, prices] of Object.entries(midPrices)) {
    if (prices.length < 2) continue;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    const range = ((max - min) / avg) * 100;
    console.log(`  ${coin.padEnd(10)} min=$${min.toFixed(2)} max=$${max.toFixed(2)} avg=$${avg.toFixed(2)} range=${range.toFixed(3)}% (${prices.length} updates)`);
  }

  console.log('\n── Order Book Updates ──\n');
  for (const [coin, count] of Object.entries(bookUpdates)) {
    console.log(`  ${coin.padEnd(10)} ${count} updates in 5 min (${(count / 5).toFixed(0)}/min)`);
  }

  console.log('\n── Analysis ──\n');
  console.log('  Trade flow imbalance = directional signal');
  console.log('  Price range = volatility (higher = more arb opportunities)');
  console.log('  Book update frequency = liquidity (more = better execution)');
  console.log('');
  console.log('  Use this data to:');
  console.log('    1. Identify most active perps for trading');
  console.log('    2. Time entries during high volatility');
  console.log('    3. Avoid illiquid markets');
}
main().catch(console.error);
