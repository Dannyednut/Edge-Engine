import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── USDC/USDT0 Stablecoin Arb Strategy ──\n');
  
  const pool = HYPERSWAP_V3_POOLS.find(p => p.pair === 'USDC/USDT0' && p.fee === 100);
  if (!pool) { console.log('Pool not found'); return; }
  
  const slot0 = await ethCall(pool.address, '0x3850c7bd');
  const liqRes = await ethCall(pool.address, '0x1a686502');
  
  const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
  const price = v3PriceToHuman(sqrtPrice, 6, 6);
  const liquidity = Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e6;
  
  console.log(`Pool: USDC/USDT0 100bps`);
  console.log(`Price: ${price} (USDC per USDT0)`);
  console.log(`Deviation: ${((price - 1) * 100).toFixed(4)}%`);
  console.log(`Liquidity: ${liquidity.toFixed(0)} USDC\n`);
  
  const deviation = (price - 1) * 100;
  const fee = 0.01; // 100bps = 1% fee
  
  if (deviation > fee) {
    // USDT0 is cheaper → buy USDT0, sell USDC
    console.log('📈 STRATEGY: Buy USDT0, sell USDC');
    const arbSize = Math.min(25000, liquidity * 0.05); // 5% of liquidity
    const grossProfit = arbSize * deviation / 100;
    const feeCost = arbSize * fee / 100;
    const flashloanFee = arbSize * 0.0004;
    const netProfit = grossProfit - feeCost - flashloanFee;
    
    console.log(`  Arb size: $${arbSize.toFixed(2)}`);
    console.log(`  Gross profit: $${grossProfit.toFixed(2)}`);
    console.log(`  Pool fee (1%): $${feeCost.toFixed(2)}`);
    console.log(`  Flashloan fee: $${flashloanFee.toFixed(2)}`);
    console.log(`  Net profit: $${netProfit.toFixed(2)}`);
    console.log(`  ROI: ${(netProfit / arbSize * 100).toFixed(4)}%`);
    console.log(`  If 10x/day: $${(netProfit * 10).toFixed(2)}/day = $${(netProfit * 10 * 365).toFixed(0)}/yr`);
  } else if (deviation < -fee) {
    console.log('📉 STRATEGY: Buy USDC, sell USDT0');
  } else {
    console.log(`⚠️ Deviation (${deviation.toFixed(4)}%) < fee (${fee}%)`);
    console.log('  Not profitable after pool fees');
    console.log('  Need lower fee tier pool (100bps = 1% is too high)');
    console.log('  Or: wait for larger deviation');
  }
  
  console.log('\n── Strategy Summary ──\n');
  console.log('  USDC/USDT0 pool has 33.4M liquidity');
  console.log('  Current deviation: 0.1119%');
  console.log('  Pool fee: 1% (100bps) — TOO HIGH for stablecoin arb');
  console.log('  Need: 1bps or 5bps pool (like Uniswap V3 stables pools)');
  console.log('  Or: use V2 pool (0.3% fee) if it has liquidity');
  console.log('');
  console.log('  VERDICT: Opportunity exists but pool fee too high');
  console.log('  Monitor for: lower fee tier pool or larger deviation (>1%)');
}
main().catch(console.error);
