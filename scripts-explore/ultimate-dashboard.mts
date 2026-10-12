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
  console.log('  ULTIMATE TRADING DASHBOARD');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  // 1. Market overview
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  let totalVol = 0, totalOi = 0;
  for (let i = 0; i < universe.length; i++) {
    totalVol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
    totalOi += parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
  }
  console.log(`Market: ${universe.length} perps | Vol: $${(totalVol/1e9).toFixed(2)}B | OI: $${(totalOi/1e9).toFixed(2)}B\n`);
  
  // 2. Top opportunities
  console.log('── VOOI Price Spread (top 3) ──');
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=5&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let vc = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      if (vc >= 3) break;
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}% → $${(5000*spread/100-5).toFixed(0)}/5k`);
      vc++;
    }
  }
  
  // 3. CEX-HL funding
  console.log('\n── CEX-HL Funding (top 3) ──');
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  const cexArbs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[name];
    if (!bybitF || vol < 5_000_000) continue;
    const apr = (hlF - bybitF) * 24 * 365 * 100;
    if (Math.abs(apr) > 20) cexArbs.push({ name, apr });
  }
  cexArbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  for (const a of cexArbs.slice(0, 3)) {
    console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR → $${(5000*Math.abs(a.apr)/100/365).toFixed(2)}/day on $5k`);
  }
  
  // 4. kHYPE
  console.log('\n── kHYPE LST ──');
  const kHypeRes = await fetch('https://rpc.hyperliquid.xyz/evm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x5cbe810071de393de35e574fb2830e16da794bab', data: '0x3850c7bd' }, 'latest'], id: 1 }),
  });
  const kHypeSlot0 = (await kHypeRes.json()).result || '0x';
  if (kHypeSlot0.length >= 66) {
    const sqrtPrice = BigInt('0x' + kHypeSlot0.slice(2, 66));
    const price = Number(sqrtPrice * sqrtPrice * 10n**18n / (2n**192n)) / 1e18;
    console.log(`  Discount: ${((1-price)*100).toFixed(3)}% → $${(5000*(1-price)-52).toFixed(0)}/5k net`);
  }
  
  // 5. Technical signals
  console.log('\n── Technical Signals ──');
  const taCoins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR'];
  for (const coin of taCoins) {
    try {
      const idx = universe.findIndex(u => u.name === coin);
      if (idx < 0) continue;
      const candles = await hlInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 48 * 60 * 60 * 1000 } });
      if (!Array.isArray(candles) || candles.length < 30) continue;
      
      const closes = candles.map(c => parseFloat(c.c));
      const current = closes[closes.length - 1];
      const funding = parseFloat(ctxs[idx]?.funding || '0');
      
      // RSI
      let g = 0, l = 0;
      for (let i = 1; i <= 14; i++) { const c = closes[i] - closes[i-1]; if (c > 0) g += c; else l -= c; }
      let ag = g / 14, al = l / 14;
      for (let i = 15; i < closes.length; i++) { const c = closes[i] - closes[i-1]; ag = (ag * 13 + (c > 0 ? c : 0)) / 14; al = (al * 13 + (c < 0 ? -c : 0)) / 14; }
      const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      
      // MACD
      const e12 = ema(closes, 12), e26 = ema(closes, 26);
      const macdLine = e12.map((v, i) => v - e26[i]);
      const signalLine = ema(macdLine, 9);
      const macd = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
      
      // VWAP
      let tv = 0, tn = 0;
      for (const c of candles.slice(-24)) { const v = parseFloat(c.v); tv += v; tn += v * parseFloat(c.c); }
      const vwap = tn / tv;
      const vwapDev = ((current - vwap) / vwap * 100);
      
      // Signal
      let bull = 0, bear = 0;
      if (rsi < 30) bull += 2; if (rsi > 70) bear += 2;
      if (macd > 0) bull++; if (macd < 0) bear++;
      if (vwapDev < -2) bull++; if (vwapDev > 2) bear++;
      if (funding > 0.005) bear++; if (funding < -0.005) bull++;
      
      const sig = bull > bear + 1 ? '🟢 BUY' : bear > bull + 1 ? '🔴 SELL' : '⚪ NEUTRAL';
      console.log(`  ${coin.padEnd(6)} RSI=${rsi.toFixed(0)} MACD=${macd > 0 ? '+' : ''}${macd.toFixed(4)} VWAP=${vwapDev.toFixed(1)}% Fund=${(funding*100).toFixed(4)}% → ${sig}`);
    } catch {}
  }
  
  // 6. Summary
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  VOOI: ${vc}+ opportunities`);
  console.log(`  CEX-HL: ${cexArbs.length} funding arbs`);
  console.log(`  kHYPE: 2.5% discount (stable)`);
  console.log(`  TOTAL: ${vc + cexArbs.length + 1}+ actionable`);
}
main().catch(console.error);
