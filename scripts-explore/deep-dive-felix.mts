/**
 * DEEP DIVE: Felix Finance
 * Investigate contracts with owners found
 * 0x6131b5fae19ea4f9d964eac0408e4408b66337b5 — owner: 0x1874028262f1f4b2dd1f2700a72ee8b9b7c69090
 * 0xc09ee0453b1aa59b896877c98e03e646f5baf819 — owner: 0xd6e3c0089f6c260109a2a54d2441d5d4743801cd
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
  console.log('── DEEP DIVE: Felix Finance ──\n');

  const contracts = [
    { addr: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', owner: '0x1874028262f1f4b2dd1f2700a72ee8b9b7c69090' },
    { addr: '0xc09ee0453b1aa59b896877c98e03e646f5baf819', owner: '0xd6e3c0089f6c260109a2a54d2441d5d4743801cd' },
    { addr: '0xd78d199f8c402e7b5cc2abe278df0412400a3bae', owner: 'unknown' },
    { addr: '0xac12919599eb6e6dd3bdd7a993da48440da49f9d', owner: 'unknown' },
    { addr: '0x382e5db8ec64e8506879b94568b41d159d64577f', owner: 'unknown' },
  ];

  // Try common DeFi function signatures
  const functions = [
    { sig: '0x06fdde03', name: 'name()' },
    { sig: '0x95d89b41', name: 'symbol()' },
    { sig: '0x18160ddd', name: 'totalSupply()' },
    { sig: '0x313ce567', name: 'decimals()' },
    { sig: '0x8da5cb5b', name: 'owner()' },
    { sig: '0x06661abd', name: 'getOwner()' },
    { sig: '0x3850c7bd', name: 'slot0() (V3 pool)' },
    { sig: '0x1a686502', name: 'liquidity() (V3 pool)' },
    { sig: '0x01e1d114', name: 'totalAssets() (ERC4626)' },
    { sig: '0xba087652', name: 'redeem() (ERC4626)' },
    { sig: '0x620ee13c', name: 'exchangeRate() (LST)' },
    { sig: '0x095ea7b3', name: 'allowance() (ERC20)' },
    { sig: '0x70a08231', name: 'balanceOf() (ERC20)' },
    { sig: '0xfeaf968c', name: 'latestRoundData() (oracle)' },
    { sig: '0x50d25bcd', name: 'price() (oracle)' },
    { sig: '0xb3596f07', name: 'getAssetPrice() (lending)' },
    { sig: '0x3582d8e2', name: 'getAccountInfo() (lending)' },
    { sig: '0x4ec26088', name: 'getMarketInfo() (DEX)' },
    { sig: '0xf889ea06', name: 'getOrderBook() (orderbook DEX)' },
    { sig: '0x2b7ac8d5', name: 'getVaultInfo() (vault)' },
  ];

  for (const c of contracts) {
    console.log(`\n── ${c.addr} ──`);
    for (const fn of functions) {
      try {
        const result = await ethCall(c.addr, fn.sig);
        if (result && result !== '0x' && result.length > 10) {
          let decoded = result;
          // Try to decode as string (for name/symbol)
          if (fn.name.includes('name') || fn.name.includes('symbol')) {
            const hex = result.slice(2);
            const str = Buffer.from(hex, 'hex').toString('utf8').replace(/\0/g, '').trim();
            if (str.length > 0 && str.length < 50 && /^[\x20-\x7E]+$/.test(str)) {
              decoded = str;
            }
          }
          // Try to decode as number
          else if (result.length >= 66) {
            const num = BigInt('0x' + result.slice(2, 66));
            if (num > 0 && num < 10n**30n) {
              decoded = num.toString();
            }
          }
          console.log(`  ✅ ${fn.name}: ${decoded.substring(0, 80)}`);
        }
      } catch {}
    }
  }

  // Check owners for more info
  console.log('\n── Owner Analysis ──\n');
  for (const c of contracts) {
    if (c.owner === 'unknown') continue;
    // Check if owner is a contract (proxy?)
    const ownerCode = await ethCall(c.owner, '0x');
    console.log(`  Owner ${c.owner}: ${ownerCode && ownerCode !== '0x' ? 'contract' : 'EOA'}`);
  }
}
main().catch(console.error);
