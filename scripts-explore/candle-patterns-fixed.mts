const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Candlestick Patterns (FIXED) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 5) {
        console.log(`${coin}: not enough candles`);
        continue;
      }
      
      const recent = candles.slice(-6);
      const patterns: string[] = [];
      let totalChange = 0;
      
      for (const c of recent) {
        const o = parseFloat(c.o), h = parseFloat(c.h), l = parseFloat(c.l), cl = parseFloat(c.c);
        const body = Math.abs(cl - o);
        const range = h - l;
        const upperWick = h - Math.max(o, cl);
        const lowerWick = Math.min(o, cl) - l;
        
        if (range === 0) { patterns.push('-'); continue; }
        
        if (body < range * 0.1) patterns.push('Doji');
        else if (lowerWick > body * 2 && cl > o) patterns.push('Hammer↗');
        else if (upperWick > body * 2 && cl < o) patterns.push('Star↘');
        else if (cl > o && body > range * 0.7) patterns.push('Bull▮');
        else if (cl < o && body > range * 0.7) patterns.push('Bear▮');
        else if (cl > o) patterns.push('Up');
        else patterns.push('Down');
      }
      
      const first = parseFloat(recent[0].o);
      const last = parseFloat(recent[recent.length - 1].c);
      totalChange = ((last - first) / first * 100);
      
      const trend = totalChange > 1 ? '📈' : totalChange < -1 ? '📉' : '➡️';
      console.log(`${coin.padEnd(6)} ${trend} ${totalChange.toFixed(2)}%  patterns: ${patterns.join(' → ')}`);
    } catch (e: any) {
      console.log(`${coin}: error`);
    }
  }
}
main().catch(console.error);
