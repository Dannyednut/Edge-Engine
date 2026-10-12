async function main() {
  console.log('── CEX-HL Price Arb (Filtered — High Volume Only) ──\n');
  
  // Get HL prices
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  const hlPrices: Record<string, { px: number; vol: number }> = {};
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    const name = hlData[0].universe[i].name;
    const px = parseFloat(hlData[1]?.[i]?.markPx || '0');
    const vol = parseFloat(hlData[1]?.[i]?.dayNtlVlm || '0');
    if (px > 0 && vol > 1_000_000) hlPrices[name] = { px, vol }; // Only high-volume perps
  }

  // Get Binance
  const binRes = await fetch('https://api.binance.com/api/v3/ticker/price');
  const binData = binRes.ok ? await binRes.json() : [];
  const binPrices: Record<string, number> = {};
  for (const t of binData) {
    const sym = t.symbol.replace('USDT', '');
    if (hlPrices[sym]) binPrices[sym] = parseFloat(t.price);
  }

  // Get Bybit
  const bybRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybData = bybRes.ok ? await bybRes.json() : { result: { list: [] } };
  const bybPrices: Record<string, number> = {};
  for (const t of (bybData?.result?.list || [])) {
    const sym = t.symbol.replace('USDT', '');
    if (hlPrices[sym]) bybPrices[sym] = parseFloat(t.lastPrice);
  }

  // Compare — only high volume perps
  const arbs: any[] = [];
  for (const [sym, hl] of Object.entries(hlPrices)) {
    const binPx = binPrices[sym];
    const bybPx = bybPrices[sym];
    if (!binPx && !bybPx) continue;
    const binSpread = binPx ? ((hl.px - binPx) / binPx * 100) : 0;
    const bybSpread = bybPx ? ((hl.px - bybPx) / bybPx * 100) : 0;
    // Only show spreads between 0.05% and 5% (filter out ticker collisions)
    if ((Math.abs(binSpread) > 0.05 && Math.abs(binSpread) < 5) || 
        (Math.abs(bybSpread) > 0.05 && Math.abs(bybSpread) < 5)) {
      arbs.push({ sym, hlPx: hl.px, binPx, bybPx, binSpread, bybSpread, vol: hl.vol });
    }
  }
  arbs.sort((a, b) => Math.max(Math.abs(b.binSpread), Math.abs(b.bybSpread)) - Math.max(Math.abs(a.binSpread), Math.abs(a.bybSpread)));

  console.log(`Found ${arbs.length} realistic price arbs (0.05%-5% spread, high volume)\n`);
  console.log('Symbol     | HL $       | Binance $  | Bybit $    | HL-Binance% | HL-Bybit%  | Vol $M');
  console.log('───────────|────────────|────────────|────────────|─────────────|────────────|───────');
  for (const a of arbs.slice(0, 20)) {
    console.log(`${a.sym.padEnd(10)}| $${a.hlPx.toFixed(4).padStart(10)}| ${a.binPx ? '$' + a.binPx.toFixed(4).padStart(10) : 'N/A'.padStart(11)}| ${a.bybPx ? '$' + a.bybPx.toFixed(4).padStart(10) : 'N/A'.padStart(11)}| ${a.binSpread.toFixed(3).padStart(11)}%| ${a.bybSpread.toFixed(3).padStart(8)}%| ${(a.vol/1e6).toFixed(1)}`);
  }

  console.log('\n── Arbitrage Opportunities ──\n');
  for (const a of arbs.slice(0, 10)) {
    const bestSpread = Math.max(Math.abs(a.binSpread), Math.abs(a.bybSpread));
    const bestVenue = Math.abs(a.binSpread) > Math.abs(a.bybSpread) ? 'Binance' : 'Bybit';
    const profit5k = 5000 * bestSpread / 100 - 10; // $10 for fees
    if (profit5k > 5) {
      console.log(`  ${a.sym}: ${bestSpread.toFixed(3)}% vs ${bestVenue} → $${profit5k.toFixed(0)} profit on $5k`);
    }
  }
}
main().catch(console.error);
