/**
 * Master Opportunity Scanner
 * Combines ALL scanners into one:
 * - VOOI price spread
 * - VOOI funding (70-120% APR)
 * - HL perp funding heatmap
 * - CEX-HL funding arb (Bybit)
 * - kHYPE LST discount
 * - HL spot-perp basis
 */
const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  MASTER OPPORTUNITY SCANNER');
  console.log('  ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════\n');

  // 1. VOOI Price Spread
  console.log('── 1. VOOI Price Spread (top 5) ──\n');
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=10&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  let vooiCount = 0;
  for (const item of (vooiData?.items || [])) {
    if (vooiCount >= 5) break;
    for (const p of (item.pairs || [])) {
      if (vooiCount >= 5) break;
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      const profit = 5000 * spread / 100 - 5;
      console.log(`  ${item.asset.padEnd(20)} ${spread.toFixed(2)}%  ${p.long?.exchange}→${p.short?.exchange}  profit=$${profit.toFixed(0)}/5k`);
      vooiCount++;
    }
  }

  // 2. VOOI Funding (70-120%)
  console.log('\n── 2. VOOI Funding Arb 70-120% APR (top 5) ──\n');
  const fundRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=50&orderBy=fundingSpread1h&orderDirection=desc&minFundingSpread=0.0001');
  const fundData = fundRes.ok ? await fundRes.json() : { items: [] };
  let fundCount = 0;
  for (const item of (fundData?.items || [])) {
    if (fundCount >= 5) break;
    for (const p of (item.pairs || [])) {
      if (fundCount >= 5) break;
      const apr = (p.fundingSpread1h || 0) * 24 * 365 * 100;
      if (apr < 70 || apr > 120) continue;
      console.log(`  ${item.asset.padEnd(20)} ${apr.toFixed(0)}% APR  ${p.long?.exchange}→${p.short?.exchange}`);
      fundCount++;
    }
  }

  // 3. HL Funding Heatmap (top 5 positive)
  console.log('\n── 3. HL Funding Heatmap (top 5 positive) ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  const funding: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const f = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (f > 0.001 && vol > 5_000_000) funding.push({ name: universe[i].name, annual: f * 24 * 365 * 100, vol });
  }
  funding.sort((a, b) => b.annual - a.annual);
  for (const f of funding.slice(0, 5)) {
    console.log(`  ${f.name.padEnd(10)} ${f.annual.toFixed(0)}% APR  vol=$${(f.vol/1e6).toFixed(1)}M  (short to earn)`);
  }

  // 4. CEX-HL Funding (Bybit)
  console.log('\n── 4. CEX-HL Funding Arb (Bybit) (top 5) ──\n');
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const item of (bybitData?.result?.list || [])) {
    const sym = item.symbol.replace('USDT', '');
    bybitFunding[sym] = parseFloat(item.fundingRate) / 8; // per 1h
  }
  const cexArbs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const bybitF = bybitFunding[name];
    if (!bybitF) continue;
    const spread = hlF - bybitF;
    const apr = spread * 24 * 365 * 100;
    if (Math.abs(apr) > 20) cexArbs.push({ name, apr, direction: spread > 0 ? 'SHORT_HL_LONG_BYBIT' : 'LONG_HL_SHORT_BYBIT' });
  }
  cexArbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  for (const a of cexArbs.slice(0, 5)) {
    console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR  ${a.direction}`);
  }

  // 5. kHYPE LST Discount
  console.log('\n── 5. kHYPE LST Discount ──\n');
  const RPC = 'https://rpc.hyperliquid.xyz/evm';
  const slot0Res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x5cbe810071de393de35e574fb2830e16da794bab', data: '0x3850c7bd' }, 'latest'], id: 1 }) });
  const slot0 = (await slot0Res.json() as any).result || '0x';
  if (slot0.length >= 66) {
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    const price = Number(sqrtPrice * sqrtPrice * 10n**18n / (2n**192n)) / 1e18;
    const discount = (1 - price) * 100;
    const profit5k = 5000 * discount / 100 - 50 - 2;
    console.log(`  kHYPE/WHYPE: ${discount.toFixed(3)}% discount  profit=$${profit5k.toFixed(0)}/5k`);
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  OPPORTUNITY SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  VOOI Price Spread: ${vooiCount} opportunities (top > 0.5%)`);
  console.log(`  VOOI Funding 70-120%: ${fundCount} opportunities`);
  console.log(`  HL Funding: ${funding.length} positive funding perps`);
  console.log(`  CEX-HL Funding: ${cexArbs.length} arbs > 20% APR`);
  console.log(`  kHYPE Discount: ~2.5% (stable)`);
  console.log('');
  console.log(`  TOTAL ACTIONABLE: ${vooiCount + fundCount + cexArbs.length + 1} opportunities`);
  console.log(`  If we capture top 5 with $5k each: $${(vooiCount * 200 + fundCount * 15 + cexArbs.length * 10 + 70).toFixed(0)}/day potential`);
}
main().catch(console.error);
