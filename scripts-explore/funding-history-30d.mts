const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Funding History (30-day) for Top Perps ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'ZEC'];
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  
  for (const coin of coins) {
    try {
      const history = await hlInfo({ type: 'fundingHistory', coin, startTime: thirtyDaysAgo, endTime: now });
      if (!Array.isArray(history) || history.length === 0) {
        console.log(`${coin}: no history`);
        continue;
      }
      
      let totalFunding = 0;
      let positiveHours = 0;
      let negativeHours = 0;
      let maxFunding = 0;
      let minFunding = 0;
      let avgFunding = 0;
      
      for (const h of history) {
        const rate = parseFloat(h.fundingRate || h.deltaRate || '0');
        totalFunding += rate;
        if (rate > 0) positiveHours++;
        else if (rate < 0) negativeHours++;
        if (rate > maxFunding) maxFunding = rate;
        if (rate < minFunding) minFunding = rate;
      }
      avgFunding = totalFunding / history.length;
      const annualized = avgFunding * 24 * 365 * 100;
      
      console.log(`${coin.padEnd(6)} events=${history.length} avg/h=${(avgFunding*100).toFixed(5)}% annual=${annualized.toFixed(1)}% pos=${positiveHours} neg=${negativeHours} max=${(maxFunding*100).toFixed(4)}% min=${(minFunding*100).toFixed(4)}%`);
    } catch (e: any) {
      console.log(`${coin}: error - ${e.message?.substring(0, 50)}`);
    }
  }
  
  console.log('\n── Backtest Insight ──');
  console.log('  If we shorted W for 30 days at avg funding → captured avg APR');
  console.log('  If we longed MINA when funding was very negative → captured negative funding');
  console.log('  Best strategy: short highest positive funding perps, hedge on CEX');
}
main().catch(console.error);
