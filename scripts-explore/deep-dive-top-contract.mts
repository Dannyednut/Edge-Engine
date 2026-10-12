/**
 * DEEP DIVE: Most Called Contract on HyperEVM
 * 0x233ff29b239abc1d7748605da9b205c3e008626e — 38 calls in 20 blocks
 * This is the MOST active contract — need to identify what it is
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function main() {
  console.log('── DEEP DIVE: Most Active Contract ──\n');
  
  const addr = '0x233ff29b239abc1d7748605da9b205c3e008626e';
  console.log(`Address: ${addr}`);
  console.log(`Calls: 38 in 20 blocks (most active)\n`);

  // Try many function signatures
  const fns = [
    { sig: '0x06fdde03', name: 'name()' },
    { sig: '0x95d89b41', name: 'symbol()' },
    { sig: '0x18160ddd', name: 'totalSupply()' },
    { sig: '0x313ce567', name: 'decimals()' },
    { sig: '0x8da5cb5b', name: 'owner()' },
    { sig: '0x3850c7bd', name: 'slot0()' },
    { sig: '0x1a686502', name: 'liquidity()' },
    { sig: '0x01e1d114', name: 'totalAssets()' },
    { sig: '0x620ee13c', name: 'exchangeRate()' },
    { sig: '0xfeaf968c', name: 'latestRoundData()' },
    { sig: '0x50d25bcd', name: 'price()' },
    { sig: '0xb3596f07', name: 'getAssetPrice()' },
    { sig: '0x70a08231', name: 'balanceOf(address)' }, // needs param
    { sig: '0xdd62ed3e', name: 'allowance(address,address)' }, // needs param
    { sig: '0x06661abd', name: 'getOwner()' },
    { sig: '0x2b7ac8d5', name: 'getVaultInfo()' },
    { sig: '0xc4d7dba6', name: 'getMarketInfo()' },
    { sig: '0xf889ea06', name: 'getOrderBook()' },
    { sig: '0xe9c8a263', name: 'getTotalStaked()' },
    { sig: '0x4ec26088', name: 'getMarketInfo()' },
    // HyperSwap V3 specific
    { sig: '0xd0c93a7c', name: 'factory()' },
    { sig: '0x0dfe1681', name: 'token0()' },
    { sig: '0xd21220a7', name: 'token1()' },
    { sig: '0xddca3f43', name: 'fee()' },
    { sig: '0x1b95bc14', name: 'tickSpacing()' },
    { sig: '0x49c77dba', name: 'maxLiquidityPerTick()' },
    // Lending specific
    { sig: '0x3582d8e2', name: 'getAccountInfo()' },
    { sig: '0xbf92857c', name: 'getReserves()' },
    { sig: '0x0902f1ac', name: 'getReserves() V2' },
    // Staking specific
    { sig: '0xa694fc3a', name: 'stake()' },
    { sig: '0x2e17de78', name: 'unstake()' },
  ];

  console.log('Probing 30 function signatures:\n');
  for (const fn of fns) {
    try {
      const result = await ethCall(addr, fn.sig);
      if (result && result !== '0x' && result.length > 10) {
        let decoded = result.substring(0, 80);
        
        // Try string decode for name/symbol
        if (fn.name.includes('name') || fn.name.includes('symbol')) {
          const str = Buffer.from(result.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
          if (str.length > 0 && str.length < 50 && /^[\x20-\x7E]+$/.test(str)) {
            decoded = str;
          }
        }
        // Try number decode
        else if (result.length >= 66) {
          const num = BigInt('0x' + result.slice(2, 66));
          if (num > 0 && num < 10n**30n) {
            decoded = num.toString();
          }
        }
        // Try address decode (for token0, token1, owner, factory)
        if (fn.name.includes('token') || fn.name.includes('owner') || fn.name.includes('factory')) {
          if (result.length >= 66) {
            const addr2 = '0x' + result.slice(26, 66);
            decoded = addr2;
          }
        }
        
        console.log(`  ✅ ${fn.name}: ${decoded}`);
      }
    } catch {}
  }

  console.log('\n── Analysis ──\n');
  console.log('  If token0/token1 respond → it\'s a HyperSwap V3 pool');
  console.log('  If factory responds → it\'s a V3 pool');
  console.log('  If name/symbol respond → it\'s an ERC20 token');
  console.log('  If totalAssets responds → it\'s a lending vault');
  console.log('  If exchangeRate responds → it\'s an LST');
  console.log('  If price responds → it\'s an oracle');
  console.log('');
  console.log('  This contract receives 38 calls per 20 blocks (~2/block)');
  console.log('  This is HIGH activity → likely a popular DeFi contract');
}
main().catch(console.error);
