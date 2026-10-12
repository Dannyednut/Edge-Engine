const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Funding Rate Reliability Score ──\n');
  console.log('Scores perps by how consistently funding stays positive (for short-and-earn strategy)\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'ZEC', 'XRP', 'DOGE', 'AVAX', 'LINK', 'LTC', 'BNB', 'ATOM', 'SUI', 'INJ', 'ONDO', 'ZRO', 'GRASS', 'IO'];
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  const results: any[] = [];
  for (const coin of coins) {
    try {
      const history = await hlInfo({ type: 'fundingHistory', coin, startTime: thirtyDaysAgo, endTime: now });
      if (!Array.isArray(history) || history.length === 0) continue;
      
      let positiveHours = 0;
      let totalFunding = 0;
      let maxFunding = 0;
      let minFunding = 0;
      
      for (const h of history) {
        const rate = parseFloat(h.fundingRate || h.deltaRate || '0');
        totalFunding += rate;
        if (rate > 0) positiveHours++;
        if (rate > maxFunding) maxFunding = rate;
        if (rate < minFunding) minFunding = rate;
      }
      
      const reliability = (positiveHours / history.length * 100);
      const avgFunding = totalFunding / history.length;
      const annualApr = avgFunding * 24 * 365 * 100;
      // Reliability score = reliability% × annual APR / 100
      const score = (reliability * annualApr) / 100;
      
      results.push({ coin, reliability, avgFunding: avgFunding * 100, annualApr, maxFunding: maxFunding * 100, minFunding: minFunding * 100, score, events: history.length });
    } catch {}
  }
  
  results.sort((a, b) => b.score - a.score);
  
  console.log('Coin     | Reliability | Avg 1h    | Annual% | Max 1h    | Min 1h    | Score');
  console.log('─────────|─────────────|───────────|─────────|───────────|───────────|──────');
  for (const r of results) {
    console.log(`${r.coin.padEnd(9)}| ${r.reliability.toFixed(1).padStart(10)}%| ${r.avgFunding.toFixed(5).padStart(9)}%| ${r.annualApr.toFixed(1).padStart(7)}%| ${r.maxFunding.toFixed(4).padStart(9)}%| ${r.minFunding.toFixed(4).padStart(9)}%| ${r.score.toFixed(1)}`);
  }
  
  console.log('\n── Best Funding Arb Targets ──\n');
  console.log('  Score = Reliability% × Annual APR / 100');
  console.log('  Higher score = more reliable funding income');
  console.log('');
  for (const r of results.slice(0, 5)) {
    const dailyIncome = 5000 * r.avgFunding / 100 * 24;
    console.log(`  ${r.coin.padEnd(8)} score=${r.score.toFixed(1)}  ${r.reliability.toFixed(0)}% positive  ${r.annualApr.toFixed(1)}% APR  → $${dailyIncome.toFixed(2)}/day on $5k`);
  }
}
main().catch(console.error);
