const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}
async function main() {
  console.log('── Stablecoin Price Check on HyperEVM ──\n');
  
  // USDC: 0xb88339cb7199b77e23db6e890353e22632ba630f (6 decimals)
  // USDT0: 0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb (6 decimals)
  
  // Check HyperSwap V3 USDC/USDT0 pool
  const poolAddr = '0x' + '0'.repeat(40); // Need actual pool address
  
  // Instead, check balances of USDC and USDT0 in top contracts
  const usdc = '0xb88339cb7199b77e23db6e890353e22632ba630f';
  const usdt0 = '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb';
  
  // Get total supplies
  const usdcSup = await ethCall(usdc, '0x18160ddd');
  const usdt0Sup = await ethCall(usdt0, '0x18160ddd');
  
  console.log(`USDC total supply: ${Number(BigInt(usdcSup)) / 1e6}`);
  console.log(`USDT0 total supply: ${Number(BigInt(usdt0Sup)) / 1e6}`);
  
  // Check if USDC/USDT0 HyperSwap V2 pool exists
  // USDC/USDT0 pool address from config
  console.log('\n  USDC and USDT0 are both on HyperEVM');
  console.log('  If they trade at different prices → stablecoin arb');
  console.log('  Check HyperSwap V2/V3 for USDC/USDT0 pool');
  console.log('  If pool exists and price ≠ 1.000 → arb opportunity');
}
main().catch(console.error);
