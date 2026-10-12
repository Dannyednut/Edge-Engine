const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── Continuous Dashboard (3 scans, 60s interval) ──\n');
  
  for (let scan = 1; scan <= 3; scan++) {
    const time = new Date().toISOString().substring(11, 19);
    
    // Market
    const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
    const universe = meta?.[0]?.universe || [];
    const ctxs = meta?.[1] || [];
    let vol = 0, oi = 0;
    for (let i = 0; i < universe.length; i++) {
      vol += parseFloat(ctxs[i]?.dayNtlVlm || '0');
      oi += parseFloat(ctxs[i]?.openInterest || '0') * parseFloat(ctxs[i]?.markPx || '0');
    }
    
    // VOOI
    const vooiRes = await fetch('https://perps-api.vooi.io/arbitrage-scanner?limit=5&orderBy=priceSpread&orderDirection=desc&minPriceSpread=0.005');
    const vooiData = vooiRes.ok ? await vooiRes.json() : { items: [] };
    let oppCount = 0, topSpread = 0, topAsset = '';
    for (const item of (vooiData?.items || [])) {
      for (const p of (item.pairs || [])) {
        const spread = (p.priceSpread || 0) * 100;
        if (spread > 0.5) { oppCount++; if (spread > topSpread) { topSpread = spread; topAsset = item.asset; } }
      }
    }
    
    // kHYPE
    const kRes = await fetch('https://rpc.hyperliquid.xyz/evm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x5cbe810071de393de35e574fb2830e16da794bab', data: '0x3850c7bd' }, 'latest'], id: 1 }),
    });
    const kSlot0 = (await kRes.json()).result || '0x';
    let kDisc = 0;
    if (kSlot0.length >= 66) {
      const sq = BigInt('0x' + kSlot0.slice(2, 66));
      const p = Number(sq * sq * 10n**18n / (2n**192n)) / 1e18;
      kDisc = (1 - p) * 100;
    }
    
    console.log(`[${time}] Scan ${scan}: vol=$${(vol/1e9).toFixed(2)}B oi=$${(oi/1e9).toFixed(2)}B | VOOI=${oppCount} (top: ${topAsset} ${topSpread.toFixed(2)}%) | kHYPE=${kDisc.toFixed(3)}%`);
    
    if (scan < 3) await new Promise(r => setTimeout(r, 60_000));
  }
  
  console.log('\n── Monitor Complete ──');
}
main().catch(console.error);
