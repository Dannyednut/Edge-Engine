const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Funding Rate Heatmap ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];

  const positive: any[] = [];
  const negative: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    if (funding === 0 || vol < 500_000) continue;
    const annual = funding * 24 * 365 * 100;
    const entry = { name, funding1h: funding * 100, annual, vol, oi };
    if (funding > 0) positive.push(entry);
    else negative.push(entry);
  }
  positive.sort((a, b) => b.annual - a.annual);
  negative.sort((a, b) => a.annual - b.annual);

  console.log('🔥 HIGH POSITIVE FUNDING (short to earn):');
  console.log('  Name       | 1h%      | Annual%  | Vol $M  | OI $M');
  console.log('  ───────────|──────────|──────────|─────────|──────');
  for (const f of positive.slice(0, 15)) {
    const heat = f.annual > 100 ? '🔥🔥🔥' : f.annual > 50 ? '🔥🔥' : f.annual > 20 ? '🔥' : '';
    console.log(`  ${f.name.padEnd(10)}| ${f.funding1h.toFixed(4).padStart(8)}%| ${f.annual.toFixed(0).padStart(8)}%| ${(f.vol/1e6).toFixed(1).padStart(7)}| ${(f.oi/1e6).toFixed(1).padStart(5)} ${heat}`);
  }

  console.log('\n❄️  HIGH NEGATIVE FUNDING (long to earn):');
  console.log('  Name       | 1h%      | Annual%  | Vol $M  | OI $M');
  console.log('  ───────────|──────────|──────────|─────────|──────');
  for (const f of negative.slice(0, 10)) {
    const heat = f.annual < -100 ? '❄️❄️❄️' : f.annual < -50 ? '❄️❄️' : f.annual < -20 ? '❄️' : '';
    console.log(`  ${f.name.padEnd(10)}| ${f.funding1h.toFixed(4).padStart(8)}%| ${f.annual.toFixed(0).padStart(8)}%| ${(f.vol/1e6).toFixed(1).padStart(7)}| ${(f.oi/1e6).toFixed(1).padStart(5)} ${heat}`);
  }

  console.log(`\n  Total positive funding: ${positive.length}`);
  console.log(`  Total negative funding: ${negative.length}`);
  console.log(`  Total: ${positive.length + negative.length} perps with non-zero funding`);
}
main().catch(console.error);
