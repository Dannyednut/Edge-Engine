/**
 * kHYPE LST Arb Executor — Our #1 HyperEVM Opportunity
 * 
 * Current state:
 *   kHYPE/WHYPE V3 pool (100bps): price = 0.9746
 *   kHYPE discount: 2.536%
 *   Liquidity: 32,790 WHYPE ($2.88M)
 * 
 * Strategy:
 *   1. Flashloan USDC from HyperLend (0.04% fee)
 *   2. Swap USDC → WHYPE (via WHYPE/USDC pool or HL bridge)
 *   3. Swap WHYPE → kHYPE on HyperSwap V3 (buy at 2.5% discount)
 *   4. Redeem kHYPE for WHYPE (7-day wait OR instant via burn)
 *   5. Swap WHYPE → USDC
 *   6. Repay flashloan + fee
 *   7. Profit = 2.5% - 0.04% - 1% (pool fee) - slippage = ~1.4%
 * 
 * On $25k: $350 per cycle
 * If 2 cycles/day: $700/day = $255k/yr
 */
import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── kHYPE LST Arb Executor ──\n');
  
  // Get current kHYPE price
  const pool = HYPERSWAP_V3_POOLS.find(p => p.pair === 'WHYPE/kHYPE' && p.fee === 100);
  if (!pool) { console.log('Pool not found'); return; }
  
  const slot0 = await ethCall(pool.address, '0x3850c7bd');
  if (slot0 === '0x' || slot0.length < 66) { console.log('No slot0 data'); return; }
  const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
  if (sqrtPrice === 0n) { console.log('No price'); return; }
  const price = v3PriceToHuman(sqrtPrice, 18, 18);
  const discount = (1 - price) * 100;
  
  const liqRes = await ethCall(pool.address, '0x1a686502');
  const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
  
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
  
  console.log(`Current State:`);
  console.log(`  kHYPE/WHYPE price: ${price}`);
  console.log(`  kHYPE discount: ${discount.toFixed(3)}%`);
  console.log(`  HYPE price: $${hypePrice.toFixed(2)}`);
  console.log(`  Pool liquidity: ${liquidity.toFixed(0)} WHYPE ($${(liquidity * hypePrice).toFixed(0)})`);
  console.log('');
  
  // Calculate arb economics
  const flashloanFee = 0.0004; // 0.04%
  const poolFee = 0.01; // 100bps = 1%
  const slippage = 0.005; // 0.5% estimate
  const gasCost = 0.004; // $0.004 per tx
  
  const arbSize = Math.min(25000, liquidity * hypePrice * 0.1); // 10% of liquidity
  const grossProfit = arbSize * discount / 100;
  const flashloanCost = arbSize * flashloanFee;
  const poolFeeCost = arbSize * poolFee;
  const slippageCost = arbSize * slippage;
  const netProfit = grossProfit - flashloanCost - poolFeeCost - slippageCost - gasCost;
  
  console.log(`Arb Economics (on $${arbSize.toFixed(0)}):`);
  console.log(`  Gross profit (discount): $${grossProfit.toFixed(2)}`);
  console.log(`  Flashloan fee (0.04%): $${flashloanCost.toFixed(2)}`);
  console.log(`  Pool fee (1%): $${poolFeeCost.toFixed(2)}`);
  console.log(`  Slippage (0.5%): $${slippageCost.toFixed(2)}`);
  console.log(`  Gas: $${gasCost.toFixed(4)}`);
  console.log(`  NET PROFIT: $${netProfit.toFixed(2)}`);
  console.log(`  ROI: ${(netProfit / arbSize * 100).toFixed(3)}%`);
  console.log('');
  
  if (netProfit > 0) {
    console.log(`✅ PROFITABLE!`);
    console.log(`  If 2 cycles/day: $${(netProfit * 2).toFixed(2)}/day = $${(netProfit * 2 * 365).toFixed(0)}/yr`);
    console.log(`  APR: ${(netProfit * 2 * 365 / arbSize * 100).toFixed(0)}%`);
  } else {
    console.log(`❌ Not profitable after costs`);
    console.log(`  Need: lower pool fee (5bps instead of 100bps)`);
    console.log(`  Or: larger discount (>3.5%)`);
  }
  
  console.log('\n── Execution Steps ──\n');
  console.log('  1. Deploy FlashloanArbExecutor contract on HyperEVM');
  console.log('  2. Contract calls HyperLend.flashloan(USDC, amount)');
  console.log('  3. Contract swaps USDC → WHYPE (via WHYPE/USDC pool or CoreWriter)');
  console.log('  4. Contract swaps WHYPE → kHYPE (via HyperSwap V3, 100bps pool)');
  console.log('  5. Contract burns kHYPE for WHYPE (Kinetiq burn function)');
  console.log('     OR: contract holds kHYPE and waits 7 days');
  console.log('  6. Contract swaps WHYPE → USDC');
  console.log('  7. Contract repays flashloan + fee');
  console.log('  8. Profit sent to owner');
  console.log('');
  console.log('  ⚠️ Step 5 is the blocker:');
  console.log('     - Instant burn may not be available (7-day withdrawal)');
  console.log('     - If 7-day wait: flashloan can\'t be used (must use own capital)');
  console.log('     - Alternative: hold kHYPE and earn staking yield while waiting');
}
main().catch(console.error);
