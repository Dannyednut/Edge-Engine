async function main() {
  console.log('── CEX Price Comparison (Binance + Bybit vs HL) ──\n');
  
  // Get HL prices
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  const hlPrices: Record<string, number> = {};
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    const name = hlData[0].universe[i].name;
    const px = parseFloat(hlData[1]?.[i]?.markPx || '0');
    if (px > 0) hlPrices[name] = px;
  }

  // Get Binance prices
  const binRes = await fetch('https://api.binance.com/api/v3/ticker/price');
  const binData = binRes.ok ? await binRes.json() : [];
  const binPrices: Record<string, number> = {};
  for (const t of binData) {
    const sym = t.symbol.replace('USDT', '');
    if (hlPrices[sym]) binPrices[sym] = parseFloat(t.price);
  }

  // Get Bybit prices
  const bybRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybData = bybRes.ok ? await bybRes.json() : { result: { list: [] } };
  const bybPrices: Record<string, number> = {};
  for (const t of (bybData?.result?.list || [])) {
    const sym = t.symbol.replace('USDT', '');
    if (hlPrices[sym]) bybPrices[sym] = parseFloat(t.lastPrice);
  }

  // Compare
  console.log('Symbol     | HL $       | Binance $  | Bybit $    | HL-Binance% | HL-Bybit%');
  console.log('───────────|────────────|────────────|────────────|─────────────|──────────');
  const arbs: any[] = [];
  for (const [sym, hlPx] of Object.entries(hlPrices)) {
    const binPx = binPrices[sym];
    const bybPx = bybPrices[sym];
    if (!binPx && !bybPx) continue;
    const binSpread = binPx ? ((hlPx - binPx) / binPx * 100) : 0;
    const bybSpread = bybPx ? ((hlPx - bybPx) / bybPx * 100) : 0;
    if (Math.abs(binSpread) > 0.1 || Math.abs(bybSpread) > 0.1) {
      arbs.push({ sym, hlPx, binPx, bybPx, binSpread, bybSpread });
    }
  }
  arbs.sort((a, b) => Math.max(Math.abs(b.binSpread), Math.abs(b.bybSpread)) - Math.max(Math.abs(a.binSpread), Math.abs(a.bybSpread)));
  for (const a of arbs.slice(0, 20)) {
    console.log(`${a.sym.padEnd(10)}| $${a.hlPx.toFixed(4).padStart(10)}| ${a.binPx ? '$' + a.binPx.toFixed(4).padStart(10) : 'N/A'.padStart(11)}| ${a.bybPx ? '$' + a.bybPx.toFixed(4).padStart(10) : 'N/A'.padStart(11)}| ${a.binSpread.toFixed(3).padStart(11)}%| ${a.bybSpread.toFixed(3).padStart(8)}%`);
  }
  console.log(`\n  Found ${arbs.length} price discrepancies > 0.1%`);
}
main().catch(console.error);
