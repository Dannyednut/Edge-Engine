async function main() {
  console.log('── VOOI Price Spread Persistence Tracker (3 scans) ──\n');
  
  for (let scan = 1; scan <= 3; scan++) {
    const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
    const data = await res.ok ? await res.json() : { items: [] };
    
    console.log(`Scan ${scan} — ${new Date().toISOString().substring(11, 19)}`);
    for (const item of (data?.items || []).slice(0, 5)) {
      for (const p of (item.pairs || []).slice(0, 1)) {
        const spread = (p.priceSpread || 0) * 100;
        if (spread < 0.5) continue;
        console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}%  ${p.long?.exchange}→${p.short?.exchange}  $${parseFloat(p.long?.price||'0').toFixed(2)}→$${parseFloat(p.short?.price||'0').toFixed(2)}`);
      }
    }
    console.log('');
    if (scan < 3) await new Promise(r => setTimeout(r, 30_000));
  }
  console.log('Persistence: if spread stays > 0.5% across scans, opportunity is stable');
}
main().catch(console.error);
