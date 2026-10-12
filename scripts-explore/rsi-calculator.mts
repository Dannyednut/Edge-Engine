const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL RSI Calculator (14-period, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC', 'SUI', 'DOGE'];
  
  console.log('Coin     | RSI    | Signal');
  console.log('─────────|────────|───────────────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 15) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      const period = 14;
      
      // Calculate RSI
      let gains = 0, losses = 0;
      for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i-1];
        if (change > 0) gains += change;
        else losses -= change;
      }
      let avgGain = gains / period;
      let avgLoss = losses / period;
      
      // Smooth for remaining periods
      for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i-1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = 100 - (100 / (1 + rs));
      
      let signal = '';
      if (rsi > 70) signal = '🔴 Overbought (sell)';
      else if (rsi < 30) signal = '🟢 Oversold (buy)';
      else if (rsi > 50) signal = '⚪ Bullish bias';
      else signal = '⚪ Bearish bias';
      
      console.log(`${coin.padEnd(9)}| ${rsi.toFixed(1).padStart(6)}| ${signal}`);
    } catch {}
  }
  
  console.log('\n  RSI > 70: overbought (potential sell)');
  console.log('  RSI < 30: oversold (potential buy)');
  console.log('  RSI > 50: bullish bias');
  console.log('  RSI < 50: bearish bias');
}
main().catch(console.error);
