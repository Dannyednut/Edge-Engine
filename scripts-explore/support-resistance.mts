const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Support/Resistance Levels (7d, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 20) continue;
      
      const current = parseFloat(candles[candles.length - 1].c);
      
      // Find swing highs and lows
      const swingHighs: number[] = [];
      const swingLows: number[] = [];
      const lookback = 3;
      
      for (let i = lookback; i < candles.length - lookback; i++) {
        const h = parseFloat(candles[i].h);
        const l = parseFloat(candles[i].l);
        let isHigh = true, isLow = true;
        for (let j = 1; j <= lookback; j++) {
          if (parseFloat(candles[i-j].h) >= h || parseFloat(candles[i+j].h) >= h) isHigh = false;
          if (parseFloat(candles[i-j].l) <= l || parseFloat(candles[i+j].l) <= l) isLow = false;
        }
        if (isHigh) swingHighs.push(h);
        if (isLow) swingLows.push(l);
      }
      
      // Cluster levels (within 0.5% of each other)
      const clusterLevels = (levels: number[]) => {
        if (levels.length === 0) return [];
        const sorted = [...levels].sort((a, b) => a - b);
        const clusters: { price: number; count: number }[] = [];
        let current = { price: sorted[0], count: 1 };
        for (let i = 1; i < sorted.length; i++) {
          if (Math.abs(sorted[i] - current.price) / current.price < 0.005) {
            current.count++;
            current.price = (current.price * (current.count - 1) + sorted[i]) / current.count;
          } else {
            clusters.push(current);
            current = { price: sorted[i], count: 1 };
          }
        }
        clusters.push(current);
        return clusters.sort((a, b) => b.count - a.count);
      };
      
      const resLevels = clusterLevels(swingHighs).slice(0, 3);
      const supLevels = clusterLevels(swingLows).slice(0, 3);
      
      console.log(`${coin.padEnd(8)} ($${current.toFixed(2)}):`);
      console.log(`  Resistance: ${resLevels.length > 0 ? resLevels.map(l => '$' + l.price.toFixed(2) + `(${l.count}x)}`).join(', ') : 'none'}`);
      console.log(`  Support:    ${supLevels.length > 0 ? supLevels.map(l => '$' + l.price.toFixed(2) + `(${l.count}x)`).join(', ') : 'none'}`);
      
      // Nearest levels
      const nearestRes = resLevels.filter(l => l.price > current).sort((a, b) => a.price - b.price)[0];
      const nearestSup = supLevels.filter(l => l.price < current).sort((a, b) => b.price - a.price)[0];
      if (nearestRes) console.log(`  → Next resistance: $${nearestRes.price.toFixed(2)} (+${((nearestRes.price - current) / current * 100).toFixed(1)}%)`);
      if (nearestSup) console.log(`  → Next support: $${nearestSup.price.toFixed(2)} (${((nearestSup.price - current) / current * 100).toFixed(1)}%)`);
      console.log('');
    } catch {}
  }
}
main().catch(console.error);
