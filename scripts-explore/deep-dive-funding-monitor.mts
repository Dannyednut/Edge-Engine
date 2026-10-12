/**
 * DEEP DIVE: Real-time CEX-HL Funding Arb Monitor
 * Continuously monitors funding rates and alerts on opportunities
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
      if (Math.abs(funding) > 0.00001) {
        result[symbol] = { funding8h: funding, funding1h: funding / 8, markPrice: parseFloat(item.markPrice) };
      }
    }
    return result;
  } catch { return {}; }
}

async function main() {
  console.log('── DEEP DIVE: Real-time Funding Arb Monitor (3 scans) ──\n');

  for (let scan = 1; scan <= 3; scan++) {
    console.log(`\n═══ Scan ${scan} — ${new Date().toISOString()} ═══\n`);

    // Get HL funding
    const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
    const universe = meta?.[0]?.universe || [];
    const ctxs = meta?.[1] || [];
    
    const hlFunding: Record<string, { funding1h: number; markPx: number }> = {};
    for (let i = 0; i < universe.length; i++) {
      const name = universe[i].name || '';
      const funding = parseFloat(ctxs[i]?.funding || '0');
      const markPx = parseFloat(ctxs[i]?.markPx || '0');
      const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
      if (funding !== 0 && vol > 5_000_000) {
        hlFunding[name] = { funding1h: funding, markPx };
      }
    }

    // Get Bybit funding
    const bybitFunding = await getBybitFunding();

    // Find arbs
    const arbs: any[] = [];
    for (const [symbol, hl] of Object.entries(hlFunding)) {
      const bybit = bybitFunding[symbol];
      if (!bybit) continue;
      const spread1h = hl.funding1h - bybit.funding1h;
      const annualApr = spread1h * 24 * 365 * 100;
      if (Math.abs(annualApr) > 20) {
        arbs.push({
          symbol,
          hlFunding: hl.funding1h * 100,
          bybitFunding: bybit.funding1h * 100,
          spread1h: spread1h * 100,
          annualApr,
          direction: spread1h > 0 ? 'SHORT_HL_LONG_BYBIT' : 'LONG_HL_SHORT_BYBIT',
        });
      }
    }
    arbs.sort((a, b) => Math.abs(b.annualApr) - Math.abs(a.annualApr));

    console.log(`Found ${arbs.length} arbs > 20% APR\n`);
    console.log('Symbol     | HL 1h%   | Bybit 1h%| Spread   | APR     | Direction');
    console.log('───────────|──────────|──────────|──────────|─────────|─────────────────────────');
    for (const a of arbs.slice(0, 10)) {
      console.log(`${a.symbol.padEnd(10)}| ${a.hlFunding.toFixed(4).padStart(8)}%| ${a.bybitFunding.toFixed(4).padStart(8)}%| ${a.spread1h.toFixed(4).padStart(8)}%| ${a.annualApr.toFixed(0).padStart(7)}%| ${a.direction}`);
    }

    if (scan < 3) {
      console.log('\n  Waiting 60s for next scan...');
      await new Promise(r => setTimeout(r, 60_000));
    }
  }

  console.log('\n── Monitor Complete ──\n');
  console.log('  Funding rates change every 8 hours (Bybit) and hourly (HL)');
  console.log('  Monitor continuously to catch spread spikes');
  console.log('  Best execution: when spread > 100% APR, enter immediately');
}
main().catch(console.error);
