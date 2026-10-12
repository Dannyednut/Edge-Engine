async function main() {
  console.log('── VOOI Bot Configuration Generator ──\n');
  
  // Get top exchange pairs
  const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=200&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const data = await res.ok ? await res.json() : { items: [] };
  
  const pairStats: Record<string, { count: number; totalSpread: number; assets: string[] }> = {};
  for (const item of (data?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const key = `${p.long?.exchange}+${p.short?.exchange}`;
      if (!pairStats[key]) pairStats[key] = { count: 0, totalSpread: 0, assets: [] };
      pairStats[key].count++;
      pairStats[key].totalSpread += spread;
      pairStats[key].assets.push(item.asset);
    }
  }
  
  const sorted = Object.entries(pairStats).sort((a, b) => b[1].count - a[1].count);
  
  console.log('── Recommended Bot Configurations ──\n');
  for (const [pair, stats] of sorted.slice(0, 5)) {
    const [ex1, ex2] = pair.split('+');
    const avgSpread = stats.totalSpread / stats.count;
    console.log(`Bot ${ex1} + ${ex2}:`);
    console.log(`  Opportunities: ${stats.count}`);
    console.log(`  Avg spread: ${avgSpread.toFixed(2)}%`);
    console.log(`  Config: { exchanges: ['${ex1}', '${ex2}'], leverage: 1, notionalUsd: 5000, maxHoldHours: 24, maxRoundTripCostBps: 12 }`);
    console.log(`  Assets: ${stats.assets.slice(0, 5).join(', ')}...`);
    console.log('');
  }
  
  console.log('── Steps to Create Bots ──');
  console.log('  1. Connect exchanges on VOOI dashboard: https://ultra.vooi.io');
  console.log('  2. Go to Settings → API Connections');
  console.log('  3. Connect each exchange with API keys');
  console.log('  4. Run: vooi-create-bot-fixed.mts with recommended config');
  console.log('  5. Monitor bot performance');
}
main().catch(console.error);
