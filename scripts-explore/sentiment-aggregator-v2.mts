const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  MARKET SENTIMENT AGGREGATOR v2');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | Funding | OI/Vol | RSI    | VWAP Dev | Overall Sentiment');
  console.log('─────────|─────────|────────|────────|──────────|──────────────────');
  
  for (const coin of coins) {
    const idx = universe.findIndex(u => u.name === coin);
    if (idx < 0) continue;
    
    // Funding signal
    const funding = parseFloat(ctxs[idx]?.funding || '0');
    const fundSignal = funding > 0.003 ? '🔥' : funding < -0.003 ? '❄️' : '⚪';
    
    // OI/Vol signal
    const oi = parseFloat(ctxs[idx]?.openInterest || '0') * parseFloat(ctxs[idx]?.markPx || '0');
    const vol = parseFloat(ctxs[idx]?.dayNtlVlm || '0');
    const oiVol = vol > 0 ? oi / vol : 0;
    const oiSignal = oiVol > 5 ? '⚠️' : '✅';
    
    // RSI
    let rsi = 50;
    try {
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 } });
      if (Array.isArray(candles) && candles.length > 15) {
        const closes = candles.map(c => parseFloat(c.c));
        let g = 0, l = 0;
        for (let i = 1; i <= 14; i++) { const c = closes[i] - closes[i-1]; if (c > 0) g += c; else l -= c; }
        let ag = g / 14, al = l / 14;
        for (let i = 15; i < closes.length; i++) { const c = closes[i] - closes[i-1]; ag = (ag * 13 + (c > 0 ? c : 0)) / 14; al = (al * 13 + (c < 0 ? -c : 0)) / 14; }
        rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
    } catch {}
    const rsiSignal = rsi > 70 ? '🔴' : rsi < 30 ? '🟢' : '⚪';
    
    // VWAP deviation
    let vwapDev = 0;
    try {
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 86400000 } });
      if (Array.isArray(candles) && candles.length > 0) {
        let tv = 0, tn = 0;
        for (const c of candles) { const v = parseFloat(c.v); tv += v; tn += v * parseFloat(c.c); }
        const vwap = tn / tv;
        const current = parseFloat(ctxs[idx]?.markPx || '0');
        vwapDev = ((current - vwap) / vwap * 100);
      }
    } catch {}
    const vwapSignal = vwapDev > 2 ? '🔴' : vwapDev < -2 ? '🟢' : '⚪';
    
    // Overall sentiment (weighted)
    let score = 50;
    if (funding > 0.003) score -= 10; // High funding = overleveraged longs
    if (funding < -0.003) score += 10;
    if (rsi > 70) score -= 15;
    if (rsi < 30) score += 15;
    if (vwapDev > 2) score -= 10;
    if (vwapDev < -2) score += 10;
    if (oiVol > 5) score -= 5;
    score = Math.max(0, Math.min(100, score));
    
    const sentiment = score > 65 ? '🟢 BULLISH' : score < 35 ? '🔴 BEARISH' : '⚪ NEUTRAL';
    
    console.log(`${coin.padEnd(9)}| ${fundSignal}${(funding*100).toFixed(4)}%| ${oiSignal}${oiVol.toFixed(1)}x| ${rsiSignal}${rsi.toFixed(0).padStart(6)}| ${vwapSignal}${vwapDev.toFixed(2).padStart(7)}%| ${sentiment} (${score})`);
  }
  
  console.log('\n  Score: >65 bullish | <35 bearish | 35-65 neutral');
  console.log('  Weighted: RSI (30%) + VWAP (25%) + Funding (25%) + OI/Vol (20%)');
}
main().catch(console.error);
