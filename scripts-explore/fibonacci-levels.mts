const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Fibonacci Retracement Levels (7d swing) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  const fibLevels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 7 * 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 10) continue;
      
      // Find 7d high and low
      const high = Math.max(...candles.map(c => parseFloat(c.h)));
      const low = Math.min(...candles.map(c => parseFloat(c.l)));
      const current = parseFloat(candles[candles.length - 1].c);
      const range = high - low;
      
      console.log(`${coin.padEnd(8)} 7d High: $${high.toFixed(2)} Low: $${low.toFixed(2)} Current: $${current.toFixed(2)}`);
      console.log('  Fibonacci levels:');
      for (const fib of fibLevels) {
        const price = high - range * fib;
        const dev = ((current - price) / price * 100);
        const isCurrent = Math.abs(dev) < 1 ? ' ← CURRENT' : '';
        const label = fib === 0 ? '0% (High)' : fib === 1 ? '100% (Low)' : fib === 0.5 ? '50%' : fib === 0.618 ? '61.8% (Golden)' : `${(fib*100).toFixed(1)}%`;
        console.log(`    ${label.padEnd(18)} $${price.toFixed(2)}${isCurrent}`);
      }
      console.log('');
    } catch {}
  }
  
  console.log('  Price near 61.8%: golden ratio (strong support/resistance)');
  console.log('  Price near 50%: midpoint (psychological level)');
  console.log('  Price near 38.2%: common retracement target');
}
main().catch(console.error);
