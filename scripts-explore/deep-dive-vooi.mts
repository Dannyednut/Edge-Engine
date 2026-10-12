/**
 * DEEP DIVE: VOOI API — Full asset + exchange enumeration
 */
async function main() {
  console.log('── DEEP DIVE: VOOI API Full Enumeration ──\n');

  // 1. Get all assets
  const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=200&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0');
  const data = await res.ok ? await res.json() : { items: [], total: 0 };
  
  console.log(`Total assets: ${data?.total || 0}`);
  console.log(`Items returned: ${data?.items?.length || 0}\n`);

  // 2. Extract all exchanges
  const exchanges = new Set<string>();
  const assets = new Set<string>();
  const categories = new Set<string>();
  
  for (const item of (data?.items || [])) {
    assets.add(item.asset);
    for (const p of (item.pairs || [])) {
      if (p.long?.exchange) exchanges.add(p.long.exchange);
      if (p.short?.exchange) exchanges.add(p.short.exchange);
    }
  }

  console.log(`Unique assets: ${assets.size}`);
  console.log(`Unique exchanges: ${exchanges.size}`);
  console.log(`Exchanges: ${Array.from(exchanges).join(', ')}\n`);

  // 3. Top opportunities by price spread
  const allOpps: any[] = [];
  for (const item of (data?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread > 0.1) {
        allOpps.push({
          asset: item.asset,
          spread,
          long: p.long?.exchange,
          short: p.short?.exchange,
          longPrice: parseFloat(p.long?.price || '0'),
          shortPrice: parseFloat(p.short?.price || '0'),
          volume: p.long?.volume24h || 0,
          priceSpreadAtSize: p.priceSpreadAtSize,
        });
      }
    }
  }
  allOpps.sort((a, b) => b.spread - a.spread);

  console.log(`── Top 30 Price Spread Opportunities ──\n`);
  console.log('Asset              | Spread  | Long → Short          | Long $       | Short $      | Vol 24h');
  console.log('───────────────────|─────────|──────────────────────|──────────────|──────────────|─────────');
  for (const o of allOpps.slice(0, 30)) {
    console.log(`${o.asset.padEnd(18)}| ${o.spread.toFixed(2).padStart(7)}%| ${o.long.padEnd(10)} → ${o.short.padEnd(10)}| $${o.longPrice.toFixed(4).padStart(12)}| $${o.shortPrice.toFixed(4).padStart(12)}| $${(o.volume/1000).toFixed(0)}k`);
  }

  // 4. Group by exchange pair
  console.log('\n── Opportunities by Exchange Pair ──\n');
  const byPair: Record<string, { count: number; totalSpread: number }> = {};
  for (const o of allOpps) {
    const key = `${o.long}→${o.short}`;
    if (!byPair[key]) byPair[key] = { count: 0, totalSpread: 0 };
    byPair[key].count++;
    byPair[key].totalSpread += o.spread;
  }
  const sortedPairs = Object.entries(byPair).sort((a, b) => b[1].count - a[1].count);
  console.log('Exchange Pair              | Count | Avg Spread');
  console.log('───────────────────────────|───────|───────────');
  for (const [pair, data] of sortedPairs.slice(0, 15)) {
    console.log(`${pair.padEnd(27)}| ${data.count.toString().padStart(5)} | ${(data.totalSpread / data.count).toFixed(2)}%`);
  }

  // 5. Total potential profit
  console.log('\n── Total Profit Potential ──\n');
  let totalProfit5k = 0;
  for (const o of allOpps.slice(0, 10)) {
    const profit = 5000 * o.spread / 100 - 5; // $5k - $5 fees
    totalProfit5k += profit;
  }
  console.log(`  Top 10 opportunities on $5k each: $${totalProfit5k.toFixed(0)}`);
  console.log(`  If captured 1x/day: $${(totalProfit5k * 365).toFixed(0)}/yr`);
  console.log(`  Capital needed: $50,000 (10 × $5k)`);
  console.log(`  APR: ${(totalProfit5k * 365 / 50000 * 100).toFixed(0)}%`);
}
main().catch(console.error);
