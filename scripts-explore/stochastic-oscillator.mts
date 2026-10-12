const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Stochastic Oscillator (14, 3, 3) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | %K    | %D    | Signal');
  console.log('─────────|───────|───────|───────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 20) continue;
      
      const period = 14;
      const smoothK = 3;
      const smoothD = 3;
      
      // Calculate %K
      const kValues: number[] = [];
      for (let i = period - 1; i < candles.length; i++) {
        const slice = candles.slice(i - period + 1, i + 1);
        const high = Math.max(...slice.map(c => parseFloat(c.h)));
        const low = Math.min(...slice.map(c => parseFloat(c.l)));
        const close = parseFloat(candles[i].c);
        const k = high === low ? 50 : ((close - low) / (high - low) * 100);
        kValues.push(k);
      }
      
      // Smooth %K (3-period SMA)
      const smoothedK: number[] = [];
      for (let i = smoothK - 1; i < kValues.length; i++) {
        const avg = kValues.slice(i - smoothK + 1, i + 1).reduce((s, x) => s + x, 0) / smoothK;
        smoothedK.push(avg);
      }
      
      // %D (3-period SMA of smoothed %K)
      const dValues: number[] = [];
      for (let i = smoothD - 1; i < smoothedK.length; i++) {
        const avg = smoothedK.slice(i - smoothD + 1, i + 1).reduce((s, x) => s + x, 0) / smoothD;
        dValues.push(avg);
      }
      
      const currentK = smoothedK[smoothedK.length - 1];
      const currentD = dValues[dValues.length - 1];
      
      let signal = '⚪ Neutral';
      if (currentK < 20 && currentD < 20) signal = '🟢 Oversold (buy)';
      else if (currentK > 80 && currentD > 80) signal = '🔴 Overbought (sell)';
      else if (currentK > currentD && currentK < 50) signal = '🟢 Bullish cross';
      else if (currentK < currentD && currentK > 50) signal = '🔴 Bearish cross';
      
      console.log(`${coin.padEnd(9)}| ${currentK.toFixed(1).padStart(5)}| ${currentD.toFixed(1).padStart(5)}| ${signal}`);
    } catch {}
  }
  
  console.log('\n  %K < 20: oversold → BUY');
  console.log('  %K > 80: overbought → SELL');
  console.log('  %K crosses above %D: bullish');
  console.log('  %K crosses below %D: bearish');
}
main().catch(console.error);
