const RPC = 'https://rpc.hyperliquid.xyz/evm';
const HL_API = 'https://api.hyperliquid.xyz/info';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── UBTC vs HL BTC Price Comparison ──\n');
  
  // Get HL BTC price
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  let hlBtc = 0;
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].name === 'BTC') { hlBtc = parseFloat(ctxs[i]?.markPx || '0'); break; }
  }
  console.log(`HL BTC perp: $${hlBtc.toFixed(2)}`);

  // Get UBTC on HyperEVM
  // UBTC = 0x9fdbda0a5e284c32744d2f17ee5c74b284993463
  // Check HyperSwap V3 for UBTC/WHYPE pool
  // Or check UBTC/USDC pool
  
  // Try to get UBTC price from a HyperSwap V3 pool
  // We need to find the pool address
  // For now, check UBTC decimals and supply
  const ubtcAddr = '0x9fdbda0a5e284c32744d2f17ee5c74b284993463';
  
  const decRes = await ethCall(ubtcAddr, '0x313ce567');
  const decimals = parseInt(BigInt('0x' + decRes.slice(2, 66)));
  console.log(`UBTC decimals: ${decimals}`);
  
  const supRes = await ethCall(ubtcAddr, '0x18160ddd');
  const supply = Number(BigInt('0x' + supRes.slice(2, 66))) / Math.pow(10, decimals);
  console.log(`UBTC total supply: ${supply.toFixed(4)} BTC ($${(supply * hlBtc).toLocaleString()})`);
  
  // Check UBTC/WHYPE pool on HyperSwap V3
  // We know WHYPE/UBTC pools exist in our config
  console.log('\nChecking HyperSwap V3 WHYPE/UBTC pools...');
  
  // From HYPERSWAP_V3_POOLS config:
  const pools = [
    { fee: 100, addr: '0x...' }, // Need actual addresses
  ];
  
  // Let's try the known WHYPE/UBTC pool addresses from our config
  const knownPools = [
    '0x' + '0'.repeat(40), // placeholder
  ];
  
  // Actually, let's check from the HYPERSWAP_V3_POOLS constant
  console.log('  Need to check HyperSwap V3 WHYPE/UBTC pool');
  console.log('  If UBTC price ≠ HL BTC price → arb opportunity');
  console.log('');
  console.log('  Strategy:');
  console.log('    1. Flashloan USDC on HyperEVM');
  console.log('    2. Buy UBTC on HyperSwap (if cheaper)');
  console.log('    3. Short HL BTC perp (hedge)');
  console.log('    4. Redeem UBTC for BTC (if redeemable)');
  console.log('    5. Or: sell UBTC on HyperSwap (if premium)');
  console.log('    6. Repay flashloan');
  console.log('    7. All atomic on HyperEVM');
}
main().catch(console.error);
