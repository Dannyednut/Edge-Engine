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

async function analyzeCoin(coin: string, candles: any[], current: number, funding: number) {
  const closes = candles.map(c => parseFloat(c.c));
  
  // RSI (14)
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) { const c = closes[i] - closes[i-1]; if (c > 0) g += c; else l -= c; }
  let ag = g / 14, al = l / 14;
  for (let i = 15; i < closes.length; i++) { const c = closes[i] - closes[i-1]; ag = (ag * 13 + (c > 0 ? c : 0)) / 14; al = (al * 13 + (c < 0 ? -c : 0)) / 14; }
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  
  // MACD (12/26/9)
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signalLine = ema(macdLine, 9);
  const macd = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  
  // Bollinger (20, 2σ)
  const recent = closes.slice(-20);
  const sma = recent.reduce((s, x) => s + x, 0) / 20;
  const std = Math.sqrt(recent.reduce((s, x) => s + (x - sma) ** 2, 0) / 20);
  const bbPos = ((current - (sma - 2 * std)) / (4 * std) * 100);
  
  // VWAP (24h)
  let tv = 0, tn = 0;
  for (const c of candles.slice(-24)) { const v = parseFloat(c.v); tv += v; tn += v * parseFloat(c.c); }
  const vwap = tn / tv;
  const vwapDev = ((current - vwap) / vwap * 100);
  
  // ATR (14)
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = parseFloat(candles[i].h), l = parseFloat(candles[i].l), pc = parseFloat(candles[i-1].c);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, 14).reduce((s, x) => s + x, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  const atrPct = (atr / current * 100);
  
  // Stochastic (14, 3, 3)
  const kVals: number[] = [];
  for (let i = 13; i < closes.length; i++) {
    const slice = candles.slice(i - 13, i + 1);
    const h = Math.max(...slice.map(c => parseFloat(c.h)));
    const l = Math.min(...slice.map(c => parseFloat(c.l)));
    kVals.push(h === l ? 50 : ((closes[i] - l) / (h - l) * 100));
  }
  const sk: number[] = [];
  for (let i = 2; i < kVals.length; i++) sk.push(kVals.slice(i - 2, i + 1).reduce((s, x) => s + x, 0) / 3);
  const sd: number[] = [];
  for (let i = 2; i < sk.length; i++) sd.push(sk.slice(i - 2, i + 1).reduce((s, x) => s + x, 0) / 3);
  const stochK = sk[sk.length - 1];
  const stochD = sd[sd.length - 1];
  
  // Overall score
  let bull = 0, bear = 0;
  if (rsi < 30) bull += 2; if (rsi > 70) bear += 2;
  if (macd > 0) bull++; if (macd < 0) bear++;
  if (bbPos < 10) bull += 2; if (bbPos > 90) bear += 2;
  if (vwapDev < -2) bull++; if (vwapDev > 2) bear++;
  if (stochK < 20) bull += 2; if (stochK > 80) bear += 2;
  if (funding > 0.005) bear++; if (funding < -0.005) bull++;
  
  const score = (bull - bear);
  const signal = score > 3 ? '🟢 STRONG BUY' : score > 0 ? '🟢 BUY' : score < -3 ? '🔴 STRONG SELL' : score < 0 ? '🔴 SELL' : '⚪ NEUTRAL';
  
  return { rsi, macd, bbPos, vwapDev, atrPct, stochK, stochD, score, signal };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  COMPLETE TA TOOLKIT — All Indicators');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC'];
  
  console.log('Coin     | RSI  | MACD    | BB%  | VWAP% | ATR%  | Stoch%K | Signal');
  console.log('─────────|──────|─────────|──────|───────|───────|─────────|──────────────');
  
  for (const coin of coins) {
    try {
      const idx = universe.findIndex(u => u.name === coin);
      if (idx < 0) continue;
      
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 72 * 60 * 60 * 1000 } });
      if (!Array.isArray(candles) || candles.length < 30) continue;
      
      const current = parseFloat(ctxs[idx]?.markPx || '0');
      const funding = parseFloat(ctxs[idx]?.funding || '0');
      
      const ta = await analyzeCoin(coin, candles, current, funding);
      
      console.log(`${coin.padEnd(9)}| ${ta.rsi.toFixed(0).padStart(4)}| ${ta.macd.toFixed(4).padStart(7)}| ${ta.bbPos.toFixed(0).padStart(4)}| ${ta.vwapDev.toFixed(1).padStart(5)}| ${ta.atrPct.toFixed(2).padStart(5)}| ${ta.stochK.toFixed(0).padStart(7)}| ${ta.signal}`);
    } catch {}
  }
  
  console.log('\n  Indicators: RSI(14) + MACD(12/26/9) + BB(20,2σ) + VWAP(24h) + ATR(14) + Stochastic(14,3,3)');
  console.log('  Score: >3 strong buy | >0 buy | <0 sell | <-3 strong sell');
}
main().catch(console.error);
