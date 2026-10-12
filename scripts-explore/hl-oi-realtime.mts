const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Open Interest Monitor ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  const perps: any[] = [];
  let totalOi = 0;
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const oi = parseFloat(ctxs[i]?.openInterest || '0');
    const px = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oiUsd = oi * px;
    if (oiUsd > 1_000_000) {
      perps.push({ name, oi: oiUsd, vol, funding: parseFloat(ctxs[i]?.funding || '0') });
      totalOi += oiUsd;
    }
  }
  perps.sort((a, b) => b.oi - a.oi);
  console.log(`Total OI: $${(totalOi/1e9).toFixed(2)}B\n`);
  console.log('Name       | OI $M      | Vol $M     | Funding 1h   | OI/Vol Ratio');
  console.log('───────────|────────────|────────────|──────────────|────────────');
  for (const p of perps.slice(0, 20)) {
    const ratio = p.vol > 0 ? p.oi / p.vol : 0;
    console.log(`${p.name.padEnd(10)}| ${(p.oi/1e6).toFixed(1).padStart(10)}| ${(p.vol/1e6).toFixed(1).padStart(10)}| ${(p.funding*100).toFixed(4).padStart(12)}%| ${ratio.toFixed(2).padStart(10)}`);
  }
  console.log(`\n  High OI/Vol ratio = overleveraged (potential liquidation cascade)`);
  console.log(`  Low OI/Vol ratio = healthy turnover`);
}
main().catch(console.error);
