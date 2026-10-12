async function main() {
  console.log('── VOOI Exchange Connectivity Check ──\n');
  
  const exchanges = ['hyperliquid', 'aster', 'lighter', 'binance', 'bybit', 'mexc', 'gate', 'robinhood', 'ondo', 'extended', 'trade.xyz', 'kinetiq'];
  
  console.log('Exchange      | Status  | Notes');
  console.log('──────────────|─────────|─────────────────────────────');
  
  for (const ex of exchanges) {
    // Check if exchange appears in VOOI scanner results
    const res = await fetch(`https://perps-api.vooi.io/arbitrage-scanner?limit=200&exchanges=${ex}`);
    const data = res.ok ? await res.json() : { items: [] };
    const count = data?.items?.length || 0;
    let hasOpps = false;
    for (const item of (data?.items || [])) {
      for (const p of (item.pairs || [])) {
        if ((p.priceSpread || 0) * 100 > 0.5) { hasOpps = true; break; }
      }
      if (hasOpps) break;
    }
    console.log(`${ex.padEnd(14)}| ${count > 0 ? '✅' : '❌'} ${count.toString().padStart(3)} assets| ${hasOpps ? 'Has arb opportunities' : 'No arbs'}`);
  }
  
  console.log('\n── Exchange Pairs with Most Opportunities ──\n');
  
  // Get all opportunities and count by exchange pair
  const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=200&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const data = await res.ok ? await res.json() : { items: [] };
  
  const pairCounts: Record<string, number> = {};
  for (const item of (data?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const key = `${p.long?.exchange}→${p.short?.exchange}`;
      pairCounts[key] = (pairCounts[key] || 0) + 1;
    }
  }
  
  const sorted = Object.entries(pairCounts).sort((a, b) => b[1] - a[1]);
  console.log('Exchange Pair              | Opportunities');
  console.log('───────────────────────────|──────────────');
  for (const [pair, count] of sorted.slice(0, 15)) {
    console.log(`${pair.padEnd(27)}| ${count}`);
  }
  
  console.log('\n── To Enable VOOI Bot Creation ──\n');
  console.log('  1. Connect exchanges on VOOI dashboard: https://ultra.vooi.io');
  console.log('  2. Go to Settings → API Connections');
  console.log('  3. Connect each exchange with API keys');
  console.log('  4. Once connected, bot creation will work');
  console.log('  5. Best pairs to connect: mexc+gate, mexc+lighter, gate+lighter');
}
main().catch(console.error);
