const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Market Regime Detector ──\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | ADX   | Regime      | Trend Strength');
  console.log('─────────|───────|─────────────|───────────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 20) continue;
      
      // Calculate ADX (simplified)
      const period = 14;
      const high = candles.map(c => parseFloat(c.h));
      const low = candles.map(c => parseFloat(c.l));
      const close = candles.map(c => parseFloat(c.c));
      
      // True Range
      const tr: number[] = [];
      for (let i = 1; i < candles.length; i++) {
        tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i-1]), Math.abs(low[i] - close[i-1]));
      }
      
      // +DM and -DM
      const plusDM: number[] = [0];
      const minusDM: number[] = [0];
      for (let i = 1; i < candles.length; i++) {
        const upMove = high[i] - high[i-1];
        const downMove = low[i-1] - low[i];
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
      }
      
      // Smooth
      const smooth = (arr: number[], p: number) => {
        const result: number[] = [arr.slice(0, p).reduce((s, x) => s + x, 0)];
        for (let i = p; i < arr.length; i++) result.push(result[result.length - 1] - result[result.length - 1] / p + arr[i]);
        return result;
      };
      
      const atr = smooth(tr, period);
      const plusDM_sm = smooth(plusDM.slice(1), period);
      const minusDM_sm = smooth(minusDM.slice(1), period);
      
      // +DI and -DI
      const plusDI: number[] = [];
      const minusDI: number[] = [];
      for (let i = 0; i < Math.min(atr.length, plusDM_sm.length, minusDM_sm.length); i++) {
        plusDI.push(atr[i] > 0 ? 100 * plusDM_sm[i] / atr[i] : 0);
        minusDI.push(atr[i] > 0 ? 100 * minusDM_sm[i] / atr[i] : 0);
      }
      
      // DX and ADX
      const dx: number[] = [];
      for (let i = 0; i < plusDI.length; i++) {
        const sum = plusDI[i] + minusDI[i];
        dx.push(sum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / sum : 0);
      }
      const adx = smooth(dx, period);
      const currentADX = adx[adx.length - 1] || 25;
      
      let regime = '';
      let strength = '';
      if (currentADX > 40) { regime = '📈 STRONG TREND'; strength = 'Very strong'; }
      else if (currentADX > 25) { regime = '📈 Trending'; strength = 'Strong'; }
      else if (currentADX > 20) { regime = '➡️ Weak trend'; strength = 'Weak'; }
      else { regime = '↔️ Ranging'; strength = 'No trend'; }
      
      console.log(`${coin.padEnd(9)}| ${currentADX.toFixed(1).padStart(5)}| ${regime.padEnd(11)}| ${strength}`);
    } catch {}
  }
  
  console.log('\n  ADX > 40: very strong trend (follow trend)');
  console.log('  ADX 25-40: trending (trend-following works)');
  console.log('  ADX 20-25: weak trend (be cautious)');
  console.log('  ADX < 20: ranging (mean reversion works)');
}
main().catch(console.error);
