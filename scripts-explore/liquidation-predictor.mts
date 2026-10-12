const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Liquidation Cascade Predictor ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const atRisk: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const maxLev = universe[i]?.maxLeverage || 10;
    
    if (oi < 10_000_000 || vol < 1_000_000) continue;
    
    // Risk factors:
    // 1. High OI/Vol ratio = overleveraged
    // 2. Extreme funding = one-sided market
    // 3. High max leverage = more liquidation risk
    
    const oiVolRatio = oi / vol;
    const fundingExtreme = Math.abs(funding) > 0.005;
    const highLeverage = maxLev >= 20;
    
    let riskScore = 0;
    if (oiVolRatio > 5) riskScore += 30;
    else if (oiVolRatio > 3) riskScore += 15;
    if (fundingExtreme) riskScore += 30;
    if (highLeverage) riskScore += 20;
    if (oi > 100_000_000) riskScore += 20;
    
    if (riskScore > 40) {
      atRisk.push({ name, oi, vol, funding, oiVolRatio, maxLev, riskScore, 
        direction: funding > 0 ? 'LONG liquidation risk' : 'SHORT liquidation risk' });
    }
  }
  
  atRisk.sort((a, b) => b.riskScore - a.riskScore);
  
  console.log('High liquidation risk perps:\n');
  console.log('Name     | Risk | OI $M    | Vol $M   | OI/Vol | Funding 1h   | Max Lev | Direction');
  console.log('─────────|──────|──────────|──────────|────────|──────────────|─────────|─────────────────────');
  for (const a of atRisk.slice(0, 10)) {
    console.log(`${a.name.padEnd(9)}| ${a.riskScore.toString().padStart(4)}| ${(a.oi/1e6).toFixed(1).padStart(8)}| ${(a.vol/1e6).toFixed(1).padStart(8)}| ${a.oiVolRatio.toFixed(2).padStart(6)}| ${(a.funding*100).toFixed(4).padStart(12)}%| ${a.maxLev.toString().padStart(7)}x| ${a.direction}`);
  }
  
  console.log('\n── Cascade Scenario ──\n');
  console.log('  If price drops 5% on high-risk perp:');
  console.log('    1. Leveraged longs get liquidated');
  console.log('    2. Liquidation sells push price down further');
  console.log('    3. More longs get liquidated (cascade)');
  console.log('    4. Funding spikes as shorts pile in');
  console.log('    5. Eventually: funding reverts, price stabilizes');
  console.log('');
  console.log('  Strategy: Monitor high-risk perps');
  console.log('    - If price starts dropping → short immediately');
  console.log('    - Exit when funding spread narrows');
  console.log('    - Or: wait for cascade, then long at bottom');
}
main().catch(console.error);
