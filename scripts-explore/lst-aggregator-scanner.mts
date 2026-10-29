/**
 * LST Aggregator Scanner
 * 
 * Compares all LSTs on HyperEVM:
 * - kHYPE (Kinetiq)
 * - stHYPE
 * - beHYPE
 * - hyperRAM (NEW)
 * 
 * Finds the best LST to hold (highest discount = best entry)
 * Finds LST-LST arbitrage opportunities
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function getPoolPrice(addr: string): Promise<{ price: number; liquidity: number }> {
  const slot0 = await ethCall(addr, '0x3850c7bd');
  if (slot0.length < 66) return { price: 0, liquidity: 0 };
  const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
  if (sqrtPrice === 0n) return { price: 0, liquidity: 0 };
  const price = v3PriceToHuman(sqrtPrice, 18, 18);
  
  const liqRes = await ethCall(addr, '0x1a686502');
  const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
  
  return { price, liquidity };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  LST Aggregator Scanner — All HyperEVM LSTs');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get all LST pools from HyperSwap V3
  console.log('── Scanning All LST Pools ──\n');
  
  const lstPools = HYPERSWAP_V3_POOLS.filter(p => p.pair.includes('HYPE'));
  const lstData: { name: string; pair: string; fee: number; price: number; discount: number; liquidity: number }[] = [];
  
  for (const pool of lstPools) {
    const { price, liquidity } = await getPoolPrice(pool.address);
    if (price > 0 && liquidity > 0) {
      const discount = (1 - price) * 100;
      lstData.push({
        name: pool.pair,
        pair: pool.pair,
        fee: pool.fee,
        price,
        discount,
        liquidity,
      });
      console.log(`  ${pool.pair.padEnd(20)} fee=${pool.fee}bps  price=${price.toFixed(6)}  discount=${discount.toFixed(3)}%  liq=${liquidity.toFixed(0)} HYPE`);
    }
  }

  // 2. Find best LST to buy (highest discount)
  console.log('\n── Best LST to Buy (highest discount) ──\n');
  const sorted = [...lstData].sort((a, b) => b.discount - a.discount);
  for (const lst of sorted) {
    console.log(`  ${lst.name.padEnd(20)} discount=${lst.discount.toFixed(3)}%  liq=${lst.liquidity.toFixed(0)} HYPE  ($${(lst.liquidity * 85).toLocaleString()})`);
  }

  // 3. LST-LST arbitrage
  console.log('\n── LST-LST Arbitrage Opportunities ──\n');
  
  // Compare kHYPE vs other LSTs
  const khype = lstData.find(l => l.pair === 'WHYPE/kHYPE' && l.fee === 100);
  if (khype) {
    console.log(`  kHYPE discount: ${khype.discount.toFixed(3)}%`);
    console.log('');
    
    for (const lst of lstData) {
      if (lst.pair === khype.pair) continue;
      const spread = khype.discount - lst.discount;
      if (Math.abs(spread) > 0.1) {
        const direction = spread > 0 ? `Buy ${lst.pair} (cheaper), sell kHYPE` : `Buy kHYPE (cheaper), sell ${lst.pair}`;
        const profit5k = Math.abs(spread) / 100 * 5000;
        console.log(`  kHYPE ↔ ${lst.pair}: spread=${spread.toFixed(3)}% → ${direction}`);
        console.log(`    Profit on $5k: $${profit5k.toFixed(2)}`);
      }
    }
  }

  // 4. LST aggregator strategy
  console.log('\n── LST Aggregator Strategy ──\n');
  console.log('  Strategy: Always hold the LST with highest discount');
  console.log('  1. Monitor all LST prices');
  console.log('  2. When better discount appears, switch');
  console.log('  3. Buy cheaper LST on HyperSwap V3');
  console.log('  4. Redeem current LST for HYPE');
  console.log('  5. Use HYPE to buy new LST');
  console.log('  6. Capture discount difference as profit');
  console.log('');
  console.log('  Additional yield from always holding best LST:');
  console.log('    - Instead of fixed 1.7% (kHYPE), get best available');
  console.log('    - If hyperRAM has 3% discount vs kHYPE 2.5%, switch');
  console.log('    - Capture 0.5% per switch = $50 per $10k per switch');
  console.log('    - 1 switch/week = $2,600/yr on $10k');
  console.log('');

  // 5. Build recommendation
  console.log('── Current Recommendation ──\n');
  if (sorted.length > 0) {
    const best = sorted[0];
    console.log(`  Best LST: ${best.name} (discount: ${best.discount.toFixed(3)}%)`);
    console.log(`  Liquidity: ${best.liquidity.toFixed(0)} HYPE ($${(best.liquidity * 85).toLocaleString()})`);
    console.log(`  Fee tier: ${best.fee} bps`);
    console.log('');
    console.log(`  On $10k:`);
    console.log(`    Discount capture: $${(10000 * best.discount / 100).toFixed(0)} per cycle`);
    console.log(`    Staking yield: ~$170/yr (1.7% APR)`);
    console.log(`    Total: $${(10000 * best.discount / 100).toFixed(0)} + $170/yr`);
  }
}

main().catch(console.error);
