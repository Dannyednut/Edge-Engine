const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Trade Monitor (2 min) ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const topPerps: string[] = [];
  for (let i = 0; i < universe.length; i++) {
    const vol = parseFloat(meta?.[1]?.[i]?.dayNtlVlm || '0');
    if (vol > 100_000_000) topPerps.push(universe[i].name);
  }
  topPerps.sort();
  console.log(`Monitoring: ${topPerps.join(', ')}\n`);
  
  const tradeStats: Record<string, { buys: number; sells: number; buyVol: number; sellVol: number }> = {};
  for (const coin of topPerps) tradeStats[coin] = { buys: 0, sells: 0, buyVol: 0, sellVol: 0 };
  
  let totalEvents = 0;
  
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  
  for (const coin of topPerps) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  }
  console.log(`✅ Subscribed to trades for ${topPerps.length} perps\n`);
  
  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);
      
      const msg = JSON.parse(dataStr);
      if (msg.channel === 'trades') {
        totalEvents++;
        for (const t of (msg.data || [])) {
          if (tradeStats[t.coin]) {
            const notional = parseFloat(t.px) * parseFloat(t.sz);
            if (t.side === 'B') { tradeStats[t.coin].buys++; tradeStats[t.coin].buyVol += notional; }
            else { tradeStats[t.coin].sells++; tradeStats[t.coin].sellVol += notional; }
          }
        }
      }
    } catch {}
  };
  
  console.log('Listening for 2 minutes...\n');
  await new Promise(r => setTimeout(r, 120_000));
  ws.close();
  
  console.log('── 2-Minute Trade Summary ──\n');
  console.log(`Total trade events: ${totalEvents}\n`);
  console.log('Coin     | Buys  | Sells | Buy Vol $   | Sell Vol $  | B/S Ratio | Sentiment');
  console.log('─────────|───────|───────|─────────────|─────────────|───────────|───────────');
  for (const [coin, stats] of Object.entries(tradeStats)) {
    const total = stats.buys + stats.sells;
    if (total === 0) continue;
    const ratio = stats.sells > 0 ? stats.buyVol / stats.sellVol : Infinity;
    const sentiment = ratio > 1.5 ? '🟢 BULLISH' : ratio < 0.67 ? '🔴 BEARISH' : '⚪ NEUTRAL';
    console.log(`${coin.padEnd(9)}| ${stats.buys.toString().padStart(5)} | ${stats.sells.toString().padStart(5)} | $${(stats.buyVol/1000).toFixed(1).padStart(10)}k | $${(stats.sellVol/1000).toFixed(1).padStart(10)}k | ${ratio.toFixed(2).padStart(9)} | ${sentiment}`);
  }
}
main().catch(console.error);
