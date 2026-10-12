const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  MARKET INTELLIGENCE DASHBOARD');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');

  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];

  // 1. Market overview
  let totalVol = 0, totalOi = 0, posFund = 0, negFund = 0;
  for (let i = 0; i < universe.length; i++) {
    totalVol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    totalOi += oi;
    const f = parseFloat(ctxs[i]?.funding || '0');
    if (f > 0) posFund++; else if (f < 0) negFund++;
  }
  console.log('── Market Overview ──');
  console.log(`  Total perps: ${universe.length}`);
  console.log(`  24h volume: $${(totalVol/1e9).toFixed(2)}B`);
  console.log(`  Open interest: $${(totalOi/1e9).toFixed(2)}B`);
  console.log(`  Positive funding: ${posFund} | Negative: ${negFund}`);

  // 2. Top movers (by absolute daily change)
  console.log('\n── Top Movers (by |24h change|) ──');
  const movers: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const change = parseFloat(ctxs[i]?.midDayPctChange || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol > 1_000_000 && change !== 0) movers.push({ name, change, vol });
  }
  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  for (const m of movers.slice(0, 5)) {
    const emoji = m.change > 0 ? '🟢' : '🔴';
    console.log(`  ${emoji} ${m.name.padEnd(10)} ${m.change.toFixed(2)}%  vol=$${(m.vol/1e6).toFixed(1)}M`);
  }

  // 3. Highest funding rates
  console.log('\n── Highest Funding Rates ──');
  const funding: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const f = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (f > 0.002 && vol > 5_000_000) funding.push({ name: universe[i].name, funding1h: f * 100, annual: f * 24 * 365 * 100, vol });
  }
  funding.sort((a, b) => b.annual - a.annual);
  for (const f of funding.slice(0, 5)) {
    console.log(`  🔥 ${f.name.padEnd(10)} ${f.funding1h.toFixed(4)}%/h = ${f.annual.toFixed(0)}%/yr  vol=$${(f.vol/1e6).toFixed(1)}M`);
  }

  // 4. VOOI opportunities summary
  console.log('\n── VOOI Opportunities ──');
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let count = 0;
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      if (count < 3) {
        console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}%  ${p.long?.exchange}→${p.short?.exchange}`);
      }
      count++;
    }
  }
  console.log(`  ... and ${count - 3} more`);

  // 5. CEX funding arb
  console.log('\n── CEX-HL Funding Arb (top 3) ──');
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) {
    bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  }
  const cexArbs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[name];
    if (!bybitF || vol < 5_000_000) continue;
    const spread = hlF - bybitF;
    const apr = spread * 24 * 365 * 100;
    if (Math.abs(apr) > 20) cexArbs.push({ name, apr, direction: spread > 0 ? 'SHORT_HL' : 'LONG_HL' });
  }
  cexArbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  for (const a of cexArbs.slice(0, 3)) {
    console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR  ${a.direction}`);
  }
}
main().catch(console.error);
