const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Funding Rate Momentum (30d vs 7d vs 24h) ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | Current 1h | 7d Avg 1h | 30d Avg 1h | 7d Trend | 30d Trend');
  console.log('─────────|────────────|────────────|────────────|───────────|───────────');
  
  for (const coin of coins) {
    try {
      const idx = universe.findIndex(u => u.name === coin);
      if (idx < 0) continue;
      const current = parseFloat(ctxs[idx]?.funding || '0') * 100;
      
      // 7-day funding
      const hist7 = await hlInfo({ type: 'fundingHistory', coin, startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, endTime: Date.now() });
      let avg7 = 0;
      if (Array.isArray(hist7) && hist7.length > 0) {
        let sum = 0;
        for (const h of hist7) sum += parseFloat(h.fundingRate || h.deltaRate || '0');
        avg7 = sum / hist7.length * 100;
      }
      
      // 30-day funding
      const hist30 = await hlInfo({ type: 'fundingHistory', coin, startTime: Date.now() - 30 * 24 * 60 * 60 * 1000, endTime: Date.now() });
      let avg30 = 0;
      if (Array.isArray(hist30) && hist30.length > 0) {
        let sum = 0;
        for (const h of hist30) sum += parseFloat(h.fundingRate || h.deltaRate || '0');
        avg30 = sum / hist30.length * 100;
      }
      
      const trend7 = current > avg7 ? '📈 Increasing' : current < avg7 ? '📉 Decreasing' : '➡️ Stable';
      const trend30 = current > avg30 ? '📈 Above avg' : current < avg30 ? '📉 Below avg' : '➡️ At avg';
      
      console.log(`${coin.padEnd(9)}| ${(current).toFixed(5).padStart(10)}%| ${(avg7).toFixed(5).padStart(10)}%| ${(avg30).toFixed(5).padStart(10)}%| ${trend7.padEnd(10)}| ${trend30}`);
    } catch {}
  }
  
  console.log('\n  Current > 7d avg: funding increasing → enter short');
  console.log('  Current < 7d avg: funding decreasing → exit short');
}
main().catch(console.error);
