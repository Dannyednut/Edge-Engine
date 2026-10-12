/**
 * Research: HIP-3 Prediction Markets Deep Dive
 * Explore all 298 HIP-3 markets for real opportunities
 */
async function main() {
  console.log('── HIP-3 Prediction Markets Deep Dive ──\n');

  // Get all spot markets (HIP-3 markets show up here)
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
  });
  const data = await res.json();
  const universe = data?.[0]?.universe || [];
  const ctxs = data?.[1] || [];
  const tokens = data?.[0]?.tokens || [];

  // Categorize markets
  const categories = {
    highVolume: [] as any[],
    highVolatility: [] as any[],
    stablePrice: [] as any[],
    newMarkets: [] as any[],
  };

  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const dayPct = parseFloat(ctxs[i]?.midDayPctChange || '0');
    
    if (markPx > 0 && vol > 1000) {
      const market = { name, price: markPx, volume: vol, dayPctChange: dayPct };
      
      if (vol > 100_000) categories.highVolume.push(market);
      if (Math.abs(dayPct) > 10) categories.highVolatility.push(market);
      if (markPx > 0.95 && markPx < 1.05) categories.stablePrice.push(market);
    }
  }

  console.log(`Total markets: ${universe.length}`);
  console.log(`High volume (>$100k): ${categories.highVolume.length}`);
  console.log(`High volatility (>10%): ${categories.highVolatility.length}`);
  console.log(`Stable price ($0.95-$1.05): ${categories.stablePrice.length}`);

  console.log('\n── High Volume Markets (top 20) ──\n');
  categories.highVolume.sort((a, b) => b.volume - a.volume);
  for (const m of categories.highVolume.slice(0, 20)) {
    console.log(`  ${m.name.padEnd(20)} $${m.price.toFixed(4).padStart(10)}  vol=$${(m.volume/1000).toFixed(0).padStart(8)}k  24h=${m.dayPctChange.toFixed(1)}%`);
  }

  console.log('\n── High Volatility Markets ──\n');
  categories.highVolatility.sort((a, b) => Math.abs(b.dayPctChange) - Math.abs(a.dayPctChange));
  for (const m of categories.highVolatility.slice(0, 10)) {
    console.log(`  ${m.name.padEnd(20)} $${m.price.toFixed(4).padStart(10)}  24h=${m.dayPctChange.toFixed(1)}%  vol=$${(m.volume/1000).toFixed(0)}k`);
  }

  console.log('\n── Prediction Market MM Opportunities ──\n');
  console.log('  Markets with high volume + mid-range price (10-90%) are best for MM');
  const mmCandidates = categories.highVolume.filter(m => m.price > 0.1 && m.price < 0.9);
  console.log(`  MM candidates: ${mmCandidates.length}`);
  for (const m of mmCandidates.slice(0, 10)) {
    const spread = 0.02; // 2% target spread
    const dailyProfit = m.volume * 0.005 * spread; // 0.5% capture at 2% spread
    console.log(`  ${m.name.padEnd(20)} price=${(m.price*100).toFixed(0)}%  vol=$${(m.volume/1000).toFixed(0)}k  est profit=$${dailyProfit.toFixed(0)}/day`);
  }
}
main().catch(console.error);
