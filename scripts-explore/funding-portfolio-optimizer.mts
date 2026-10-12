const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Funding Arb Portfolio Optimizer ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const bybitData = bybitRes.ok ? await bybitRes.json() : { result: { list: [] } };
  const bybitFunding: Record<string, number> = {};
  for (const t of (bybitData?.result?.list || [])) bybitFunding[t.symbol.replace('USDT', '')] = parseFloat(t.fundingRate) / 8;
  
  // Get 30-day funding history for reliability score
  const arbs: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name;
    const hlF = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const bybitF = bybitFunding[name];
    if (!bybitF || vol < 5_000_000) continue;
    
    const spread = hlF - bybitF;
    const apr = spread * 24 * 365 * 100;
    if (Math.abs(apr) < 15) continue;
    
    // Get 30-day funding history
    try {
      const history = await hlInfo({ type: 'fundingHistory', coin: name, startTime: Date.now() - 30 * 24 * 60 * 60 * 1000, endTime: Date.now() });
      let posHours = 0;
      if (Array.isArray(history)) {
        for (const h of history) { if (parseFloat(h.fundingRate || h.deltaRate || '0') > 0) posHours++; }
      }
      const reliability = history.length > 0 ? posHours / history.length * 100 : 50;
      const score = reliability * Math.abs(apr) / 100;
      
      arbs.push({ name, apr, reliability, score, vol, daily: 5000 * Math.abs(apr) / 100 / 365 });
    } catch {}
  }
  
  arbs.sort((a, b) => b.score - a.score);
  
  // Optimal allocation: proportional to score
  const totalScore = arbs.reduce((s, x) => s + x.score, 0);
  const totalCapital = 25000;
  
  console.log('Optimal Portfolio ($25k capital, proportional to score):\n');
  console.log('Name     | APR%  | Reliability | Score | Allocation | Daily $   | Annual $');
  console.log('─────────|───────|─────────────|──────|────────────|───────────|──────────');
  
  let totalDaily = 0;
  for (const a of arbs.slice(0, 10)) {
    const allocation = totalCapital * a.score / totalScore;
    const daily = allocation * Math.abs(a.apr) / 100 / 365;
    const annual = allocation * Math.abs(a.apr) / 100;
    totalDaily += daily;
    console.log(`${a.name.padEnd(9)}| ${a.apr.toFixed(0).padStart(5)}| ${a.reliability.toFixed(0).padStart(11)}%| ${a.score.toFixed(1).padStart(5)}| $${allocation.toFixed(0).padStart(10)}| $${daily.toFixed(2).padStart(9)}| $${annual.toFixed(0).padStart(8)}`);
  }
  
  console.log(`\n  Total daily income: $${totalDaily.toFixed(2)}`);
  console.log(`  Total annual income: $${(totalDaily * 365).toFixed(0)}`);
  console.log(`  Blended APR: ${(totalDaily * 365 / totalCapital * 100).toFixed(1)}%`);
  console.log(`  Average reliability: ${(arbs.slice(0, 10).reduce((s, x) => s + x.reliability, 0) / Math.min(10, arbs.length)).toFixed(0)}%`);
}
main().catch(console.error);
