import { HYPERSWAP_V3_POOLS, v3PriceToHuman } from '../packages/scanner/src/lib/hyperliquid-defi.ts';

const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── WHYPE/UBTC Pool Price Check ──\n');
  
  // Find WHYPE/UBTC pools
  const ubtcPools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/UBTC');
  console.log(`Found ${ubtcPools.length} WHYPE/UBTC pools\n`);
  
  for (const pool of ubtcPools) {
    const slot0 = await ethCall(pool.address, '0x3850c7bd');
    const liqRes = await ethCall(pool.address, '0x1a686502');
    
    if (slot0.length < 66) { console.log(`  ${pool.fee}bps: no data`); continue; }
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    if (sqrtPrice === 0n) { console.log(`  ${pool.fee}bps: no price`); continue; }
    
    const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
    // WHYPE = 18 decimals, UBTC = 8 decimals
    const price = v3PriceToHuman(sqrtPrice, 18, 8);
    // price = UBTC per WHYPE, need to invert
    const ubtcPerWhype = 1 / price;
    
    // Get HYPE price from HL
    const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    });
    const hlData = await hlRes.json();
    let hypePrice = 0, btcPrice = 0;
    for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
      if (hlData[0].universe[i].name === 'HYPE') hypePrice = parseFloat(hlData[1][i]?.markPx || '0');
      if (hlData[0].universe[i].name === 'BTC') btcPrice = parseFloat(hlData[1][i]?.markPx || '0');
    }
    
    // UBTC price in USD = WHYPE price × (UBTC per WHYPE)
    const ubtcPriceUsd = hypePrice * ubtcPerWhype;
    const spread = ((ubtcPriceUsd - btcPrice) / btcPrice * 100);
    
    console.log(`  ${pool.fee}bps: UBTC/WHYPE=${ubtcPerWhype.toFixed(8)}  UBTC=$${ubtcPriceUsd.toFixed(2)}  HL BTC=$${btcPrice.toFixed(2)}  spread=${spread.toFixed(3)}%  liq=${liquidity.toFixed(2)}`);
    
    if (Math.abs(spread) > 0.1 && liquidity > 0) {
      console.log(`    ⚠️ ARB OPPORTUNITY! Spread = ${spread.toFixed(3)}%`);
      console.log(`    If UBTC cheaper: buy UBTC on HyperSwap, short HL BTC perp`);
      console.log(`    If UBTC expensive: sell UBTC on HyperSwap, long HL BTC perp`);
    }
  }
  
  // Also check WHYPE/UETH
  console.log('\n── WHYPE/UETH Pool Price Check ──\n');
  const uethPools = HYPERSWAP_V3_POOLS.filter(p => p.pair === 'WHYPE/UETH');
  for (const pool of uethPools) {
    const slot0 = await ethCall(pool.address, '0x3850c7bd');
    const liqRes = await ethCall(pool.address, '0x1a686502');
    if (slot0.length < 66) { console.log(`  ${pool.fee}bps: no data`); continue; }
    const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
    if (sqrtPrice === 0n) { console.log(`  ${pool.fee}bps: no price`); continue; }
    const liquidity = liqRes.length >= 66 ? Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18 : 0;
    const price = v3PriceToHuman(sqrtPrice, 18, 18);
    const uethPerWhype = 1 / price;
    
    let ethPrice = 0;
    const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    });
    const hlData = await hlRes.json();
    let hypePrice = 0;
    for (let i = 0; i < (hlData?.[0]?.universe || []).length; i++) {
      if (hlData[0].universe[i].name === 'HYPE') hypePrice = parseFloat(hlData[1][i]?.markPx || '0');
      if (hlData[0].universe[i].name === 'ETH') ethPrice = parseFloat(hlData[1][i]?.markPx || '0');
    }
    
    const uethPriceUsd = hypePrice * uethPerWhype;
    const spread = ((uethPriceUsd - ethPrice) / ethPrice * 100);
    console.log(`  ${pool.fee}bps: UETH/WHYPE=${uethPerWhype.toFixed(6)}  UETH=$${uethPriceUsd.toFixed(2)}  HL ETH=$${ethPrice.toFixed(2)}  spread=${spread.toFixed(3)}%  liq=${liquidity.toFixed(2)}`);
  }
}
main().catch(console.error);
