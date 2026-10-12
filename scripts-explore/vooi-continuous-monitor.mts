async function main() {
  console.log('── VOOI Continuous Monitor (5 scans, 30s interval) ──\n');
  
  const seen = new Map<string, number[]>();
  
  for (let scan = 1; scan <= 5; scan++) {
    const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
    const data = res.ok ? await res.json() : { items: [] };
    
    let count = 0;
    for (const item of (data?.items || [])) {
      if (count >= 5) break;
      for (const p of (item.pairs || [])) {
        if (count >= 5) break;
        const spread = (p.priceSpread || 0) * 100;
        if (spread < 0.5) continue;
        const key = `${item.asset}|${p.long?.exchange}|${p.short?.exchange}`;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key)!.push(spread);
        count++;
      }
    }
    
    console.log(`Scan ${scan} (${new Date().toISOString().substring(11,19)}): ${count} opps`);
    if (scan < 5) await new Promise(r => setTimeout(r, 30_000));
  }
  
  // Analysis
  console.log('\n── Persistence Analysis ──\n');
  console.log('Asset               | Scans | Avg Spread | Min     | Max     | Stable?');
  console.log('────────────────────|───────|────────────|─────────|─────────|────────');
  
  for (const [key, spreads] of seen.entries()) {
    if (spreads.length < 2) continue;
    const [asset, long, short] = key.split('|');
    const avg = spreads.reduce((s, x) => s + x, 0) / spreads.length;
    const min = Math.min(...spreads);
    const max = Math.max(...spreads);
    const stable = (max - min) < 0.5 ? '✅ YES' : '⚠️ NO';
    console.log(`${asset.padEnd(20)}| ${spreads.length.toString().padStart(5)} | ${avg.toFixed(2).padStart(10)}%| ${min.toFixed(2).padStart(7)}%| ${max.toFixed(2).padStart(7)}%| ${stable}`);
  }
  
  console.log('\n  Stable opportunities = safe to execute (spread persists)');
  console.log('  Unstable = capture immediately (spread may disappear)');
}
main().catch(console.error);
