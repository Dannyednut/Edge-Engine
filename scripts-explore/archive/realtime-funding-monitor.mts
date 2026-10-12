const HL_WS = 'wss://api.hyperliquid.xyz/ws';
const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── Real-time Funding Monitor (5 min via WebSocket) ──\n');
  
  // Get initial funding rates
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const initialFunding: Record<string, number> = {};
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const f = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (f > 0.002 && vol > 5_000_000) {
      initialFunding[name] = f;
    }
  }
  
  console.log('Initial high-funding perps:');
  for (const [name, f] of Object.entries(initialFunding).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${name.padEnd(10)} ${(f*100).toFixed(4)}%/h = ${(f*24*365*100).toFixed(0)}% APR`);
  }
  
  // Connect to WebSocket for allMids (price updates)
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  console.log('\n✅ Subscribed to allMids — monitoring price movements');
  console.log('Listening for 5 minutes...\n');
  
  let updateCount = 0;
  const priceChanges: Record<string, { initial: number; current: number }> = {};
  
  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);
      
      const msg = JSON.parse(dataStr);
      if (msg.channel === 'allMids') {
        updateCount++;
        const mids = msg.data.mids || {};
        for (const [coin, px] of Object.entries(mids)) {
          if (initialFunding[coin]) {
            const price = parseFloat(px as string);
            if (!priceChanges[coin]) priceChanges[coin] = { initial: price, current: price };
            else priceChanges[coin].current = price;
          }
        }
      }
    } catch {}
  };
  
  await new Promise(r => setTimeout(r, 300_000)); // 5 minutes
  ws.close();
  
  // Analysis
  console.log('── 5-Minute Price Movement Analysis ──\n');
  console.log('Coin     | Initial $  | Current $  | Change %  | Funding 1h   | Correlation');
  console.log('─────────|────────────|────────────|───────────|──────────────|────────────');
  
  for (const [coin, changes] of Object.entries(priceChanges)) {
    if (!initialFunding[coin]) continue;
    const change = ((changes.current - changes.initial) / changes.initial * 100);
    const funding = initialFunding[coin] * 100;
    // If price goes UP and funding is positive → funding likely to INCREASE (more longs)
    // If price goes DOWN and funding is positive → funding likely to DECREASE (longs exit)
    let correlation = '';
    if (change > 0.1 && funding > 0.003) correlation = '↗️ Funding may increase';
    else if (change < -0.1 && funding > 0.003) correlation = '↘️ Funding may decrease';
    else correlation = '→ Stable';
    
    console.log(`${coin.padEnd(9)}| $${changes.initial.toFixed(4).padStart(10)}| $${changes.current.toFixed(4).padStart(10)}| ${change.toFixed(3).padStart(9)}%| ${funding.toFixed(4).padStart(12)}%| ${correlation}`);
  }
  
  console.log(`\n  Total allMids updates: ${updateCount}`);
  console.log('  Use price movements to predict funding changes');
  console.log('  If funding predicted to increase → enter short position NOW');
}
main().catch(console.error);
