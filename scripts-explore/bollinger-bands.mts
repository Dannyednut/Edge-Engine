const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Bollinger Bands (20-period, 2σ, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO'];
  
  console.log('Coin     | Upper $    | Middle $   | Lower $    | Current $  | Position');
  console.log('─────────|────────────|────────────|────────────|────────────|──────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 22) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      const period = 20;
      const recent = closes.slice(-period);
      
      const sma = recent.reduce((s, x) => s + x, 0) / period;
      const variance = recent.reduce((s, x) => s + (x - sma) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      
      const upper = sma + 2 * std;
      const lower = sma - 2 * std;
      const current = closes[closes.length - 1];
      
      const position = ((current - lower) / (upper - lower) * 100);
      let posStr = '';
      if (position > 90) posStr = '🔝 Above upper (overbought)';
      else if (position < 10) posStr = '🔽 Below lower (oversold)';
      else posStr = `${position.toFixed(0)}% in bands`;
      
      console.log(`${coin.padEnd(9)}| $${upper.toFixed(2).padStart(10)}| $${sma.toFixed(2).padStart(10)}| $${lower.toFixed(2).padStart(10)}| $${current.toFixed(2).padStart(10)}| ${posStr}`);
    } catch {}
  }
  
  console.log('\n  Above upper band: overbought (potential sell)');
  console.log('  Below lower band: oversold (potential buy)');
  console.log('  In middle: fair value');
}
main().catch(console.error);
