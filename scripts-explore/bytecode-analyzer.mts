const RPC = 'https://rpc.hyperliquid.xyz/evm';
async function getCode(addr: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [addr, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}
async function main() {
  console.log('── HyperEVM Bytecode Analyzer ──\n');
  const contracts = [
    '0xd78d199f8c402e7b5cc2abe278df0412400a3bae', // 18KB - largest
    '0x233ff29b239abc1d7748605da9b205c3e008626e', // most active (38 calls)
    '0x5555c2542836e7a6c8d3e133d5aa9773b65d5555', // hyperRAM
    '0xae6d5fce541216bda471d311425b5412d9f1deb9', // xRAM
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // unknown 13KB
  ];
  for (const addr of contracts) {
    const code = await getCode(addr);
    const size = (code.length - 2) / 2;
    // Check for known function selectors in bytecode
    const selectors: string[] = [];
    const knownSelectors: Record<string, string> = {
      'a9059cbb': 'transfer(address,uint256)',
      '70a08231': 'balanceOf(address)',
      '18160ddd': 'totalSupply()',
      '95d89b41': 'symbol()',
      '06fdde03': 'name()',
      '313ce567': 'decimals()',
      'dd62ed3e': 'allowance(address,address)',
      '095ea7b3': 'approve(address,uint256)',
      '23b872dd': 'transferFrom(address,address,uint256)',
      '3850c7bd': 'slot0()',
      '1a686502': 'liquidity()',
      '0902f1ac': 'getReserves()',
      '8da5cb5b': 'owner()',
      'f2fde38b': 'transferOwnership(address)',
    };
    for (const [sel, name] of Object.entries(knownSelectors)) {
      if (code.includes(sel)) selectors.push(name);
    }
    console.log(`${addr} (${size} bytes):`);
    console.log(`  Functions: ${selectors.length > 0 ? selectors.join(', ') : 'none found'}`);
    if (selectors.includes('name()') && selectors.includes('symbol()') && selectors.includes('totalSupply()')) {
      console.log(`  → ERC20 token contract`);
    } else if (selectors.includes('slot0()') && selectors.includes('liquidity()')) {
      console.log(`  → Uniswap V3 pool contract`);
    } else if (selectors.includes('getReserves()')) {
      console.log(`  → Uniswap V2 pool contract`);
    } else if (selectors.includes('owner()') && selectors.includes('transferOwnership(address)')) {
      console.log(`  → Ownable contract`);
    }
    console.log('');
  }
}
main().catch(console.error);
