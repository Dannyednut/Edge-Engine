const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Price Action Scanner (1h candles, 24h) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'ZEC', 'GRASS', 'ONDO', 'ZRO', 'LTC', 'SUI', 'DOGE', 'AVAX', 'LINK', 'BNB'];
  
  const results: any[] = [];
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 10) continue;
      
      const prices = candles.map(c => parseFloat(c.c));
      const volumes = candles.map(c => parseFloat(c.v));
      const high = Math.max(...candles.map(c => parseFloat(c.h)));
      const low = Math.min(...candles.map(c => parseFloat(c.l)));
      const first = parseFloat(candles[0].o);
      const last = prices[prices.length - 1];
      const change = ((last - first) / first * 100);
      const range = ((high - low) / low * 100);
      const avgVol = volumes.reduce((s, v) => s + v, 0) / volumes.length;
      const lastVol = volumes[volumes.length - 1];
      const volSpike = lastVol / avgVol;
      
      // Support/resistance
      const support = low;
      const resistance = high;
      const position = ((last - support) / (resistance - support) * 100);
      
      results.push({ coin, change, range, volSpike, position, last, support, resistance });
    } catch {}
  }
  
  // Sort by volatility (range)
  results.sort((a, b) => b.range - a.range);
  
  console.log('Coin     | 24h Change | Range %  | Vol Spike | Position in Range | Support $   | Resistance $');
  console.log('─────────|────────────|──────────|───────────|───────────────────|─────────────|─────────────');
  for (const r of results) {
    const pos = r.position > 80 ? '🔝 Near resistance' : r.position < 20 ? '🔽 Near support' : `${r.position.toFixed(0)}%`;
    console.log(`${r.coin.padEnd(9)}| ${r.change.toFixed(2).padStart(9)}%| ${r.range.toFixed(2).padStart(8)}%| ${r.volSpike.toFixed(2).padStart(9)}x| ${pos.padEnd(17)}| $${r.support.toFixed(2).padStart(11)}| $${r.resistance.toFixed(2).padStart(11)}`);
  }
  
  console.log('\n── Trading Signals ──\n');
  console.log('  Near support → BUY signal');
  console.log('  Near resistance → SELL signal');
  console.log('  High vol spike → breakout/momentum');
  console.log('  Wide range → more arb opportunity');
}
main().catch(console.error);
