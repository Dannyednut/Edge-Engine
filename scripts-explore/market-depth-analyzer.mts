const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Market Depth Analyzer ──\n');
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS'];
  
  for (const coin of coins) {
    const book = await hlInfo({ type: 'l2Book', coin });
    const levels = book?.levels || [];
    const bids = levels[0] || [];
    const asks = levels[1] || [];
    
    // Calculate cumulative depth at different levels
    let bidDepth1 = 0, bidDepth5 = 0, bidDepth10 = 0;
    let askDepth1 = 0, askDepth5 = 0, askDepth10 = 0;
    let bidVol1 = 0, askVol1 = 0;
    
    for (let i = 0; i < Math.min(bids.length, 10); i++) {
      const sz = parseFloat(bids[i].sz);
      const px = parseFloat(bids[i].px);
      const vol = sz * px;
      if (i < 1) { bidDepth1 += sz; bidVol1 += vol; }
      if (i < 5) bidDepth5 += sz;
      bidDepth10 += sz;
    }
    
    for (let i = 0; i < Math.min(asks.length, 10); i++) {
      const sz = parseFloat(asks[i].sz);
      const px = parseFloat(asks[i].px);
      const vol = sz * px;
      if (i < 1) { askDepth1 += sz; askVol1 += vol; }
      if (i < 5) askDepth5 += sz;
      askDepth10 += sz;
    }
    
    const spread = asks[0] && bids[0] ? ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100) : 0;
    const imbalance = (bidDepth1 - askDepth1) / (bidDepth1 + askDepth1) * 100;
    
    console.log(`${coin.padEnd(8)} spread=${spread.toFixed(4)}%  bid1=${bidDepth1.toFixed(2)} ask1=${askDepth1.toFixed(2)} imb=${imbalance.toFixed(1)}%  bidVol1=$${(bidVol1/1000).toFixed(0)}k askVol1=$${(askVol1/1000).toFixed(0)}k  depth5: ${bidDepth5.toFixed(2)}/${askDepth5.toFixed(2)}  depth10: ${bidDepth10.toFixed(2)}/${askDepth10.toFixed(2)}`);
  }
  
  console.log('\n  Use depth to determine max position size without moving price');
  console.log('  Higher depth = can execute larger orders = more profit per arb');
}
main().catch(console.error);
