const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i-1] * (1 - k));
  }
  return result;
}

async function main() {
  console.log('── HL MACD Calculator (12/26/9, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  
  console.log('Coin     | MACD       | Signal     | Histogram | Cross');
  console.log('─────────|────────────|────────────|───────────|──────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 72 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 30) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      
      const macdLine: number[] = [];
      for (let i = 0; i < closes.length; i++) {
        macdLine.push(ema12[i] - ema26[i]);
      }
      
      const signalLine = ema(macdLine, 9);
      
      const currentMacd = macdLine[macdLine.length - 1];
      const currentSignal = signalLine[signalLine.length - 1];
      const histogram = currentMacd - currentSignal;
      const prevHistogram = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
      
      let cross = '⚪';
      if (histogram > 0 && prevHistogram <= 0) cross = '🟢 Bullish cross';
      else if (histogram < 0 && prevHistogram >= 0) cross = '🔴 Bearish cross';
      else if (histogram > 0) cross = '🟢 Above signal';
      else cross = '🔴 Below signal';
      
      console.log(`${coin.padEnd(9)}| ${currentMacd.toFixed(4).padStart(10)}| ${currentSignal.toFixed(4).padStart(10)}| ${histogram.toFixed(4).padStart(9)}| ${cross}`);
    } catch {}
  }
  
  console.log('\n  MACD > Signal: bullish momentum');
  console.log('  MACD < Signal: bearish momentum');
  console.log('  Bullish cross: MACD crosses above signal → BUY');
  console.log('  Bearish cross: MACD crosses below signal → SELL');
}
main().catch(console.error);
