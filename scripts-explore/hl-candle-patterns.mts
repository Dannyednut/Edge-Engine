const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Candlestick Pattern Detector ──\n');
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W'];
  for (const coin of coins) {
    const candles = await hlInfo({ type: 'candleSnapshot', coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 });
    if (!Array.isArray(candles) || candles.length < 5) continue;
    
    const recent = candles.slice(-5);
    let patterns: string[] = [];
    
    for (const c of recent) {
      const o = parseFloat(c.o), h = parseFloat(c.h), l = parseFloat(c.l), cl = parseFloat(c.c);
      const body = Math.abs(cl - o);
      const range = h - l;
      const upperWick = h - Math.max(o, cl);
      const lowerWick = Math.min(o, cl) - l;
      
      if (body < range * 0.1 && upperWick > range * 0.5 && lowerWick > range * 0.5) patterns.push('Doji');
      else if (lowerWick > body * 2 && cl > o) patterns.push('Hammer');
      else if (upperWick > body * 2 && cl < o) patterns.push('Shooting Star');
      else if (cl > o && body > range * 0.7) patterns.push('Bullish Marubozu');
      else if (cl < o && body > range * 0.7) patterns.push('Bearish Marubozu');
      else patterns.push('-');
    }
    
    const last5 = recent.map(c => parseFloat(c.c));
    const trend = last5[4] > last5[0] ? '📈 UP' : last5[4] < last5[0] ? '📉 DOWN' : '➡️ FLAT';
    const change = ((last5[4] - last5[0]) / last5[0] * 100).toFixed(2);
    
    console.log(`${coin.padEnd(6)} ${trend} ${change}%  patterns: ${patterns.join(' → ')}`);
  }
}
main().catch(console.error);
