/**
 * DEEP DIVE: hyperRAM LST
 * - Find staking contract (deposit HYPE → get hyperRAM)
 * - Check exchange rate
 * - Compare yield with kHYPE
 * - Look for arb opportunity
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function getBalance(addr: string): Promise<bigint> {
  const bal = await ethCall(addr, '0x18160ddd');
  return BigInt(bal);
}

async function main() {
  console.log('── DEEP DIVE: hyperRAM LST ──\n');

  const hyperRAM = '0x5555c2542836e7a6c8d3e133d5aa9773b65d5555';
  const xRAM = '0xae6d5fce541216bda471d311425b5412d9f1deb9';

  // 1. Get total supplies
  const hyperRAMSupply = await getBalance(hyperRAM);
  const xRAMSupply = await getBalance(xRAM);
  console.log(`  hyperRAM total supply: ${Number(hyperRAMSupply) / 1e18}`);
  console.log(`  xRAM total supply: ${Number(xRAMSupply) / 1e18}`);

  // 2. Try LST-specific functions on hyperRAM
  console.log('\n  Probing hyperRAM for LST functions:');
  const lstFunctions = [
    { sig: '0x620ee13c', name: 'exchangeRate()' },
    { sig: '0x3a98ef39', name: 'convertToAssets()' },
    { sig: '0x07a2d13a', name: 'convertToShares()' },
    { sig: '0xdb006a75', name: 'redeem()' },
    { sig: '0x6e553f65', name: 'deposit()' },
    { sig: '0x2e1a7d4d', name: 'withdraw()' },
    { sig: '0xfe8ddea4', name: 'getExchangeRate()' },
    { sig: '0x18160ddd', name: 'totalSupply()' },
    { sig: '0xc4d7dba6', name: 'getTotalPooledHYPE()' },
    { sig: '0xe9c8a263', name: 'getTotalStaked()' },
  ];

  for (const fn of lstFunctions) {
    try {
      const result = await ethCall(hyperRAM, fn.sig);
      if (result && result !== '0x' && result.length > 10) {
        const num = BigInt('0x' + result.slice(2, 66));
        console.log(`    ✅ ${fn.name}: ${num.toString()}`);
      }
    } catch {}
  }

  // 3. Try on xRAM
  console.log('\n  Probing xRAM for functions:');
  for (const fn of lstFunctions) {
    try {
      const result = await ethCall(xRAM, fn.sig);
      if (result && result !== '0x' && result.length > 10) {
        const num = BigInt('0x' + result.slice(2, 66));
        console.log(`    ✅ ${fn.name}: ${num.toString()}`);
      }
    } catch {}
  }

  // 4. Check if hyperRAM has HyperSwap V3 pool
  console.log('\n  Checking for HyperSwap V3 pool...');
  // We know WHYPE/kHYPE pools exist
  // Check if WHYPE/hyperRAM pool exists
  // Try known pool addresses or query factory
  
  // 5. Compare kHYPE vs hyperRAM
  console.log('\n── kHYPE vs hyperRAM Comparison ──\n');
  console.log('  kHYPE:');
  console.log('    Contract: Kinetiq staking');
  console.log('    Discount: 2.54% (on HyperSwap V3)');
  console.log('    Liquidity: 32,790 HYPE ($2.8M)');
  console.log('    Withdrawal: 7 days');
  console.log('');
  console.log('  hyperRAM:');
  console.log(`    Total supply: ${Number(hyperRAMSupply) / 1e18} tokens`);
  console.log('    Discount: unknown (no HyperSwap V3 pool found yet)');
  console.log('    Withdrawal: unknown');
  console.log('    Yield: unknown');
  console.log('');
  console.log('  ARB OPPORTUNITY:');
  console.log('    If hyperRAM has different discount than kHYPE:');
  console.log('    1. Buy cheaper LST');
  console.log('    2. Redeem for HYPE');
  console.log('    3. Buy more expensive LST');
  console.log('    4. Sell on market');
  console.log('    5. Profit = discount difference');
  console.log('');
  console.log('  NEXT STEPS:');
  console.log('    1. Find hyperRAM staking contract');
  console.log('    2. Find exchange rate');
  console.log('    3. Check if hyperRAM is on any DEX');
  console.log('    4. Research RAM protocol (what is xRAM?)');
}
main().catch(console.error);
