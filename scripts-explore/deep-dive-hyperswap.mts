/**
 * DEEP DIVE: HyperSwap V3 — All Pools
 * Enumerate every pool on HyperSwap V3
 * Check prices + liquidity for each
 * Find arb opportunities between pools
 */
import { HYPERSWAP_V3_POOLS, HL_TOKEN_DECIMALS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function main() {
  console.log('── DEEP DIVE: HyperSwap V3 All Pools ──\n');
  console.log(`Total pools in config: ${HYPERSWAP_V3_POOLS.length}\n`);

  const activePools: any[] = [];

  for (const pool of HYPERSWAP_V3_POOLS) {
    try {
      // Get slot0
      const slot0 = await ethCall(pool.address, '0x3850c7bd');
      if (slot0.length < 66) continue;
      const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
      if (sqrtPrice === 0n) continue;

      // Get liquidity
      const liqRes = await ethCall(pool.address, '0x1a686502');
      const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
      if (liquidity === 0) continue;

      // Compute price
      const [sym0, sym1] = pool.pair.split('/');
      const dec0 = HL_TOKEN_DECIMALS[sym0] ?? 18;
      const dec1 = HL_TOKEN_DECIMALS[sym1] ?? 18;
      const price = v3PriceToHuman(sqrtPrice, dec0, dec1);

      activePools.push({
        pair: pool.pair,
        fee: pool.fee,
        address: pool.address,
        price,
        liquidity,
        liquidityUsd: liquidity * 85, // approx in USD
      });

      console.log(`  ${pool.pair.padEnd(20)} fee=${pool.fee}bps  price=${price.toFixed(6)}  liq=${liquidity.toFixed(0)} ($${(liquidity * 85).toFixed(0)})`);
    } catch {}
  }

  console.log(`\n  Active pools: ${activePools.length} / ${HYPERSWAP_V3_POOLS.length}`);

  // Find cross-pool arbs (same pair, different fee tiers)
  console.log('\n── Cross-Pool Arb (same pair, different fees) ──\n');
  const byPair: Record<string, any[]> = {};
  for (const p of activePools) {
    if (!byPair[p.pair]) byPair[p.pair] = [];
    byPair[p.pair].push(p);
  }

  for (const [pair, pools] of Object.entries(byPair)) {
    if (pools.length < 2) continue;
    const prices = pools.map(p => p.price);
    const max = Math.max(...prices);
    const min = Math.min(...prices);
    const spread = ((max - min) / min) * 100;
    if (spread > 0.1) {
      console.log(`  ${pair}: ${pools.length} pools, spread=${spread.toFixed(3)}%`);
      for (const p of pools) {
        console.log(`    fee=${p.fee}bps price=${p.price.toFixed(6)} liq=${p.liquidity.toFixed(0)}`);
      }
      console.log(`    → BUY on cheap pool, SELL on expensive pool`);
      console.log(`    → Profit on $5k: $${(5000 * spread / 100).toFixed(2)}`);
      console.log('');
    }
  }

  // Find triangular arb opportunities
  console.log('── Triangular Arb Opportunities ──\n');
  // Look for: A→B→C→A paths
  // e.g., USDC→WHYPE→kHYPE→USDC
  const pairs = activePools.map(p => p.pair);
  const tokens = new Set<string>();
  for (const pair of pairs) {
    const [a, b] = pair.split('/');
    tokens.add(a);
    tokens.add(b);
  }
  console.log(`  Unique tokens: ${Array.from(tokens).join(', ')}`);
  console.log('');

  // Check if we can do USDC → WHYPE → kHYPE → USDC
  const hasUSDC_WHYPE = activePools.find(p => p.pair === 'WHYPE/USDC');
  const hasWHYPE_kHYPE = activePools.find(p => p.pair === 'WHYPE/kHYPE');
  const hasK_HYPE_USDC = activePools.find(p => p.pair === 'kHYPE/USDC' || p.pair === 'USDC/kHYPE');

  if (hasUSDC_WHYPE && hasWHYPE_kHYPE) {
    console.log('  USDC → WHYPE → kHYPE path:');
    console.log(`    WHYPE/USDC: ${hasUSDC_WHYPE.price.toFixed(6)} (liq: ${hasUSDC_WHYPE.liquidity.toFixed(0)})`);
    console.log(`    WHYPE/kHYPE: ${hasWHYPE_kHYPE.price.toFixed(6)} (liq: ${hasWHYPE_kHYPE.liquidity.toFixed(0)})`);
    if (hasK_HYPE_USDC) {
      console.log(`    kHYPE/USDC: ${hasK_HYPE_USDC.price.toFixed(6)}`);
      console.log('    → Triangular arb possible!');
    } else {
      console.log('    kHYPE/USDC pool: not found');
      console.log('    → Cannot complete triangular arb');
    }
  }
}
main().catch(console.error);
