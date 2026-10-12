const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Order Book Depth Analyzer ──\n');
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W'];
  for (const coin of coins) {
    const book = await hlInfo({ type: 'l2Book', coin });
    const levels = book?.levels || [];
    const bids = levels[0] || [];
    const asks = levels[1] || [];
    let bidVol = 0, askVol = 0;
    let bidDepth = 0, askDepth = 0;
    for (const b of bids) { bidVol += parseFloat(b.sz); bidDepth += parseFloat(b.sz) * parseFloat(b.px); }
    for (const a of asks) { askVol += parseFloat(a.sz); askDepth += parseFloat(a.sz) * parseFloat(a.px); }
    const imbalance = (bidVol - askVol) / (bidVol + askVol) * 100;
    const spread = asks[0] && bids[0] ? ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100) : 0;
    console.log(`${coin.padEnd(6)} bid_vol=${bidVol.toFixed(2).padStart(10)} ask_vol=${askVol.toFixed(2).padStart(10)} imbalance=${imbalance.toFixed(1).padStart(6)}% spread=${spread.toFixed(4)}% bid_depth=$${(bidDepth/1000).toFixed(0)}k ask_depth=$${(askDepth/1000).toFixed(0)}k`);
  }
}
main().catch(console.error);
