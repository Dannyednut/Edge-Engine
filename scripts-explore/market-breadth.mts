const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Market Breadth Indicator ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  let up = 0, down = 0, flat = 0;
  let upVol = 0, downVol = 0;
  let topGainer = { name: '', change: -Infinity };
  let topLoser = { name: '', change: Infinity };
  
  for (let i = 0; i < universe.length; i++) {
    const change = parseFloat(ctxs[i]?.midDayPctChange || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (change > 0.1) { up++; upVol += vol; }
    else if (change < -0.1) { down++; downVol += vol; }
    else flat++;
    
    if (change > topGainer.change && vol > 1_000_000) topGainer = { name: universe[i].name, change };
    if (change < topLoser.change && vol > 1_000_000) topLoser = { name: universe[i].name, change };
  }
  
  const total = up + down + flat;
  const breadth = (up - down) / total * 100;
  
  console.log(`  Total perps: ${total}`);
  console.log(`  Up: ${up} (${(up/total*100).toFixed(0)}%)`);
  console.log(`  Down: ${down} (${(down/total*100).toFixed(0)}%)`);
  console.log(`  Flat: ${flat} (${(flat/total*100).toFixed(0)}%)`);
  console.log(`  Breadth: ${breadth.toFixed(0)}% (${breadth > 30 ? '🟢 BULLISH' : breadth < -30 ? '🔴 BEARISH' : '⚪ NEUTRAL'})`);
  console.log(`  Up volume: $${(upVol/1e9).toFixed(2)}B`);
  console.log(`  Down volume: $${(downVol/1e9).toFixed(2)}B`);
  console.log(`  Volume ratio: ${(upVol/(upVol+downVol)*100).toFixed(0)}% up`);
  console.log(`  Top gainer: ${topGainer.name} (+${topGainer.change.toFixed(2)}%)`);
  console.log(`  Top loser: ${topLoser.name} (${topLoser.change.toFixed(2)}%)`);
}
main().catch(console.error);
