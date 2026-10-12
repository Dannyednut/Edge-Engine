const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Funding Rate Spread Monitor (2 scans, 60s) ──\n');
  
  for (let scan = 1; scan <= 2; scan++) {
    const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
    const universe = meta?.[0]?.universe || [];
    const ctxs = meta?.[1] || [];
    
    const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
    const bybitF: Record<string, number> = {};
    for (const t of (bybitData?.result?.list || [])) bybitF[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
    
    const arbs: any[] = [];
    for (let i = 0; i < universe.length; i++) {
      const hlF = parseFloat(ctxs[i]?.funding || '0');
      const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
      const bF = bybitF[universe[i].name];
      if (!bF || vol < 5_000_000) continue;
      const apr = (hlF - bF) * 24 * 365 * 100;
      if (Math.abs(apr) > 20) arbs.push({ name: universe[i].name, apr });
    }
    arbs.sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr));
    
    console.log(`Scan ${scan} (${new Date().toISOString().substring(11, 19)}): ${arbs.length} arbs > 20% APR`);
    for (const a of arbs.slice(0, 5)) console.log(`  ${a.name.padEnd(10)} ${a.apr.toFixed(0)}% APR`);
    console.log('');
    
    if (scan < 2) await new Promise(r => setTimeout(r, 60_000));
  }
}
main().catch(console.error);
