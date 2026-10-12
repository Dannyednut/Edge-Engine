import { HYPERSWAP_V3_POOLS, HYPERSWAP_V2_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── Comprehensive HyperEVM DEX Scanner ──\n');
  
  // Get HYPE price
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  const prices: Record<string, number> = {};
  for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
    prices[hlData[0].universe[i].name] = parseFloat(hlData[1]?.[i]?.markPx || '0');
  }
  console.log(`HYPE: $${prices['HYPE']?.toFixed(2)} | BTC: $${prices['BTC']?.toFixed(2)} | ETH: $${prices['ETH']?.toFixed(2)}\n`);
  
  // Scan ALL V3 pools
  console.log('── ALL HyperSwap V3 Pools ──\n');
  console.log('Pair            | Fee    | Price        | Implied $   | HL $        | Spread %  | Liquidity');
  console.log('────────────────|────────|──────────────|─────────────|─────────────|───────────|──────────');
  
  for (const pool of HYPERSWAP_V3_POOLS) {
    try {
      const slot0 = await ethCall(pool.address, '0x3850c7bd');
      if (slot0.length < 66 || slot0 === '0x') continue;
      const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
      if (sqrtPrice === 0n) continue;
      
      const [sym0, sym1] = pool.pair.split('/');
      const dec0 = sym0 === 'USDC' || sym0 === 'USDT0' ? 6 : 18;
      const dec1 = sym1 === 'USDC' || sym1 === 'USDT0' ? 6 : 18;
      const price = v3PriceToHuman(sqrtPrice, dec0, dec1);
      
      const liqRes = await ethCall(pool.address, '0x1a686502');
      const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
      
      // Calculate implied USD price
      let impliedUsd = 0;
      let hlPrice = 0;
      if (sym0 === 'WHYPE') { impliedUsd = 1 / price * prices['HYPE']; hlPrice = prices['HYPE']; }
      else if (sym1 === 'WHYPE') { impliedUsd = price * prices['HYPE']; hlPrice = prices['HYPE']; }
      else if (sym0 === 'USDC' || sym0 === 'USDT0') { impliedUsd = price; hlPrice = 1; }
      
      const spread = hlPrice > 0 ? ((impliedUsd - hlPrice) / hlPrice * 100) : 0;
      const liqUsd = liquidity * (prices['HYPE'] || 87);
      
      console.log(`${pool.pair.padEnd(16)}| ${pool.fee.toString().padStart(6)}| ${price.toFixed(8).padStart(12)}| $${impliedUsd.toFixed(4).padStart(11)}| $${hlPrice.toFixed(4).padStart(11)}| ${spread.toFixed(3).padStart(9)}%| $${liqUsd.toFixed(0).padStart(8)}`);
    } catch {}
  }
  
  // Find arb opportunities
  console.log('\n── Arb Opportunities ──\n');
  console.log('  Cross-pool: same pair, different fee tiers');
  console.log('  Cross-DEX: V2 vs V3 for same pair');
  console.log('  Stablecoin: USDC/USDT0 depeg');
  console.log('  LST: kHYPE/WHYPE discount');
}
main().catch(console.error);
