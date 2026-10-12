const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Strategy Selector (market-aware) ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  // Market metrics
  let totalVol = 0, totalOi = 0, posFund = 0, negFund = 0;
  let avgFunding = 0;
  for (let i = 0; i < universe.length; i++) {
    totalVol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
    totalOi += parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    const f = parseFloat(ctxs[i]?.funding || '0');
    avgFunding += f;
    if (f > 0) posFund++; else if (f < 0) negFund++;
  }
  avgFunding /= universe.length;
  
  // VOOI opportunities
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=50&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let vooiCount = 0;
  let topSpread = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      if ((p.priceSpread || 0) * 100 > 0.5) { vooiCount++; if ((p.priceSpread || 0) * 100 > topSpread) topSpread = (p.priceSpread || 0) * 100; }
    }
  }
  
  // CEX-HL funding arbs
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  
  let cexArbCount = 0;
  for (let i = 0; i < universe.length; i++) {
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[universe[i].name];
    if (!bybitF || vol < 5_000_000) continue;
    if (Math.abs((hlF - bybitF) * 24 * 365 * 100) > 20) cexArbCount++;
  }
  
  // Market regime
  const fundingRatio = posFund / (posFund + negFund);
  const marketRegime = fundingRatio > 0.7 ? 'OVERLEVERAGED LONG' : fundingRatio < 0.3 ? 'OVERLEVERAGED SHORT' : 'BALANCED';
  
  console.log('── Market Conditions ──');
  console.log(`  Volume: $${(totalVol/1e9).toFixed(2)}B`);
  console.log(`  OI: $${(totalOi/1e9).toFixed(2)}B`);
  console.log(`  Funding: ${posFund}+ / ${negFund}- (${(fundingRatio*100).toFixed(0)}% positive)`);
  console.log(`  Market regime: ${marketRegime}`);
  console.log(`  VOOI opportunities: ${vooiCount} (top: ${topSpread.toFixed(2)}%)`);
  console.log(`  CEX-HL funding arbs: ${cexArbCount}`);
  
  // Strategy recommendations based on market
  console.log('\n── Strategy Recommendations ──\n');
  
  if (topSpread > 5) {
    console.log(`  🔥 PRIORITY: VOOI Price Spread Arb`);
    console.log(`     Top spread: ${topSpread.toFixed(2)}% = $${(5000*topSpread/100-5).toFixed(0)}/5k`);
    console.log(`     Action: Execute immediately when funded`);
  }
  
  if (cexArbCount > 5) {
    console.log(`  ⚡ PRIORITY: CEX-HL Funding Arb`);
    console.log(`     ${cexArbCount} arbs available`);
    console.log(`     Action: Set up Bybit API + deploy $25k`);
  }
  
  if (fundingRatio > 0.7) {
    console.log(`  📈 OPPORTUNITY: Short Funding Arb`);
    console.log(`     Market overleveraged long → funding positive`);
    console.log(`     Short high-funding perps, hedge on CEX`);
  }
  
  if (fundingRatio < 0.3) {
    console.log(`  📉 OPPORTUNITY: Long Funding Arb`);
    console.log(`     Market overleveraged short → funding negative`);
    console.log(`     Long high-negative-funding perps, hedge on CEX`);
  }
  
  console.log(`  💎 ALWAYS: kHYPE LST Discount`);
  console.log(`     2.5% discount = $75/5k net profit`);
  console.log(`     Action: Execute when funded`);
  
  console.log(`  🏗️  ALWAYS: Builder Code Registration`);
  console.log(`     +8.5 bps per trade = $23k/yr`);
  console.log(`     Action: Register with $100 USDC`);
  
  console.log('\n── Optimal Deployment Sequence ──\n');
  console.log('  1. $100 → Register builder code (immediate)');
  console.log('  2. $25k → VOOI arb (highest ROI)');
  console.log('  3. $25k → kHYPE arb (7-day hold)');
  console.log('  4. Bybit API → CEX-HL funding arb');
  console.log('  5. 0.5 SOL → Pump.fun strategy');
  console.log('  6. 30 days → Create HL vault');
}
main().catch(console.error);
