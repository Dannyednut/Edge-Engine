const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Order Flow Imbalance (3 min) ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const top: string[] = [];
  for (let i = 0; i < universe.length; i++) {
    if (parseFloat(meta?.[1]?.[i]?.dayNtlVlm || '0') > 100_000_000) top.push(universe[i].name);
  }
  top.sort();
  
  const stats: Record<string, { buys: number; sells: number; buyVol: number; sellVol: number; bigBuys: number; bigSells: number }> = {};
  for (const c of top) stats[c] = { buys: 0, sells: 0, buyVol: 0, sellVol: 0, bigBuys: 0, bigSells: 0 };
  
  let events = 0;
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('WS')); });
  for (const c of top) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: c } }));
  
  ws.onmessage = async (ev) => {
    try {
      let s: string;
      if (typeof ev.data === 'string') s = ev.data;
      else if (ev.data instanceof ArrayBuffer) s = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) s = await ev.data.text();
      else s = String(ev.data);
      const msg = JSON.parse(s);
      if (msg.channel === 'trades') {
        events++;
        for (const t of (msg.data || [])) {
          if (stats[t.coin]) {
            const n = parseFloat(t.px) * parseFloat(t.sz);
            if (t.side === 'B') { stats[t.coin].buys++; stats[t.coin].buyVol += n; if (n > 50000) stats[t.coin].bigBuys++; }
            else { stats[t.coin].sells++; stats[t.coin].sellVol += n; if (n > 50000) stats[t.coin].bigSells++; }
          }
        }
      }
    } catch {}
  };
  
  await new Promise(r => setTimeout(r, 180_000));
  ws.close();
  
  console.log(`Events: ${events}\n`);
  console.log('Coin     | Buys  | Sells | Buy Vol $   | Sell Vol $  | Big Buys | Big Sells | Flow');
  console.log('─────────|───────|───────|─────────────|─────────────|──────────|────────────|──────');
  for (const [coin, s] of Object.entries(stats)) {
    const total = s.buys + s.sells;
    if (total === 0) continue;
    const ratio = s.sells > 0 ? s.buyVol / s.sellVol : 99;
    const flow = ratio > 2 ? '🟢 STRONG BUY' : ratio > 1.3 ? '🟢 BUY' : ratio < 0.5 ? '🔴 STRONG SELL' : ratio < 0.77 ? '🔴 SELL' : '⚪ NEUTRAL';
    console.log(`${coin.padEnd(9)}| ${s.buys.toString().padStart(5)} | ${s.sells.toString().padStart(5)} | $${(s.buyVol/1000).toFixed(1).padStart(10)}k | $${(s.sellVol/1000).toFixed(1).padStart(10)}k | ${s.bigBuys.toString().padStart(8)} | ${s.bigSells.toString().padStart(10)}| ${flow}`);
  }
}
main().catch(console.error);
