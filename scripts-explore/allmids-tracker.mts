const HL_WS = 'wss://api.hyperliquid.xyz/ws';
async function main() {
  console.log('── HL AllMids Price Tracker (2 min) ──\n');
  
  let updateCount = 0;
  const initialPrices: Record<string, number> = {};
  const latestPrices: Record<string, number> = {};
  
  const ws = new WebSocket(HL_WS);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  
  ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
  console.log('✅ Subscribed to allMids\n');
  
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
          const price = parseFloat(px as string);
          if (!initialPrices[coin]) initialPrices[coin] = price;
          latestPrices[coin] = price;
        }
      }
    } catch {}
  };
  
  console.log('Listening for 2 minutes...\n');
  await new Promise(r => setTimeout(r, 120_000));
  ws.close();
  
  // Analysis
  console.log(`Total allMids updates: ${updateCount}\n`);
  
  // Top movers
  const movers: { coin: string; change: number; initial: number; current: number }[] = [];
  for (const [coin, current] of Object.entries(latestPrices)) {
    const initial = initialPrices[coin];
    if (initial > 0) {
      const change = (current - initial) / initial * 100;
      movers.push({ coin, change, initial, current });
    }
  }
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  
  console.log('Top 10 price movers (2 min):');
  console.log('Coin     | Initial $  | Current $  | Change %');
  console.log('─────────|────────────|────────────|─────────');
  for (const m of movers.slice(0, 10)) {
    const emoji = m.change > 0 ? '🟢' : m.change < 0 ? '🔴' : '⚪';
    console.log(`${m.coin.padEnd(9)}| $${m.initial.toFixed(4).padStart(10)}| $${m.current.toFixed(4).padStart(10)}| ${emoji}${m.change.toFixed(3)}%`);
  }
}
main().catch(console.error);
