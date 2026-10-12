const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function getCandles(coin: string, interval: string, hours: number) {
  const candles = await hlInfo({
    type: 'candleSnapshot',
    req: { coin, interval, startTime: Date.now() - hours * 60 * 60 * 1000 }
  });
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const first = parseFloat(candles[0].o);
  const last = parseFloat(candles[candles.length - 1].c);
  const change = ((last - first) / first * 100);
  const high = Math.max(...candles.map(c => parseFloat(c.h)));
  const low = Math.min(...candles.map(c => parseFloat(c.l)));
  return { change, high, low, last, count: candles.length };
}

async function main() {
  console.log('── HL Multi-Timeframe Analysis ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO'];
  
  console.log('Coin     | 1h Change | 4h Change | 1d Change | Trend     | Alignment');
  console.log('─────────|───────────|───────────|───────────|───────────|──────────');
  
  for (const coin of coins) {
    try {
      const [h1, h4, d1] = await Promise.all([
        getCandles(coin, '1h', 1),
        getCandles(coin, '4h', 4),
        getCandles(coin, '1d', 24),
      ]);
      
      if (!h1 || !h4 || !d1) continue;
      
      const trend1h = h1.change > 0.3 ? '🟢' : h1.change < -0.3 ? '🔴' : '⚪';
      const trend4h = h4.change > 1 ? '🟢' : h4.change < -1 ? '🔴' : '⚪';
      const trend1d = d1.change > 3 ? '🟢' : d1.change < -3 ? '🔴' : '⚪';
      
      const allUp = h1.change > 0 && h4.change > 0 && d1.change > 0;
      const allDown = h1.change < 0 && h4.change < 0 && d1.change < 0;
      const alignment = allUp ? 'STRONG BUY 🟢🟢🟢' : allDown ? 'STRONG SELL 🔴🔴🔴' : 'MIXED ⚠️';
      
      console.log(`${coin.padEnd(9)}| ${trend1h}${h1.change.toFixed(2).padStart(7)}%| ${trend4h}${h4.change.toFixed(2).padStart(7)}%| ${trend1d}${d1.change.toFixed(2).padStart(7)}%| ${trend1d}${trend4h}${trend1h}| ${alignment}`);
    } catch {}
  }
  
  console.log('\n  Multi-timeframe alignment = stronger signal');
  console.log('  All green → bullish across all timeframes');
  console.log('  All red → bearish across all timeframes');
  console.log('  Mixed → no clear direction, wait for alignment');
}
main().catch(console.error);
