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
  console.log('  TECHNICAL ANALYSIS SUMMARY');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  
  console.log('Coin     | RSI  | MACD     | BB Position | VWAP Dev | Overall');
  console.log('─────────|──────|──────────|─────────────|──────────|────────');
  
  for (const coin of coins) {
    try {
      const candles = await hlInfo({
        type: 'candleSnapshot',
        req: { coin, interval: '1h', startTime: Date.now() - 72 * 60 * 60 * 1000 }
      });
      
      if (!Array.isArray(candles) || candles.length < 30) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      const current = closes[closes.length - 1];
      
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
      
      // Bollinger Bands
      const recent = closes.slice(-20);
      const sma = recent.reduce((s, x) => s + x, 0) / 20;
      const std = Math.sqrt(recent.reduce((s, x) => s + (x - sma) ** 2, 0) / 20);
      const bbPos = ((current - (sma - 2 * std)) / (4 * std) * 100);
      
      // VWAP
      let tv = 0, tn = 0;
      for (const c of candles.slice(-24)) { const v = parseFloat(c.v); tv += v; tn += v * parseFloat(c.c); }
      const vwap = tn / tv;
      const vwapDev = ((current - vwap) / vwap * 100);
      
      // Overall signal
      let bullish = 0, bearish = 0;
      if (rsi < 30) bullish++; if (rsi > 70) bearish++;
      if (macdHist > 0) bullish++; if (macdHist < 0) bearish++;
      if (bbPos < 10) bullish++; if (bbPos > 90) bearish++;
      if (vwapDev < -2) bullish++; if (vwapDev > 2) bearish++;
      
      const overall = bullish > bearish ? '🟢 BULL' : bearish > bullish ? '🔴 BEAR' : '⚪ FLAT';
      
      const rsiStr = rsi > 70 ? '🔴' : rsi < 30 ? '🟢' : '⚪';
      const macdStr = macdHist > 0 ? '🟢' : '🔴';
      const bbStr = bbPos > 90 ? '🔴' : bbPos < 10 ? '🟢' : '⚪';
      const vwapStr = vwapDev > 2 ? '🔴' : vwapDev < -2 ? '🟢' : '⚪';
      
      console.log(`${coin.padEnd(9)}| ${rsiStr}${rsi.toFixed(0).padStart(4)}| ${macdStr}${macdHist.toFixed(4).padStart(8)}| ${bbStr}${bbPos.toFixed(0).padStart(10)}%| ${vwapStr}${vwapDev.toFixed(1).padStart(7)}%| ${overall} (${bullish}↑/${bearish}↓)`);
    } catch {}
  }
}
main().catch(console.error);
