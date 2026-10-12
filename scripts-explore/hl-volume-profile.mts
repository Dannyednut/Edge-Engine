const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Volume Profile ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  const perps = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    const funding = parseFloat(ctxs[i]?.funding || '0');
    if (vol > 0) perps.push({ name, vol, oi, funding, volOiRatio: vol > 0 && oi > 0 ? oi / vol : 0 });
  }
  perps.sort((a, b) => b.vol - a.vol);
  let totalVol = perps.reduce((s, p) => s + p.vol, 0);
  console.log(`Total 24h volume: $${(totalVol/1e9).toFixed(2)}B\n`);
  console.log('Top 20 by volume:');
  console.log('Name       | Vol $M     | OI $M      | OI/Vol  | Funding 1h');
  console.log('───────────|────────────|────────────|─────────|───────────');
  for (const p of perps.slice(0, 20)) {
    console.log(`${p.name.padEnd(10)}| ${(p.vol/1e6).toFixed(1).padStart(10)}| ${(p.oi/1e6).toFixed(1).padStart(10)}| ${p.volOiRatio.toFixed(2).padStart(7)}| ${(p.funding*100).toFixed(4)}%`);
  }
  // Volume concentration
  const top5Vol = perps.slice(0, 5).reduce((s, p) => s + p.vol, 0);
  console.log(`\n  Top 5 concentration: ${(top5Vol/totalVol*100).toFixed(1)}% of total volume`);
  console.log(`  Top 10 concentration: ${(perps.slice(0,10).reduce((s,p)=>s+p.vol,0)/totalVol*100).toFixed(1)}% of total volume`);
}
main().catch(console.error);
