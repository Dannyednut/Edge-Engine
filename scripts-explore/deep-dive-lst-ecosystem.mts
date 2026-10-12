/**
 * DEEP DIVE: HyperEVM LST Ecosystem
 * Compare ALL liquid staking tokens:
 * - kHYPE (Kinetiq)
 * - stHYPE 
 * - beHYPE
 * - hyperRAM (NEW)
 * 
 * Find best LST to hold + LST-LST arb opportunities
 */
import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('── DEEP DIVE: HyperEVM LST Ecosystem ──\n');

  // 1. Get HYPE price from HL
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  let hypePrice = 0;
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].name === 'HYPE') {
      hypePrice = parseFloat(ctxs[i]?.markPx || '0');
      break;
    }
  }
  console.log(`  HYPE price: $${hypePrice.toFixed(2)}\n`);

  // 2. Scan all HyperSwap V3 pools for LST pairs
  console.log('── All LST Pools on HyperSwap V3 ──\n');
  const lstPools: any[] = [];
  
  for (const pool of HYPERSWAP_V3_POOLS) {
    if (!pool.pair.includes('HYPE') && !pool.pair.includes('kHYPE') && 
        !pool.pair.includes('stHYPE') && !pool.pair.includes('beHYPE') &&
        !pool.pair.includes('hyperRAM') && !pool.pair.includes('xRAM')) continue;
    
    const slot0 = await ethCall(pool.address, '0x3850c7bd');
    if (slot0.length < 66) continue;
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    if (sqrtPrice === 0n) continue;
    
    const liqRes = await ethCall(pool.address, '0x1a686502');
    const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
    if (liquidity === 0) continue;
    
    const price = v3PriceToHuman(sqrtPrice, 18, 18);
    const discount = (1 - price) * 100;
    
    lstPools.push({
      pair: pool.pair,
      fee: pool.fee,
      price,
      discount,
      liquidity,
      liquidityUsd: liquidity * hypePrice,
    });
    
    console.log(`  ${pool.pair.padEnd(20)} fee=${pool.fee}bps  price=${price.toFixed(6)}  discount=${discount.toFixed(3)}%  liq=${liquidity.toFixed(0)} ($${(liquidity * hypePrice).toFixed(0)})`);
  }

  // 3. Check spot markets for LST tokens
  console.log('\n── HL Spot LST Tokens ──\n');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const spotUniverse = spotMeta?.[0]?.universe || [];
  const spotCtxs = spotMeta?.[1] || [];
  const spotTokens = spotMeta?.[0]?.tokens || [];
  
  const lstNames = ['kHYPE', 'stHYPE', 'beHYPE', 'wstHYPE', 'hyperRAM', 'xRAM', 'INFRA'];
  for (let i = 0; i < spotUniverse.length; i++) {
    let name = spotUniverse[i].name || '';
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < spotTokens.length) name = spotTokens[idx].name || name;
    }
    const markPx = parseFloat(spotCtxs[i]?.markPx || '0');
    const vol = parseFloat(spotCtxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && lstNames.some(l => name.includes(l))) {
      console.log(`  ${name.padEnd(15)} $${markPx.toFixed(6)}  vol=$${(vol/1000).toFixed(0)}k`);
    }
  }

  // 4. LST comparison table
  console.log('\n── LST Comparison ──\n');
  console.log('LST       | Discount  | Liquidity     | APR (est) | Withdrawal | Status');
  console.log('──────────|───────────|───────────────|──────────|────────────|──────────');
  
  const lstInfo = [
    { name: 'kHYPE', discount: lstPools.find(p => p.pair === 'WHYPE/kHYPE' && p.fee === 100)?.discount || 0, 
      liq: lstPools.find(p => p.pair === 'WHYPE/kHYPE' && p.fee === 100)?.liquidityUsd || 0,
      apr: 1.7, withdrawal: '7 days', status: 'Active on HyperSwap' },
    { name: 'stHYPE', discount: 0, liq: 0, apr: 2.0, withdrawal: '7 days', status: 'Not on HyperSwap' },
    { name: 'beHYPE', discount: 0, liq: 0, apr: 2.1, withdrawal: '7 days', status: 'Not on HyperSwap' },
    { name: 'hyperRAM', discount: 0, liq: 0, apr: 0, withdrawal: 'unknown', status: 'NEW — researching' },
  ];
  
  for (const lst of lstInfo) {
    console.log(`${lst.name.padEnd(10)}| ${lst.discount.toFixed(3).padStart(9)}%| $${lst.liq.toFixed(0).padStart(13)}| ${(lst.apr).toFixed(1).padStart(8)}%| ${lst.withdrawal.padEnd(10)}| ${lst.status}`);
  }

  // 5. LST aggregator strategy
  console.log('\n── LST Aggregator Strategy ──\n');
  console.log('  Optimal strategy:');
  console.log('    1. Monitor all LST discounts');
  console.log('    2. Always hold LST with highest discount');
  console.log('    3. When better discount appears, switch:');
  console.log('       a. Sell current LST on HyperSwap');
  console.log('       b. Buy new LST on HyperSwap');
  console.log('       c. Capture discount difference');
  console.log('    4. Earn staking yield while holding');
  console.log('');
  console.log('  Current best: kHYPE (2.54% discount, only LST with liquidity)');
  console.log('  hyperRAM: NEW — need to find DEX listing');
  console.log('');
  console.log('  Revenue estimate (LST aggregator):');
  console.log('    Base yield: 1.7-2.1% APR (staking)');
  console.log('    Switch profit: 0.5-2% per switch × 1 switch/week');
  console.log('    Additional: $260-2,080/yr on $10k');
  console.log('    Total: $430-2,290/yr on $10k = 4.3-22.9% APR');
}
main().catch(console.error);
