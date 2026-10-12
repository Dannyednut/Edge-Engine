const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Liquidation History (24h) ──\n');
  // Try different API methods to find liquidations
  const methods = [
    { type: 'liquidationHistory', startTime: Date.now() - 24*60*60*1000 },
    { type: 'liquidations', startTime: Date.now() - 24*60*60*1000 },
    { type: 'allLiquidations', startTime: Date.now() - 24*60*60*1000 },
  ];
  for (const m of methods) {
    try {
      const result = await hlInfo(m);
      if (Array.isArray(result) && result.length > 0) {
        console.log(`Method ${m.type}: ${result.length} events`);
        let totalVol = 0;
        for (const l of result.slice(0, 10)) {
          const px = parseFloat(l.markPx || l.px || '0');
          const sz = Math.abs(parseFloat(l.szi || l.sz || '0'));
          const notional = px * sz;
          totalVol += notional;
          console.log(`  ${l.coin || '?'} ${parseFloat(l.szi||l.sz||'0') > 0 ? 'LONG' : 'SHORT'} sz=${sz} px=$${px} notional=$${notional.toFixed(0)}`);
        }
        console.log(`\n  Total liquidated (24h): $${(totalVol/1e6).toFixed(1)}M`);
        console.log(`  Estimated liquidator bonus (1.5%): $${(totalVol * 0.015 / 1e6).toFixed(1)}M`);
        break;
      } else {
        console.log(`Method ${m.type}: no data or error`);
      }
    } catch (e: any) {
      console.log(`Method ${m.type}: ${e.message?.substring(0, 80)}`);
    }
  }
}
main().catch(console.error);
