const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  COMPLETE MARKET ANALYSIS SUITE');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  let totalVol = 0, totalOi = 0;
  for (let i = 0; i < universe.length; i++) {
    totalVol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
    totalOi += parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
  }
  console.log(`Market: ${universe.length} perps | Vol: $${(totalVol/1e9).toFixed(2)}B | OI: $${(totalOi/1e9).toFixed(2)}B`);
  
  // Top 5 by volume
  const top: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 10_000_000) top.push({ name: universe[i].name, vol, oi: parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0'), funding: parseFloat(ctxs[i]?.funding || '0') });
  }
  top.sort((a, b) => b.vol - a.vol);
  console.log('\nTop 5 by Volume:');
  for (const t of top.slice(0, 5)) {
    const apr = t.funding * 24 * 365 * 100;
    console.log(`  ${t.name.padEnd(8)} vol=$${(t.vol/1e6).toFixed(0)}M oi=$${(t.oi/1e6).toFixed(0)}M fund=${apr.toFixed(0)}%/yr`);
  }
  
  // VOOI
  console.log('\nVOOI (top 3):');
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=5&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let vc = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      if (vc >= 3) break;
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}% ${p.long?.exchange}→${p.short?.exchange}`);
      vc++;
    }
  }
  
  // CEX-HL
  console.log('\nCEX-HL (top 3):');
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitF: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitF[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  const cexArbs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const bF = bybitF[universe[i].name];
    if (!bF || vol < 5_000_000) continue;
    const apr = (hlF - bF) * 24 * 365 * 100;
    if (Math.abs(apr) > 20) cexArbs.push({ name: universe[i].name, apr });
  }
  cexArbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  for (const a of cexArbs.slice(0, 3)) console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR`);
  
  // kHYPE
  console.log('\nkHYPE:');
  const kRes = await fetch('https://rpc.hyperliquid.xyz/evm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x5cbe810071de393de35e574fb2830e16da794bab', data: '0x3850c7bd' }, 'latest'], id: 1 }),
  });
  const kSlot0 = (await kRes.json()).result || '0x';
  if (kSlot0.length >= 66) {
    const sq = BigInt('0x' + kSlot0.slice(2, 66));
    const p = Number(sq * sq * 10n**18n / (2n**192n)) / 1e18;
    console.log(`  Discount: ${((1-p)*100).toFixed(3)}%`);
  }
  
  console.log(`\nTotal: ${vc}+${cexArbs.length}+1 = ${vc + cexArbs.length + 1}+ actionable`);
}
main().catch(console.error);
