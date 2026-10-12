const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Spot Market Scanner ──\n');
  
  const [perpMeta, spotMeta] = await Promise.all([
    hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    hlInfo({ type: 'spotMetaAndAssetCtxs' }),
  ]);
  
  const perpUniverse = perpMeta?.[0]?.universe || [];
  const perpCtxs = perpMeta?.[1] || [];
  const spotUniverse = spotMeta?.[0]?.universe || [];
  const spotCtxs = spotMeta?.[1] || [];
  const spotTokens = spotMeta?.[0]?.tokens || [];
  
  // Build perp prices
  const perpPrices: Record<string, { price: number; vol: number }> = {};
  for (let i = 0; i < perpUniverse.length; i++) {
    const name = perpUniverse[i].name;
    const px = parseFloat(perpCtxs[i]?.markPx || '0');
    const vol = parseFloat(perpCtxs[i]?.dayNtlVlm || '0');
    if (px > 0) perpPrices[name] = { price: px, vol };
  }
  
  // Build spot prices
  const spotPrices: Record<string, { price: number; vol: number }> = {};
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const px = parseFloat(spotCtxs[i]?.markPx || '0');
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (px > 0 && !name.startsWith('@')) spotPrices[name] = { price: px, vol };
  }
  
  // Find matching assets with both perp + spot
  console.log('Assets with both perp + spot:\n');
  console.log('Name       | Perp $       | Spot $       | Basis %  | Perp Vol $M | Spot Vol $M');
  console.log('───────────|──────────────|──────────────|──────────|─────────────|─────────────');
  
  const arbs: any[] = [];
  for (const [name, perp] of Object.entries(perpPrices)) {
    const spot = spotPrices[name];
    if (!spot || spot.vol < 10000) continue;
    
    const basis = ((perp.price - spot.price) / spot.price * 100);
    if (Math.abs(basis) > 0.01) {
      console.log(`${name.padEnd(10)}| $${perp.price.toFixed(6).padStart(12)}| $${spot.price.toFixed(6).padStart(12)}| ${basis.toFixed(3).padStart(8)}%| ${(perp.vol/1e6).toFixed(1).padStart(11)}| ${(spot.vol/1e6).toFixed(1).padStart(11)}`);
      
      if (Math.abs(basis) > 0.1) {
        arbs.push({ name, perpPrice: perp.price, spotPrice: spot.price, basis, perpVol: perp.vol, spotVol: spot.vol });
      }
    }
  }
  
  console.log(`\n  Found ${arbs.length} spot-perp basis arbs > 0.1%`);
  
  // Top spot tokens by volume
  console.log('\n── Top 15 Spot Tokens by Volume ──\n');
  const topSpot = Object.entries(spotPrices).sort((a, b) => b[1].vol - a[1].vol);
  for (const [name, data] of topSpot.slice(0, 15)) {
    const perp = perpPrices[name];
    console.log(`  ${name.padEnd(15)} $${data.price.toFixed(6)}  vol=$${(data.vol/1000).toFixed(0)}k  ${perp ? 'has perp' : 'spot only'}`);
  }
}
main().catch(console.error);
