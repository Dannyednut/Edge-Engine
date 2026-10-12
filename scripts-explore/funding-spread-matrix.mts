const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Funding Rate Spread Matrix ──\n');
  
  // Get HL funding
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  // Get Bybit funding
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  
  // Get Binance funding
  const binRes = await fetch('https://fapi.binance.com/fapi/v1/premiumRate');
  const binData = binRes.ok ? await binRes.json() : [];
  const binFunding: Record<string, number> = {};
  for (const t of binData) { const sym = t.symbol.replace('USDT', ''); binFunding[sym] = parseFloat(t.lastFundingRate) / 8; }
  
  // Build matrix
  const spreads: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (vol < 5_000_000) continue;
    
    const bybitF = bybitFunding[name];
    const binF = binFunding[name];
    
    if (bybitF) {
      const spread = hlF - bybitF;
      const apr = spread * 24 * 365 * 100;
      if (Math.abs(apr) > 10) {
        spreads.push({ name, venue: 'Bybit', hlF, cexF: bybitF, apr, vol });
      }
    }
    if (binF) {
      const spread = hlF - binF;
      const apr = spread * 24 * 365 * 100;
      if (Math.abs(apr) > 10) {
        spreads.push({ name, venue: 'Binance', hlF, cexF: binF, apr, vol });
      }
    }
  }
  
  spreads.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
  
  console.log(`Found ${spreads.length} funding arb opportunities (>10% APR)\n`);
  console.log('Name     | Venue   | HL 1h%   | CEX 1h%  | Spread 1h | Annual%  | Daily $/5k');
  console.log('─────────|─────────|──────────|──────────|───────────|──────────|───────────');
  for (const s of spreads.slice(0, 20)) {
    const dir = s.apr > 0 ? 'SHORT_HL' : 'LONG_HL';
    const daily = 5000 * Math.abs(s.apr) / 100 / 365;
    console.log(`${s.name.padEnd(9)}| ${s.venue.padEnd(9)}| ${(s.hlF*100).toFixed(4).padStart(8)}%| ${(s.cexF*100).toFixed(4).padStart(8)}%| ${((s.hlF-s.cexF)*100).toFixed(4).padStart(9)}%| ${s.apr.toFixed(0).padStart(8)}%| $${daily.toFixed(2)}`);
  }
  
  console.log('\n  Positive APR: SHORT HL (earn funding) + LONG CEX (pay less)');
  console.log('  Negative APR: LONG HL (earn funding) + SHORT CEX (pay less)');
}
main().catch(console.error);
