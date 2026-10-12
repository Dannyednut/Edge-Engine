const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL MARKET SNAPSHOT — ' + new Date().toISOString().substring(11, 19));
  console.log('═══════════════════════════════════════════════════\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  let totalVol = 0, totalOi = 0, posFund = 0, negFund = 0;
  for (let i = 0; i < universe.length; i++) {
    totalVol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
    totalOi += parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    const f = parseFloat(ctxs[i]?.funding || '0');
    if (f > 0) posFund++; else if (f < 0) negFund++;
  }
  
  console.log(`Markets: ${universe.length} | Vol: $${(totalVol/1e9).toFixed(2)}B | OI: $${(totalOi/1e9).toFixed(2)}B | Fund: ${posFund}+/${negFund}-`);
  
  // Top 5 by volume
  const top: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 10_000_000) top.push({ name: universe[i].name, vol, oi: parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0'), funding: parseFloat(ctxs[i]?.funding || '0') });
  }
  top.sort((a, b) => b.vol - a.vol);
  
  console.log('\nTop 5:');
  for (const t of top.slice(0, 5)) {
    const fund = t.funding > 0 ? `+${(t.funding*24*365*100).toFixed(0)}%` : `${(t.funding*24*365*100).toFixed(0)}%`;
    console.log(`  ${t.name.padEnd(8)} vol=$${(t.vol/1e6).toFixed(0)}M oi=$${(t.oi/1e6).toFixed(0)}M fund=${fund}`);
  }
  
  // VOOI top
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=3&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  console.log('\nVOOI top:');
  for (const item of (vooiData?.items || []).slice(0, 3)) {
    for (const p of (item.pairs || []).slice(0, 1)) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      console.log(`  ${item.asset.padEnd(15)} ${spread.toFixed(2)}% ${p.long?.exchange}→${p.short?.exchange}`);
    }
  }
}
main().catch(console.error);
