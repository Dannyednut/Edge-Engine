const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Liquidity Heatmap ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const liquidity: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    if (vol < 1_000_000) continue;
    
    // Get order book depth
    const book = await hlInfo({ type: 'l2Book', coin: name });
    const levels = book?.levels || [];
    const bids = levels[0] || [];
    const asks = levels[1] || [];
    
    let bidDepth = 0, askDepth = 0;
    for (const b of bids.slice(0, 10)) bidDepth += parseFloat(b.sz) * parseFloat(b.px);
    for (const a of asks.slice(0, 10)) askDepth += parseFloat(a.sz) * parseFloat(a.px);
    const totalDepth = bidDepth + askDepth;
    
    liquidity.push({ name, vol, oi, bidDepth, askDepth, totalDepth, spread: asks[0] && bids[0] ? ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100) : 0 });
  }
  
  liquidity.sort((a, b) => b.totalDepth - a.totalDepth);
  
  console.log('Top 15 by liquidity (order book depth):\n');
  console.log('Name     | Depth $      | Spread %  | Vol $M     | OI $M      | Liquidity Score');
  console.log('─────────|──────────────|───────────|────────────|────────────|────────────────');
  for (const l of liquidity.slice(0, 15)) {
    const score = (l.totalDepth / 1e6) * (1 / Math.max(0.001, l.spread));
    const heat = score > 100 ? '🔥🔥🔥' : score > 10 ? '🔥🔥' : score > 1 ? '🔥' : '';
    console.log(`${l.name.padEnd(9)}| $${(l.totalDepth/1000).toFixed(0).padStart(11)}k| ${l.spread.toFixed(4).padStart(8)}%| ${(l.vol/1e6).toFixed(1).padStart(10)}| ${(l.oi/1e6).toFixed(1).padStart(10)}| ${score.toFixed(1).padStart(14)} ${heat}`);
  }
  
  console.log('\n  Liquidity Score = Depth / Spread');
  console.log('  Higher score = better execution (deep book + tight spread)');
  console.log('  Best for arb: high score = low slippage');
}
main().catch(console.error);
