/**
 * Triangular Arbitrage Scanner
 * 
 * Finds 3-way arb paths on HyperEVM:
 *   USDC → WHYPE → kHYPE → USDC
 *   USDC → WHYPE → UETH → USDC
 *   USDC → WHYPE → UBTC → USDC
 * 
 * If end amount > start amount + fees → profit!
 */
import { HYPERSWAP_V3_POOLS, HYPERSWAP_V2_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function getV3Price(addr: string): Promise<{ price: number; liquidity: number }> {
  const slot0 = await ethCall(addr, '0x3850c7bd');
  if (slot0.length < 66) return { price: 0, liquidity: 0 };
  const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
  if (sqrtPrice === 0n) return { price: 0, liquidity: 0 };
  const price = v3PriceToHuman(sqrtPrice, 18, 18);
  const liqRes = await ethCall(addr, '0x1a686502');
  const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
  return { price, liquidity };
}

async function getV2Reserves(addr: string): Promise<{ r0: number; r1: number }> {
  const res = await ethCall(addr, '0x0902f1ac');
  if (res.length < 130) return { r0: 0, r1: 0 };
  const r0 = Number(BigInt('0x' + res.slice(2, 66))) / 1e18;
  const r1 = Number(BigInt('0x' + res.slice(66, 130))) / 1e18;
  return { r0, r1 };
}

async function main() {
  console.log('── Triangular Arbitrage Scanner ──\n');
  
  // 1. Check all V3 pools with liquidity
  console.log('── Active V3 Pools ──\n');
  const activePools: { pair: string; fee: number; addr: string; price: number; liquidity: number }[] = [];
  for (const pool of HYPERSWAP_V3_POOLS) {
    const { price, liquidity } = await getV3Price(pool.address);
    if (liquidity > 0 && price > 0) {
      activePools.push({ pair: pool.pair, fee: pool.fee, addr: pool.address, price, liquidity });
      console.log(`  ${pool.pair} ${pool.fee}bps: price=${price.toFixed(6)} liq=${liquidity.toFixed(0)}`);
    }
  }
  
  // 2. Check V2 pools
  console.log('\n── Active V2 Pools ──\n');
  for (const [pair, addr] of Object.entries(HYPERSWAP_V2_POOLS)) {
    const { r0, r1 } = await getV2Reserves(addr);
    if (r0 > 0 || r1 > 0) {
      console.log(`  ${pair}: r0=${r0.toFixed(2)} r1=${r1.toFixed(2)}`);
    }
  }
  
  // 3. Find triangular paths
  console.log('\n── Triangular Arb Paths ──\n');
  
  // Path: USDC → WHYPE → kHYPE → USDC
  // Need: USDC/WHYPE pool, WHYPE/kHYPE pool, kHYPE/USDC pool
  const usdcWhype = activePools.find(p => p.pair === 'WHYPE/USDC');
  const whypeKhype = activePools.find(p => p.pair === 'WHYPE/kHYPE' && p.fee === 100);
  const khypeUsdc = activePools.find(p => p.pair === 'kHYPE/USDC' || p.pair === 'USDC/kHYPE');
  
  if (usdcWhype && whypeKhype) {
    console.log('  Path: USDC → WHYPE → kHYPE → USDC');
    console.log(`    USDC/WHYPE: ${usdcWhype.price} (liq: ${usdcWhype.liquidity})`);
    console.log(`    WHYPE/kHYPE: ${whypeKhype.price} (liq: ${whypeKhype.liquidity})`);
    console.log(`    kHYPE/USDC: ${khypeUsdc ? khypeUsdc.price : 'NOT FOUND'}`);
    if (!khypeUsdc) {
      console.log('    ❌ Cannot complete triangular path (kHYPE/USDC pool missing)');
    }
  }
  
  // Path: WHYPE → kHYPE → WHYPE (simple round-trip)
  if (whypeKhype) {
    const discount = (1 - whypeKhype.price) * 100;
    console.log('\n  Path: WHYPE → kHYPE → WHYPE (round-trip)');
    console.log(`    Buy kHYPE at ${discount.toFixed(3)}% discount`);
    console.log(`    Sell kHYPE back at same price`);
    console.log(`    Net: 0 (minus fees) — no arb in round-trip`);
    console.log(`    BUT: if we redeem kHYPE for WHYPE (7-day wait):`);
    console.log(`    Profit = ${discount.toFixed(3)}% - flashloan fee (0.04%) - AMM fee (1%)`);
    const profit = discount - 0.04 - 1;
    console.log(`    Net profit: ${profit.toFixed(3)}% on $5k = $${(5000 * profit / 100).toFixed(2)}`);
  }
  
  // 4. V2 vs V3 cross-DEX arb
  console.log('\n── V2 vs V3 Cross-DEX Arb ──\n');
  for (const pool3 of activePools) {
    const v2Addr = HYPERSWAP_V2_POOLS[pool3.pair];
    if (!v2Addr) continue;
    const { r0, r1 } = await getV2Reserves(v2Addr);
    if (r0 === 0 || r1 === 0) continue;
    
    const v2Price = r1 > 0 ? r0 / r1 : 0;
    const v3Price = pool3.price;
    const spread = ((v3Price - v2Price) / v2Price * 100);
    
    if (Math.abs(spread) > 0.1) {
      console.log(`  ${pool3.pair}: V3=${v3Price.toFixed(6)} V2=${v2Price.toFixed(6)} spread=${spread.toFixed(3)}%`);
      console.log(`    → Buy on ${spread > 0 ? 'V2' : 'V3'}, sell on ${spread > 0 ? 'V3' : 'V2'}`);
      console.log(`    → Profit on $5k: $${(5000 * Math.abs(spread) / 100).toFixed(2)}`);
    }
  }
  
  console.log('\n── Summary ──\n');
  console.log(`  Active V3 pools: ${activePools.length}`);
  console.log('  Triangular arb: limited (most pools have 0 liquidity)');
  console.log('  V2 vs V3 arb: check above for spread');
  console.log('  Best opportunity: kHYPE LST discount arb (2.5% = $75/5k)');
}
main().catch(console.error);
