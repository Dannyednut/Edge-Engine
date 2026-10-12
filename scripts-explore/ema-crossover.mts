const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) result.push(values[i] * k + result[i-1] * (1 - k));
  return result;
}

async function main() {
  console.log('── HL EMA Crossover Detector (9/21 + 50/200) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  
  console.log('Coin     | EMA9-EMA21 | Short Signal | EMA50-EMA200 | Long Signal');
  console.log('─────────|────────────|──────────────|──────────────|─────────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 14 * 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 50) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const ema50 = ema(closes, 50);
      const ema200 = closes.length >= 200 ? ema(closes, 200) : null;
      
      const shortDiff = ema9[ema9.length - 1] - ema21[ema21.length - 1];
      const prevShortDiff = ema9[ema9.length - 2] - ema21[ema21.length - 2];
      const shortCross = shortDiff > 0 && prevShortDiff <= 0 ? '🟢 Golden cross' : shortDiff < 0 && prevShortDiff >= 0 ? '🔴 Death cross' : shortDiff > 0 ? '🟢 Above' : '🔴 Below';
      
      let longSignal = 'N/A';
      if (ema200) {
        const longDiff = ema50[ema50.length - 1] - ema200[ema200.length - 1];
        const prevLongDiff = ema50[ema50.length - 2] - ema200[ema200.length - 2];
        longSignal = longDiff > 0 && prevLongDiff <= 0 ? '🟢 Golden cross' : longDiff < 0 && prevLongDiff >= 0 ? '🔴 Death cross' : longDiff > 0 ? '🟢 Above' : '🔴 Below';
      }
      
      console.log(`${coin.padEnd(9)}| ${shortDiff.toFixed(4).padStart(10)}| ${shortCross.padEnd(12)}| ${ema200 ? (ema50[ema50.length-1]-ema200[ema200.length-1]).toFixed(4).padStart(12)}| ${longSignal}`);
    } catch {}
  }
  
  console.log('\n  Golden cross (9 above 21): bullish short-term');
  console.log('  Death cross (9 below 21): bearish short-term');
  console.log('  Golden cross (50 above 200): bullish long-term');
  console.log('  Death cross (50 below 200): bearish long-term');
}
main().catch(console.error);
