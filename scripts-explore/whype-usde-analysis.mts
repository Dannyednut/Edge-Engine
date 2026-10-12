import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── WHYPE/USDe Pool Analysis ──\n');
  
  // Get HYPE price
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  let hypePrice = 0;
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    if (hlData[0].universe[i].name === 'HYPE') { hypePrice = parseFloat(hlData[1][i]?.markPx || '0'); break; }
  }
  console.log(`HYPE price: $${hypePrice.toFixed(2)}\n`);
  
  // Check WHYPE/USDe pools
  const usdePools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/USDe');
  for (const pool of usdePools) {
    const slot0 = await ethCall(pool.address, '0x3850c7bd');
    if (slot0 === '0x' || slot0.length < 66) { console.log(`  ${pool.fee}bps: no data`); continue; }
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    if (sqrtPrice === 0n) { console.log(`  ${pool.fee}bps: no price`); continue; }
    
    // WHYPE=18, USDe=18
    const price = v3PriceToHuman(sqrtPrice, 18, 18);
    const liqRes = await ethCall(pool.address, '0x1a686502');
    const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
    
    // price = USDe per WHYPE
    // USDe should be ~$1 (stablecoin)
    // So WHYPE price = price × $1 = price
    // If price ≠ HYPE price → arb
    
    const impliedHype = price; // USDe ≈ $1
    const spread = ((impliedHype - hypePrice) / hypePrice * 100);
    
    console.log(`  WHYPE/USDe ${pool.fee}bps:`);
    console.log(`    Price: ${price.toFixed(6)} (USDe per WHYPE)`);
    console.log(`    Implied HYPE: $${impliedHype.toFixed(2)}`);
    console.log(`    HL HYPE: $${hypePrice.toFixed(2)}`);
    console.log(`    Spread: ${spread.toFixed(3)}%`);
    console.log(`    Liquidity: ${liquidity.toFixed(2)} WHYPE ($${(liquidity * hypePrice).toFixed(2)})`);
    
    if (Math.abs(spread) > 0.1 && liquidity > 1) {
      console.log(`    ⚠️ ARB OPPORTUNITY!`);
      const profit5k = 5000 * Math.abs(spread) / 100 - 50 - 2;
      console.log(`    Profit on $5k: $${profit5k.toFixed(2)}`);
    }
    console.log('');
  }
  
  // Also check WHYPE/UETH pool (has 653 HYPE liquidity = $57k)
  console.log('── WHYPE/UETH Pool ──\n');
  const uethPools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/UETH' && p.fee === 3000);
  for (const pool of uethPools) {
    const slot0 = await ethCall(pool.address, '0x3850c7bd');
    if (slot0 === '0x' || slot0.length < 66) continue;
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    if (sqrtPrice === 0n) continue;
    const price = v3PriceToHuman(sqrtPrice, 18, 18);
    const liqRes = await ethCall(pool.address, '0x1a686502');
    const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
    
    // price = UETH per WHYPE
    // UETH ≈ ETH price ≈ $2563
    // So WHYPE price = price × ETH_price
    let ethPrice = 0;
    for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
      if (hlData[0].universe[i].name === 'ETH') { ethPrice = parseFloat(hlData[1][i]?.markPx || '0'); break; }
    }
    
    const impliedHype = price * ethPrice;
    const spread = ((impliedHype - hypePrice) / hypePrice * 100);
    
    console.log(`  WHYPE/UETH 3000bps:`);
    console.log(`    Price: ${price.toFixed(8)} (UETH per WHYPE)`);
    console.log(`    Implied HYPE: $${impliedHype.toFixed(2)} (using ETH $${ethPrice.toFixed(2)})`);
    console.log(`    HL HYPE: $${hypePrice.toFixed(2)}`);
    console.log(`    Spread: ${spread.toFixed(3)}%`);
    console.log(`    Liquidity: ${liquidity.toFixed(2)} WHYPE ($${(liquidity * hypePrice).toFixed(2)})`);
    
    if (Math.abs(spread) > 0.1 && liquidity > 1) {
      console.log(`    ⚠️ ARB OPPORTUNITY!`);
    }
  }
}
main().catch(console.error);
