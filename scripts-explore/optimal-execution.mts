const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Optimal Execution Calculator ──\n');
  
  // Get VOOI opportunities
  const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=20&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
  const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
  
  // Get HL market data
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const results: any[] = [];
  
  for (const item of (vooiData?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spread = (p.priceSpread || 0) * 100;
      if (spread < 0.5) continue;
      
      // Check if HL is one of the venues
      const isHL = p.long?.exchange === 'hyperliquid' || p.short?.exchange === 'hyperliquid';
      
      // Get HL depth
      let hlDepth = 0;
      let hlSpread = 0;
      if (isHL) {
        try {
          const book = await hlInfo({ type: 'l2Book', coin: item.asset.replace('alias:', '') });
          const levels = book?.levels || [];
          const bids = levels[0] || [];
          const asks = levels[1] || [];
          for (const b of bids.slice(0, 10)) hlDepth += parseFloat(b.sz) * parseFloat(b.px);
          for (const a of asks.slice(0, 10)) hlDepth += parseFloat(a.sz) * parseFloat(a.px);
          if (asks[0] && bids[0]) hlSpread = ((parseFloat(asks[0].px) - parseFloat(bids[0].px)) / parseFloat(bids[0].px) * 100);
        } catch {}
      }
      
      // Calculate optimal size (use 10% of depth)
      const maxSize = Math.min(25000, hlDepth * 0.1);
      const profit = maxSize * spread / 100 - maxSize * 0.001; // 0.1% fees
      const netSpread = spread - 0.1 - hlSpread * 2; // fees + 2x spread cost
      
      results.push({
        asset: item.asset,
        spread,
        longVenue: p.long?.exchange,
        shortVenue: p.short?.exchange,
        isHL,
        hlDepth,
        hlSpread,
        maxSize,
        profit,
        netSpread,
        priceSpreadAtSize: p.priceSpreadAtSize ? (p.priceSpreadAtSize * 100) : spread,
      });
    }
  }
  
  results.sort((a, b) => b.profit - a.profit);
  
  console.log('Top 10 by profit potential:\n');
  console.log('Asset              | Spread | HL Depth | Max Size | Profit $   | Net Spread | Score');
  console.log('───────────────────|────────|──────────|──────────|────────────|────────────|──────');
  for (const r of results.slice(0, 10)) {
    const score = r.profit * (r.isHL ? 1 : 0.5);
    console.log(`${r.asset.padEnd(19)}| ${r.spread.toFixed(2).padStart(6)}%| $${(r.hlDepth/1000).toFixed(0).padStart(7)}k| $${r.maxSize.toFixed(0).padStart(8)}| $${r.profit.toFixed(0).padStart(10)}| ${r.netSpread.toFixed(2).padStart(10)}%| ${score.toFixed(0)}`);
  }
  
  console.log('\n  Max Size = 10% of HL order book depth (minimize slippage)');
  console.log('  Profit = Max Size × Spread - Fees');
  console.log('  Score = Profit × (1 if HL is venue, 0.5 if not)');
}
main().catch(console.error);
