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
  console.log('═══════════════════════════════════════════════════');
  console.log('  TRADE SIGNAL GENERATOR');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO', 'ZRO', 'LTC', 'SUI', 'DOGE', 'AVAX', 'LINK', 'BNB'];
  
  const signals: any[] = [];
  
  for (const coin of coins) {
    try {
      const idx = universe.findIndex(u => u.name === coin);
      if (idx < 0) continue;
      
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 72 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 30) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      const current = closes[closes.length - 1];
      const funding = parseFloat(ctxs[idx]?.funding || '0');
      const vol = parseFloat(ctxs[idx]?.dayNtlVlm || '0');
      const oi = parseFloat(ctxs[idx]?.openInterest || '0') * parseFloat(ctxs[idx]?.markPx || '0');
      
      // RSI
      let g = 0, l = 0;
      for (let i = 1; i <= 14; i++) { const c = closes[i] - closes[i-1]; if (c > 0) g += c; else l -= c; }
      let ag = g / 14, al = l / 14;
      for (let i = 15; i < closes.length; i++) { const c = closes[i] - closes[i-1]; ag = (ag * 13 + (c > 0 ? c : 0)) / 14; al = (al * 13 + (c < 0 ? -c : 0)) / 14; }
      const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      
      // MACD
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      const macdLine = ema12.map((v, i) => v - ema26[i]);
      const signalLine = ema(macdLine, 9);
      const macdHist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
      const prevMacdHist = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
      const macdBullCross = macdHist > 0 && prevMacdHist <= 0;
      const macdBearCross = macdHist < 0 && prevMacdHist >= 0;
      
      // Bollinger
      const recent = closes.slice(-20);
      const sma = recent.reduce((s, x) => s + x, 0) / 20;
      const std = Math.sqrt(recent.reduce((s, x) => s + (x - sma) ** 2, 0) / 20);
      const bbPos = ((current - (sma - 2 * std)) / (4 * std) * 100);
      
      // VWAP
      let tv = 0, tn = 0;
      for (const c of candles.slice(-24)) { const v = parseFloat(c.v); tv += v; tn += v * parseFloat(c.c); }
      const vwap = tn / tv;
      const vwapDev = ((current - vwap) / vwap * 100);
      
      // Generate signals
      const actions: string[] = [];
      if (rsi < 30) actions.push('RSI oversold → BUY');
      if (rsi > 70) actions.push('RSI overbought → SELL');
      if (macdBullCross) actions.push('MACD bullish cross → BUY');
      if (macdBearCross) actions.push('MACD bearish cross → SELL');
      if (bbPos < 10) actions.push('BB lower band → BUY');
      if (bbPos > 90) actions.push('BB upper band → SELL');
      if (vwapDev < -3) actions.push('Below VWAP → BUY');
      if (vwapDev > 3) actions.push('Above VWAP → SELL');
      if (funding > 0.005) actions.push('High funding → SHORT (earn)');
      if (funding < -0.005) actions.push('Negative funding → LONG (earn)');
      
      if (actions.length > 0) {
        signals.push({ coin, rsi, macdHist, bbPos, vwapDev, funding, vol, oi, actions });
      }
    } catch {}
  }
  
  if (signals.length === 0) {
    console.log('  No actionable signals detected');
  } else {
    console.log(`Found ${signals.length} perps with actionable signals:\n`);
    for (const s of signals) {
      console.log(`── ${s.coin} ──`);
      console.log(`  RSI: ${s.rsi.toFixed(0)} | MACD: ${s.macdHist.toFixed(4)} | BB: ${s.bbPos.toFixed(0)}% | VWAP: ${s.vwapDev.toFixed(1)}% | Funding: ${(s.funding*100).toFixed(4)}%/h`);
      for (const a of s.actions) {
        console.log(`  → ${a}`);
      }
      console.log('');
    }
  }
  
  console.log('── Funding Arb Signals ──\n');
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  
  for (const coin of coins) {
    const idx = universe.findIndex(u => u.name === coin);
    if (idx < 0) continue;
    const hlF = parseFloat(ctxs[idx]?.funding || '0');
    const vol = parseFloat(ctxs[idx]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[coin];
    if (!bybitF || vol < 5_000_000) continue;
    const apr = (hlF - bybitF) * 24 * 365 * 100;
    if (Math.abs(apr) > 30) {
      const dir = apr > 0 ? 'SHORT HL / LONG BYBIT' : 'LONG HL / SHORT BYBIT';
      console.log(`  ${coin.padEnd(8)} ${apr.toFixed(0)}% APR → ${dir} ($${(5000*Math.abs(apr)/100/365).toFixed(2)}/day on $5k)`);
    }
  }
}
main().catch(console.error);
