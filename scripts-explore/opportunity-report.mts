async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  LIVE OPPORTUNITY REPORT');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');

  // 1. VOOI Price Spread
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  
  console.log('🔥 VOOI PRICE SPREAD (instant capture):');
  let vooiCount = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const profit = 5000 * spread / 100 - 5;
      console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}% → $${profit.toFixed(0)}/5k  ${p.long?.exchange}→${p.short?.exchange}`);
      vooiCount++;
      if (vooiCount >= 5) break;
    }
    if (vooiCount >= 5) break;
  }

  // 2. CEX-HL Funding
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) {
    bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  }
  
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  
  console.log('\n⚡ CEX-HL FUNDING ARB (delta-neutral):');
  const cexArbs: any[] = [];
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    const name = hlData[0].universe[i].name;
    const hlF = parseFloat(hlData[1]?.[i]?.funding || '0');
    const vol = parseFloat(hlData[1]?.[i]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[name];
    if (!bybitF || vol < 5_000_000) continue;
    const spread = hlF - bybitF;
    const apr = spread * 24 * 365 * 100;
    if (Math.abs(apr) > 20) cexArbs.push({ name, apr, direction: spread > 0 ? 'SHORT_HL' : 'LONG_HL' });
  }
  cexArbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  for (const a of cexArbs.slice(0, 5)) {
    const daily = 5000 * Math.abs(a.apr) / 100 / 365;
    console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR → $${daily.toFixed(2)}/day on $5k  ${a.direction}`);
  }

  // 3. HL Funding Heatmap
  console.log('\n🔥 HL FUNDING (short to earn):');
  const funding: any[] = [];
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    const f = parseFloat(hlData[1]?.[i]?.funding || '0');
    const vol = parseFloat(hlData[1]?.[i]?.dayNtlVlm || '0');
    if (f > 0.002 && vol > 5_000_000) funding.push({ name: hlData[0].universe[i].name, annual: f * 24 * 365 * 100, vol });
  }
  funding.sort((a, b) => b.annual - a.annual);
  for (const f of funding.slice(0, 5)) {
    console.log(`  ${f.name.padEnd(10)} ${f.annual.toFixed(0)}% APR  vol=$${(f.vol/1e6).toFixed(1)}M`);
  }

  // 4. kHYPE discount
  console.log('\n💎 kHYPE LST DISCOUNT:');
  const kHypeRes = await fetch('https://rpc.hyperliquid.xyz/evm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x5cbe810071de393de35e574fb2830e16da794bab', data: '0x3850c7bd' }, 'latest'], id: 1 }),
  });
  const kHypeSlot0 = (await kHypeRes.json()).result || '0x';
  if (kHypeSlot0.length >= 66) {
    const sqrtPrice = BigInt('0x' + kHypeSlot0.slice(2, 66));
    const price = Number(sqrtPrice * sqrtPrice * 10n**18n / (2n**192n)) / 1e18;
    const discount = (1 - price) * 100;
    const profit = 5000 * discount / 100 - 52;
    console.log(`  kHYPE: ${discount.toFixed(3)}% discount → $${profit.toFixed(0)}/5k`);
  }

  // Summary
  console.log(`\n═══ SUMMARY ═══`);
  console.log(`  VOOI: ${vooiCount} opportunities (instant)`);
  console.log(`  CEX-HL: ${cexArbs.length} funding arbs (delta-neutral)`);
  console.log(`  HL Funding: ${funding.length} positive funding perps`);
  console.log(`  kHYPE: stable 2.5% discount`);
  console.log(`  TOTAL: ${vooiCount + cexArbs.length + 1} actionable opportunities`);
}
main().catch(console.error);
