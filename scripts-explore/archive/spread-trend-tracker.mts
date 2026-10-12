async function main() {
  console.log('── VOOI Spread Trend Tracker (5 scans, 30s interval) ──\n');
  
  const history: { time: string; asset: string; spread: number; long: string; short: string }[] = [];
  
  for (let scan = 1; scan <= 5; scan++) {
    const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=5&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
    const data = await res.ok ? await res.json() : { items: [] };
    
    const time = new Date().toISOString().substring(11, 19);
    console.log(`Scan ${scan} (${time}):`);
    
    for (const item of (data?.items || []).slice(0, 3)) {
      for (const p of (item.pairs || []).slice(0, 1)) {
        const spread = (p.priceSpread || 0) * 100;
        if (spread < 0.5) continue;
        const entry = { time, asset: item.asset, spread, long: p.long?.exchange, short: p.short?.exchange };
        history.push(entry);
        console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}%  ${p.long?.exchange}→${p.short?.exchange}`);
      }
    }
    console.log('');
    
    if (scan < 5) await new Promise(r => setTimeout(r, 30_000));
  }
  
  // Trend analysis
  console.log('── Trend Analysis ──\n');
  
  // Group by asset
  const byAsset: Record<string, number[]> = {};
  for (const h of history) {
    if (!byAsset[h.asset]) byAsset[h.asset] = [];
    byAsset[h.asset].push(h.spread);
  }
  
  for (const [asset, spreads] of Object.entries(byAsset)) {
    if (spreads.length < 2) continue;
    const trend = spreads[spreads.length - 1] - spreads[0];
    const direction = trend > 0.1 ? '📈 INCREASING' : trend < -0.1 ? '📉 DECREASING' : '➡️ STABLE';
    console.log(`  ${asset.padEnd(20)} ${spreads.map(s => s.toFixed(2)).join(' → ')}  ${direction} (${trend > 0 ? '+' : ''}${trend.toFixed(2)}%)`);
  }
  
  console.log('\n  INCREASING spread = opportunity growing (enter now)');
  console.log('  DECREASING spread = opportunity closing (capture immediately)');
  console.log('  STABLE spread = persistent opportunity (can wait)');
}
main().catch(console.error);
