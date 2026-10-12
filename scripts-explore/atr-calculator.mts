const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL ATR Calculator (14-period, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | ATR $      | ATR %    | Volatility');
  console.log('─────────|────────────|──────────|───────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 15) continue;
      
      const period = 14;
      const trueRanges: number[] = [];
      for (let i = 1; i < candles.length; i++) {
        const h = parseFloat(candles[i].h);
        const l = parseFloat(candles[i].l);
        const prevC = parseFloat(candles[i-1].c);
        const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        trueRanges.push(tr);
      }
      
      // Simple ATR (first 14 periods)
      let atr = trueRanges.slice(0, period).reduce((s, x) => s + x, 0) / period;
      // Smooth ATR
      for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
      }
      
      const current = parseFloat(candles[candles.length - 1].c);
      const atrPct = (atr / current * 100);
      const vol = atrPct > 3 ? '🔥 HIGH' : atrPct > 1 ? '🟡 MEDIUM' : '🟢 LOW';
      
      console.log(`${coin.padEnd(9)}| $${atr.toFixed(4).padStart(10)}| ${atrPct.toFixed(3).padStart(7)}%| ${vol}`);
    } catch {}
  }
  
  console.log('\n  ATR = Average True Range (volatility indicator)');
  console.log('  High ATR = more volatile = wider stop-loss needed');
  console.log('  Low ATR = less volatile = tighter stop-loss');
  console.log('  Use ATR for: position sizing, stop-loss placement');
}
main().catch(console.error);
