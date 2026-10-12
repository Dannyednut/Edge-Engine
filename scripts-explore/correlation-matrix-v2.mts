const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Correlation Matrix (24h, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO'];
  const prices: Record<string, number[]> = {};
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 } });
      if (Array.isArray(candles) && candles.length > 10) {
        prices[coin] = candles.map(c => parseFloat(c.c));
      }
    } catch {}
  }
  
  // Calculate correlations
  const calcCorr = (a: number[], b: number[]) => {
    const n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    const aS = a.slice(0, n);
    const bS = b.slice(0, n);
    const aMean = aS.reduce((s, x) => s + x, 0) / n;
    const bMean = bS.reduce((s, x) => s + x, 0) / n;
    let cov = 0, aVar = 0, bVar = 0;
    for (let i = 0; i < n; i++) {
      const ad = aS[i] - aMean, bd = bS[i] - bMean;
      cov += ad * bd; aVar += ad * ad; bVar += bd * bd;
    }
    return aVar > 0 && bVar > 0 ? cov / Math.sqrt(aVar * bVar) : 0;
  };
  
  console.log('         ' + coins.map(c => c.substring(0, 5).padStart(7)).join(''));
  for (const c1 of coins) {
    if (!prices[c1]) continue;
    let row = `${c1.padEnd(8)}`;
    for (const c2 of coins) {
      if (!prices[c2]) { row += '    N/A'; continue; }
      const corr = calcCorr(prices[c1], prices[c2]);
      const emoji = corr > 0.7 ? '🟢' : corr > 0.3 ? '🟡' : corr < -0.3 ? '🔴' : '⚪';
      row += ` ${emoji}${corr.toFixed(2)}`;
    }
    console.log(row);
  }
  
  console.log('\n  > 0.7: highly correlated (move together)');
  console.log('  > 0.3: positively correlated');
  console.log('  < -0.3: negatively correlated (hedge candidates)');
  console.log('');
  console.log('  Strategy: Long correlated pair, short divergent → mean reversion');
  console.log('  Or: Long negatively correlated pair → hedge');
}
main().catch(console.error);
