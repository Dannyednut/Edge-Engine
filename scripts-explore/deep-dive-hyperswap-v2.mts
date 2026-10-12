/**
 * DEEP DIVE: HyperSwap V2 (Legacy Pools)
 * V2 = Uniswap V2 fork (x*y=k)
 * May have pools not in V3
 */
import { HYPERSWAP_V2_POOLS } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function main() {
  console.log('── DEEP DIVE: HyperSwap V2 Pools ──\n');
  console.log(`V2 pools in config: ${Object.keys(HYPERSWAP_V2_POOLS).length}\n`);

  // getReserves() = 0x0902f1ac
  for (const [pair, addr] of Object.entries(HYPERSWAP_V2_POOLS)) {
    try {
      const reserves = await ethCall(addr, '0x0902f1ac');
      if (reserves && reserves !== '0x' && reserves.length >= 130) {
        const reserve0 = BigInt('0x' + reserves.slice(2, 66));
        const reserve1 = BigInt('0x' + reserves.slice(66, 130));
        
        if (reserve0 > 0n && reserve1 > 0n) {
          const r0 = Number(reserve0) / 1e18;
          const r1 = Number(reserve1) / 1e18;
          const price = r1 > 0 ? r0 / r1 : 0;
          const tvl = (r0 + r1) * 85; // approx USD
          
          console.log(`  ${pair.padEnd(20)} r0=${r0.toFixed(2).padStart(12)}  r1=${r1.toFixed(2).padStart(12)}  price=${price.toFixed(6)}  TVL≈$${tvl.toFixed(0)}`);
        } else {
          console.log(`  ${pair.padEnd(20)} empty (no reserves)`);
        }
      } else {
        console.log(`  ${pair.padEnd(20)} no response`);
      }
    } catch (e: any) {
      console.log(`  ${pair.padEnd(20)} error: ${e.message?.substring(0, 50)}`);
    }
  }

  console.log('\n── V2 vs V3 Comparison ──\n');
  console.log('  V2: Uniswap V2 fork (x*y=k, single fee tier)');
  console.log('  V3: Uniswap V3 fork (concentrated liquidity, multiple fee tiers)');
  console.log('');
  console.log('  V2 advantages:');
  console.log('    - Simpler (no tick management)');
  console.log('    - May have pools V3 doesn\'t');
  console.log('    - Could have different prices → arb opportunity');
  console.log('');
  console.log('  V2 disadvantages:');
  console.log('    - Less capital efficient');
  console.log('    - Higher impermanent loss');
  console.log('    - Legacy (being deprecated)');
  console.log('');
  console.log('  ARB OPPORTUNITY:');
  console.log('    If same pair exists on V2 AND V3:');
  console.log('    1. Compare prices');
  console.log('    2. Buy on cheaper DEX');
  console.log('    3. Sell on expensive DEX');
  console.log('    4. Flashloan for atomic execution');
}
main().catch(console.error);
