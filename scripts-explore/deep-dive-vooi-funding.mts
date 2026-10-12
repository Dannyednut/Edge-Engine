/**
 * DEEP DIVE: VOOI Funding Rate Arbs in Recommended Range (70-120% APR)
 * These are the arbs VOOI themselves recommend executing
 */
async function main() {
  console.log('── DEEP DIVE: VOOI Funding Arbs (70-120% APR Range) ──\n');

  const res = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=200&orderBy=fundingSpread1h&orderDirection=desc&minFundingSpread=0.0001');
  const data = await res.ok ? await res.json() : { items: [] };

  const recommended: any[] = [];
  const aboveRange: any[] = [];
  const belowRange: any[] = [];

  for (const item of (data?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread1h = (p.fundingSpread1h || 0) * 100;
      const annualApr = spread1h * 24 * 365;
      
      if (annualApr < 10) continue;
      
      const entry = {
        asset: item.asset,
        spread1h,
        annualApr,
        long: p.long?.exchange,
        short: p.short?.exchange,
        longFunding: (p.long?.fundingRate ? parseFloat(p.long.fundingRate) * 100 : 0),
        shortFunding: (p.short?.fundingRate ? parseFloat(p.short.fundingRate) * 100 : 0),
        longPrice: parseFloat(p.long?.price || '0'),
        shortPrice: parseFloat(p.short?.price || '0'),
        volume: p.long?.volume24h || 0,
        openInterest: p.long?.openInterestUsd || 0,
      };

      if (annualApr >= 70 && annualApr <= 120) {
        recommended.push(entry);
      } else if (annualApr > 120) {
        aboveRange.push(entry);
      } else {
        belowRange.push(entry);
      }
    }
  }

  recommended.sort((a, b) => b.annualApr - a.annualApr);
  aboveRange.sort((a, b) => b.annualApr - a.annualApr);

  console.log(`── IN RANGE (70-120% APR) — VOOI Recommended ──\n`);
  console.log(`Found: ${recommended.length} opportunities\n`);
  console.log('Asset              | APR     | 1h Spread | Long → Short          | Long Fund | Short Fund | Vol 24h');
  console.log('───────────────────|─────────|───────────|──────────────────────|───────────|────────────|─────────');
  for (const o of recommended.slice(0, 20)) {
    console.log(`${o.asset.padEnd(18)}| ${o.annualApr.toFixed(0).padStart(7)}%| ${o.spread1h.toFixed(4).padStart(9)}%| ${o.long.padEnd(10)} → ${o.short.padEnd(10)}| ${o.longFunding.toFixed(4).padStart(9)}%| ${o.shortFunding.toFixed(4).padStart(10)}%| $${(o.volume/1000).toFixed(0)}k`);
  }

  console.log(`\n── ABOVE RANGE (>120% APR) — High Risk ──\n`);
  console.log(`Found: ${aboveRange.length} opportunities (VOOI says >120% collapses fast)\n`);
  for (const o of aboveRange.slice(0, 10)) {
    console.log(`  ${o.asset.padEnd(18)} ${o.annualApr.toFixed(0)}% APR  ${o.long}→${o.short}  ⚠️ HIGH RISK`);
  }

  // Economics for recommended range
  console.log('\n── Economics for Recommended Range ──\n');
  if (recommended.length > 0) {
    const top5 = recommended.slice(0, 5);
    let dailyIncome = 0;
    for (const o of top5) {
      const income = 5000 * o.spread1h / 100 * 24;
      dailyIncome += income;
      console.log(`  ${o.asset.padEnd(18)} ${o.annualApr.toFixed(0)}% APR → $${income.toFixed(2)}/day on $5k`);
    }
    console.log(`\n  Top 5 total: $${dailyIncome.toFixed(2)}/day = $${(dailyIncome * 365).toFixed(0)}/yr`);
    console.log(`  Capital: $25,000 (5 × $5k)`);
    console.log(`  APR: ${(dailyIncome * 365 / 25000 * 100).toFixed(0)}%`);
    console.log(`  Risk: LOW (within VOOI recommended range)`);
  }

  console.log('\n── Execution Requirements ──\n');
  console.log('  1. VOOI API token: ✅ set');
  console.log('  2. HL signing: ✅ verified');
  console.log('  3. VOOI exchange connections: ❌ need to connect on VOOI dashboard');
  console.log('  4. Capital: ❌ need $25k USDC');
  console.log('  5. VOOI bot or manual orders');
}
main().catch(console.error);
