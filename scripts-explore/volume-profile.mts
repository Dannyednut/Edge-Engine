const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Volume Profile (24h, 1h candles) ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 5) continue;
      
      // Build volume-at-price bins
      const bins: Record<string, number> = {};
      let totalVol = 0;
      for (const c of candles) {
        const vol = parseFloat(c.v);
        const o = parseFloat(c.o), cl = parseFloat(c.c);
        const mid = (o + cl) / 2;
        // Round to nearest meaningful price level
        const bin = coin === 'BTC' ? Math.round(mid / 100) * 100 : coin === 'ETH' ? Math.round(mid) : Math.round(mid * 100) / 100;
        const key = String(bin);
        bins[key] = (bins[key] || 0) + vol;
        totalVol += vol;
      }
      
      // Find POC (Point of Control) = highest volume price
      let poc = '', pocVol = 0;
      for (const [price, vol] of Object.entries(bins)) {
        if (vol > pocVol) { pocVol = vol; poc = price; }
      }
      
      // Value Area (70% of volume around POC)
      const sortedBins = Object.entries(bins).sort((a, b) => b[1] - a[1]);
      let cumVol = 0;
      const valueArea: string[] = [];
      for (const [price, vol] of sortedBins) {
        cumVol += vol;
        valueArea.push(price);
        if (cumVol >= totalVol * 0.7) break;
      }
      
      const current = parseFloat(candles[candles.length - 1].c);
      const pocPrice = parseFloat(poc);
      const devFromPOC = ((current - pocPrice) / pocPrice * 100);
      
      console.log(`${coin.padEnd(6)} POC=$${pocPrice.toFixed(2)} current=$${current.toFixed(2)} dev=${devFromPOC.toFixed(2)}% totalVol=${totalVol.toFixed(0)}`);
    } catch {}
  }
  
  console.log('\n  POC = Price with highest volume (most traded level)');
  console.log('  Current > POC: above value area (potential resistance)');
  console.log('  Current < POC: below value area (potential support)');
}
main().catch(console.error);
