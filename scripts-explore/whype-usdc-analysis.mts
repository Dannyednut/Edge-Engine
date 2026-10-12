import { HYPERSWAP_V3_POOLS, HYPERSWAP_V2_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── WHYPE/USDC Pool Analysis ──\n');
  
  // Get HYPE price from HL
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  let hypePrice = 0;
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    if (hlData[0].universe[i].name === 'HYPE') { hypePrice = parseFloat(hlData[1][i]?.markPx || '0'); break; }
  }
  console.log(`HYPE price (HL): $${hypePrice.toFixed(2)}\n`);
  
  // Check V3 WHYPE/USDC pool
  const v3Pool = HYPERSWAP_V3_POOLS.find(p => p.pair === 'WHYPE/USDC');
  if (v3Pool) {
    const slot0 = await ethCall(v3Pool.address, '0x3850c7bd');
    const liqRes = await ethCall(v3Pool.address, '0x1a686502');
    
    if (slot0.length >= 66) {
      const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
      if (sqrtPrice > 0n) {
        // WHYPE=18, USDC=6 → dec0=18, dec1=6
        const price = v3PriceToHuman(sqrtPrice, 18, 6);
        const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
        const usdLiquidity = liquidity * hypePrice;
        
        console.log(`V3 WHYPE/USDC (${v3Pool.fee}bps):`);
        console.log(`  Price: ${price}`);
        console.log(`  WHYPE price implied: $${(1/price).toFixed(2)}`);
        console.log(`  HL price: $${hypePrice.toFixed(2)}`);
        console.log(`  Spread: ${(((1/price) - hypePrice) / hypePrice * 100).toFixed(3)}%`);
        console.log(`  Liquidity: ${liquidity.toFixed(2)} WHYPE ($${usdLiquidity.toFixed(2)})`);
        
        if (usdLiquidity > 100) {
          console.log(`  ✅ Sufficient liquidity for arb`);
          const maxArbSize = usdLiquidity * 0.1; // 10% of liquidity
          console.log(`  Max arb size: $${maxArbSize.toFixed(2)}`);
        } else {
          console.log(`  ❌ Insufficient liquidity`);
        }
      }
    }
  }
  
  // Check V2 WHYPE/USDC pool
  const v2Addr = HYPERSWAP_V2_POOLS['WHYPE/USDC'];
  if (v2Addr) {
    const res = await ethCall(v2Addr, '0x0902f1ac');
    if (res.length >= 130) {
      const r0 = Number(BigInt('0x' + res.slice(2, 66))) / 1e18; // WHYPE
      const r1 = Number(BigInt('0x' + res.slice(66, 130))) / 1e6; // USDC
      console.log(`\nV2 WHYPE/USDC:`);
      console.log(`  WHYPE reserves: ${r0.toFixed(6)}`);
      console.log(`  USDC reserves: ${r1.toFixed(6)}`);
      if (r0 > 0 && r1 > 0) {
        const v2Price = r1 / r0;
        console.log(`  Implied HYPE price: $${v2Price.toFixed(2)}`);
        console.log(`  HL price: $${hypePrice.toFixed(2)}`);
        console.log(`  Spread: ${((v2Price - hypePrice) / hypePrice * 100).toFixed(3)}%`);
      }
    }
  }
  
  // 66. Build: Stablecoin USDC/USDT0 V3 pool check
  console.log('\n── USDC/USDT0 V3 Pool ──\n');
  const usdcUsdt0 = HYPERSWAP_V3_POOLS.find(p => p.pair === 'USDC/USDT0');
  if (usdcUsdt0) {
    const slot0 = await ethCall(usdcUsdt0.address, '0x3850c7bd');
    const liqRes = await ethCall(usdcUsdt0.address, '0x1a686502');
    if (slot0.length >= 66) {
      const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
      if (sqrtPrice > 0n) {
        const price = v3PriceToHuman(sqrtPrice, 6, 6); // USDC=6, USDT0=6
        const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e6 : 0;
        console.log(`  Price: ${price} (USDC per USDT0)`);
        console.log(`  Deviation from 1.0: ${((price - 1) * 100).toFixed(4)}%`);
        console.log(`  Liquidity: ${liquidity.toFixed(2)} USDC`);
        if (Math.abs(price - 1) > 0.001) {
          console.log(`  ⚠️ STABLECOIN DEPEG! Arb opportunity`);
        } else {
          console.log(`  ✅ Peg stable`);
        }
      }
    }
  }
}
main().catch(console.error);
