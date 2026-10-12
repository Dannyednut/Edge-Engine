const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Recent Trades Flow Analyzer ──\n');
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE'];
  for (const coin of coins) {
    const trades = await hlInfo({ type: 'recentTrades', coin });
    if (!Array.isArray(trades)) continue;
    let buys = 0, sells = 0, buyVol = 0, sellVol = 0;
    let maxTrade = 0;
    for (const t of trades) {
      const px = parseFloat(t.px || '0');
      const sz = parseFloat(t.sz || '0');
      const notional = px * sz;
      if (t.side === 'B') { buys++; buyVol += notional; }
      else { sells++; sellVol += notional; }
      if (notional > maxTrade) maxTrade = notional;
    }
    const ratio = sells > 0 ? buyVol / sellVol : Infinity;
    const sentiment = ratio > 1.5 ? '🟢 BULLISH' : ratio < 0.67 ? '🔴 BEARISH' : '⚪ NEUTRAL';
    console.log(`${coin.padEnd(6)} buys=${buys} sells=${sells} buy_vol=$${(buyVol/1000).toFixed(1)}k sell_vol=$${(sellVol/1000).toFixed(1)}k ratio=${ratio.toFixed(2)} max=$${maxTrade.toFixed(0)} ${sentiment}`);
  }
}
main().catch(console.error);
