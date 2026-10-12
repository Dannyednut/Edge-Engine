const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL VWAP Calculator (24h) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO'];
  
  console.log('Coin     | VWAP $     | Current $  | Deviation | Signal');
  console.log('─────────|────────────|────────────|───────────|───────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length === 0) continue;
      
      let totalVolume = 0;
      let totalNotional = 0;
      for (const c of candles) {
        const vol = parseFloat(c.v);
        const close = parseFloat(c.c);
        totalVolume += vol;
        totalNotional += vol * close;
      }
      
      const vwap = totalNotional / totalVolume;
      const current = parseFloat(candles[candles.length - 1].c);
      const deviation = ((current - vwap) / vwap * 100);
      const signal = deviation > 2 ? '🔴 Above VWAP (overbought)' : deviation < -2 ? '🟢 Below VWAP (oversold)' : '⚪ Near VWAP (fair)';
      
      console.log(`${coin.padEnd(9)}| $${vwap.toFixed(2).padStart(10)}| $${current.toFixed(2).padStart(10)}| ${deviation.toFixed(2).padStart(9)}%| ${signal}`);
    } catch {}
  }
  
  console.log('\n  Above VWAP → potential sell (overbought)');
  console.log('  Below VWAP → potential buy (oversold)');
  console.log('  Near VWAP → fair value');
}
main().catch(console.error);
