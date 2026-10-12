const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Funding Rate Predictor ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  console.log('Predicting funding direction based on:');
  console.log('  - Current funding rate');
  console.log('  - Open interest (high OI = funding likely to increase)');
  console.log('  - Volume (high volume = funding more volatile)');
  console.log('  - OI/Volume ratio (high ratio = overleveraged → funding spike likely)\n');
  
  const predictions: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const oi = parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    if (vol < 5_000_000) continue;
    
    const oiVolRatio = oi / vol;
    let prediction = 'STABLE';
    let confidence = 0;
    
    if (funding > 0.005 && oiVolRatio > 5) {
      prediction = 'FUNDING INCREASE 🔥';
      confidence = 80;
    } else if (funding > 0.003 && oiVolRatio > 3) {
      prediction = 'FUNDING INCREASE';
      confidence = 60;
    } else if (funding < -0.005 && oiVolRatio > 5) {
      prediction = 'FUNDING DECREASE ❄️';
      confidence = 80;
    } else if (funding < -0.003 && oiVolRatio > 3) {
      prediction = 'FUNDING DECREASE';
      confidence = 60;
    } else if (Math.abs(funding) < 0.001) {
      prediction = 'STABLE';
      confidence = 70;
    }
    
    predictions.push({ name, funding1h: funding * 100, annual: funding * 24 * 365 * 100, oiVolRatio, prediction, confidence, vol, oi });
  }
  
  predictions.sort((a, b) => b.confidence - a.confidence);
  console.log('Name       | Funding 1h | Annual%  | OI/Vol | Prediction           | Confidence');
  console.log('───────────|────────────|──────────|────────|──────────────────────|───────────');
  for (const p of predictions.slice(0, 15)) {
    console.log(`${p.name.padEnd(10)}| ${(p.funding1h).toFixed(4).padStart(10)}%| ${p.annual.toFixed(0).padStart(8)}%| ${p.oiVolRatio.toFixed(2).padStart(6)}| ${p.prediction.padEnd(20)}| ${p.confidence}%`);
  }
  
  console.log('\n  Strategy: Enter funding arb BEFORE predicted change');
  console.log('  If funding predicted to INCREASE → short now (earn more later)');
  console.log('  If funding predicted to DECREASE → long now (pay less later)');
}
main().catch(console.error);
