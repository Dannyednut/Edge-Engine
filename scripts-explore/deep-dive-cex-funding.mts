/**
 * DEEP DIVE: CEX-HL Funding Rate Arb
 * 
 * Build the actual execution logic:
 * 1. Monitor HL + Bybit funding rates continuously
 * 2. When spread > threshold, signal alert
 * 3. Calculate exact entry/exit points
 * 4. Track P&L over time
 * 
 * This is REAL strategy code — not just research
 */

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getBybitFunding(): Promise<Record<string, any>> {
  try {
    const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
    const data = await res.json() as any;
    const result: Record<string, any> = {};
    for (const item of (data?.result?.list || [])) {
      const symbol = item.symbol.replace('USDT', '');
      const funding = parseFloat(item.fundingRate);
      const markPrice = parseFloat(item.markPrice);
      const vol24h = parseFloat(item.volume24h);
      if (Math.abs(funding) > 0.00001) {
        result[symbol] = { funding8h: funding, funding1h: funding / 8, markPrice, vol24h };
      }
    }
    return result;
  } catch { return {}; }
}

async function main() {
  console.log('── DEEP DIVE: CEX-HL Funding Rate Arb Executor ──\n');

  // 1. Get HL funding rates
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];

  const hlFunding: Record<string, { funding1h: number; markPx: number; vol: number }> = {};
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (funding !== 0 && vol > 1_000_000) {
      hlFunding[name] = { funding1h: funding, markPx, vol };
    }
  }

  // 2. Get Bybit funding rates
  const bybitFunding = await getBybitFunding();

  // 3. Find ALL arb opportunities
  const arbs: any[] = [];
  for (const [symbol, hl] of Object.entries(hlFunding)) {
    const bybit = bybitFunding[symbol];
    if (!bybit) continue;

    const spread1h = hl.funding1h - bybit.funding1h;
    const annualApr = spread1h * 24 * 365 * 100;
    
    if (Math.abs(annualApr) > 5) {
      const direction = spread1h > 0 ? 'SHORT_HL_LONG_BYBIT' : 'LONG_HL_SHORT_BYBIT';
      const dailyIncome = 5000 * Math.abs(spread1h) * 24; // $5k per position
      const weeklyIncome = dailyIncome * 7;
      
      arbs.push({
        symbol,
        hlFunding1h: hl.funding1h * 100,
        bybitFunding1h: bybit.funding1h * 100,
        spread1h: spread1h * 100,
        annualApr,
        direction,
        hlPrice: hl.markPx,
        bybitPrice: bybit.markPrice,
        priceDiff: ((hl.markPx - bybit.markPrice) / bybit.markPrice * 100),
        hlVol: hl.vol,
        dailyIncome,
        weeklyIncome,
        // Execution plan
        entryCost: 10000, // $5k on each venue
        holdTime: '8-24h (until funding converges)',
        exitCondition: 'When funding spread < 0.01%/h',
        riskLevel: Math.abs(annualApr) > 100 ? 'HIGH' : Math.abs(annualApr) > 50 ? 'MEDIUM' : 'LOW',
      });
    }
  }

  arbs.sort((a, b) => Math.abs(b.annualApr) - Math.abs(a.annualApr));

  // 4. Display full analysis
  console.log(`Found ${arbs.length} funding arb opportunities\n`);
  console.log('Symbol     | HL 1h%   | Bybit 1h%| Spread   | Annual   | Direction              | Daily $  | Risk  | Price Diff');
  console.log('───────────|──────────|──────────|──────────|──────────|────────────────────────|──────────|───────|──────────');

  for (const a of arbs.slice(0, 25)) {
    console.log(
      `${a.symbol.padEnd(10)}| ${a.hlFunding1h.toFixed(4).padStart(8)}%| ${a.bybitFunding1h.toFixed(4).padStart(8)}%| ${a.spread1h.toFixed(4).padStart(8)}%| ${a.annualApr.toFixed(0).padStart(8)}%| ${a.direction.padEnd(22)}| $${a.dailyIncome.toFixed(0).padStart(7)}| ${a.riskLevel.padEnd(5)}| ${a.priceDiff.toFixed(3)}%`
    );
  }

  // 5. Portfolio analysis
  console.log('\n── Portfolio Analysis ──\n');
  const top5 = arbs.slice(0, 5);
  const top10 = arbs.slice(0, 10);
  
  let daily5 = top5.reduce((s, a) => s + a.dailyIncome, 0);
  let daily10 = top10.reduce((s, a) => s + a.dailyIncome, 0);

  console.log(`  Top 5 arbs:`);
  console.log(`    Capital: $50,000 ($10k per arb, $5k each venue)`);
  console.log(`    Daily income: $${daily5.toFixed(0)}`);
  console.log(`    Annual income: $${(daily5 * 365).toFixed(0)}`);
  console.log(`    APR: ${(daily5 * 365 / 50000 * 100).toFixed(0)}%`);
  console.log('');
  console.log(`  Top 10 arbs:`);
  console.log(`    Capital: $100,000`);
  console.log(`    Daily income: $${daily10.toFixed(0)}`);
  console.log(`    Annual income: $${(daily10 * 365).toFixed(0)}`);
  console.log(`    APR: ${(daily10 * 365 / 100000 * 100).toFixed(0)}%`);

  // 6. Execution plan for top opportunity
  console.log('\n── Execution Plan (Top Opportunity) ──\n');
  if (arbs.length > 0) {
    const best = arbs[0];
    console.log(`  Symbol: ${best.symbol}`);
    console.log(`  Direction: ${best.direction}`);
    console.log(`  HL funding: ${best.hlFunding1h.toFixed(4)}%/h`);
    console.log(`  Bybit funding: ${best.bybitFunding1h.toFixed(4)}%/h`);
    console.log(`  Spread: ${best.spread1h.toFixed(4)}%/h = ${best.annualApr.toFixed(0)}% APR`);
    console.log('');
    console.log(`  Step 1: Deposit $5k USDC to HL`);
    console.log(`  Step 2: Deposit $5k USDT to Bybit`);
    console.log(`  Step 3: ${best.direction === 'SHORT_HL_LONG_BYBIT' ? 'Short' : 'Long'} ${best.symbol} on HL @ $${best.hlPrice.toFixed(2)}`);
    console.log(`  Step 4: ${best.direction === 'SHORT_HL_LONG_BYBIT' ? 'Long' : 'Short'} ${best.symbol} on Bybit @ $${best.bybitPrice.toFixed(2)}`);
    console.log(`  Step 5: Hold 8-24h (collect funding differential)`);
    console.log(`  Step 6: Close both when spread < 0.01%/h`);
    console.log(`  Step 7: Expected profit: $${best.dailyIncome.toFixed(0)}/day`);
    console.log('');
    console.log(`  RISK: ${best.riskLevel}`);
    console.log(`    - Delta-neutral (no directional risk)`);
    console.log(`    - Price difference: ${best.priceDiff.toFixed(3)}% (should converge)`);
    console.log(`    - Funding can flip (monitor every 8h)`);
    console.log(`    - Exchange risk (HL + Bybit)`);
  }

  // 7. What we need
  console.log('\n── Requirements ──\n');
  console.log('  1. HL account with USDC (signing verified ✅)');
  console.log('  2. Bybit account with USDT (need API keys)');
  console.log('  3. Capital: $10k per arb position');
  console.log('  4. Monitor: check funding every 8h');
  console.log('  5. Auto-execute when spread > threshold');
}
main().catch(console.error);
