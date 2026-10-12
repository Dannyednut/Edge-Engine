const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Slippage Estimator ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W', 'NEAR', 'GRASS', 'ONDO'];
  const orderSizes = [1000, 5000, 10000, 25000, 50000];
  
  for (const coin of coins) {
    try {
      const idx = universe.findIndex(u => u.name === coin);
      if (idx < 0) continue;
      const markPx = parseFloat(ctxs[idx]?.markPx || '0');
      if (markPx <= 0) continue;
      
      const book = await hlInfo({ type: 'l2Book', coin });
      const levels = book?.levels || [];
      const asks = levels[1] || [];
      
      console.log(`── ${coin} (mark: $${markPx.toFixed(2)}) ──`);
      
      for (const sizeUsd of orderSizes) {
        // Walk the order book to estimate slippage
        let remaining = sizeUsd;
        let totalQty = 0;
        let weightedPrice = 0;
        for (const ask of asks) {
          const askPx = parseFloat(ask.px);
          const askSz = parseFloat(ask.sz);
          const availableUsd = askSz * askPx;
          if (remaining <= 0) break;
          const takeUsd = Math.min(remaining, availableUsd);
          const takeSz = takeUsd / askPx;
          totalQty += takeSz;
          weightedPrice += takeSz * askPx;
          remaining -= takeUsd;
        }
        
        const avgPrice = totalQty > 0 ? weightedPrice / totalQty : markPx;
        const slippage = ((avgPrice - markPx) / markPx * 100);
        const fullyFilled = remaining <= 0;
        
        console.log(`  $${sizeUsd.toString().padStart(6)}: avg=$${avgPrice.toFixed(4)} slippage=${slippage.toFixed(4)}% ${fullyFilled ? '✅' : '❌ insufficient depth'}`);
      }
      console.log('');
    } catch {}
  }
}
main().catch(console.error);
