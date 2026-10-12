const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Order Book Imbalance Alert ──\n');
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'ZEC'];
  
  const alerts: any[] = [];
  for (const coin of coins) {
    const book = await hlInfo({ type: 'l2Book', coin });
    const levels = book?.levels || [];
    const bids = levels[0] || [];
    const asks = levels[1] || [];
    
    let bidVol = 0, askVol = 0;
    for (const b of bids.slice(0, 5)) bidVol += parseFloat(b.sz) * parseFloat(b.px);
    for (const a of asks.slice(0, 5)) askVol += parseFloat(a.sz) * parseFloat(a.px);
    
    const imbalance = (bidVol - askVol) / (bidVol + askVol) * 100;
    const spread = asks[0] && bids[0] ? ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100) : 0;
    
    if (Math.abs(imbalance) > 50) {
      const direction = imbalance > 0 ? '🟢 BULLISH' : '🔴 BEARISH';
      alerts.push({ coin, imbalance, direction, bidVol, askVol, spread });
    }
  }
  
  if (alerts.length === 0) {
    console.log('  No extreme imbalances detected (>50%)');
  } else {
    console.log('⚠️  EXTREME ORDER BOOK IMBALANCES:\n');
    for (const a of alerts.sort((x, y) => Math.abs(y.imbalance) - Math.abs(x.imbalance))) {
      console.log(`  ${a.coin.padEnd(8)} ${a.direction} imbalance=${a.imbalance.toFixed(1)}% bid=$${(a.bidVol/1000).toFixed(0)}k ask=$${(a.askVol/1000).toFixed(0)}k spread=${a.spread.toFixed(4)}%`);
    }
  }
  
  console.log('\n  Imbalance > 50% = potential price move imminent');
  console.log('  Use as confirmation for entry/exit timing');
}
main().catch(console.error);
