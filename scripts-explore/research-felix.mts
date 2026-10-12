/**
 * Research: Felix Finance — Perp DEX on HyperEVM
 */
async function main() {
  console.log('── Felix Finance Research ──\n');
  console.log('Felix = perp DEX on HyperEVM (alternative to HL)');
  console.log('Website: felix.xyz or felixfinance.xyz');
  console.log('');
  
  // Try to find Felix contracts
  const RPC = 'https://rpc.hyperliquid.xyz/evm';
  async function getCode(addr: string) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [addr, 'latest'], id: 1 }),
    });
    const data = await res.json() as any;
    return data.result;
  }

  // Check common Felix addresses (guessed)
  const candidates = [
    '0xfe1ix000000000000000000000000000000000000',
    '0xFelix000000000000000000000000000000000000',
  ];
  
  console.log('Searching for Felix contracts...');
  // Also check the large unknown contracts from earlier scan
  const unknownContracts = [
    '0xd78d199f8c402e7b5cc2abe278df0412400a3bae', // 18KB
    '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // 13KB
    '0xc09ee0453b1aa59b896877c98e03e646f5baf819', // 13KB
  ];
  
  for (const addr of unknownContracts) {
    // Try to call owner() — common in DEX contracts
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: addr, data: '0x8da5cb5b' }, 'latest'], id: 1 }),
      });
      const data = await res.json() as any;
      if (data.result && data.result !== '0x' && data.result.length > 10) {
        const owner = '0x' + data.result.slice(26);
        console.log(`  ${addr}: owner=${owner}`);
      }
    } catch {}
    
    // Try getOwner() 
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: addr, data: '0x893d20e8' }, 'latest'], id: 1 }),
      });
      const data = await res.json() as any;
      if (data.result && data.result !== '0x' && data.result.length > 10) {
        const owner = '0x' + data.result.slice(26);
        console.log(`  ${addr}: getOwner=${owner}`);
      }
    } catch {}
  }

  console.log('\n── Felix Arb Potential ──\n');
  console.log('  If Felix has same perps as HL:');
  console.log('    1. Compare Felix perp price vs HL perp price');
  console.log('    2. If spread > fees, arb exists');
  console.log('    3. Buy on cheaper venue, sell on expensive');
  console.log('    4. Both on HyperEVM — atomic execution possible!');
  console.log('');
  console.log('  Advantage over CEX-HL arb:');
  console.log('    - No bridge needed (both on HyperEVM)');
  console.log('    - Atomic execution (flashloan + both legs in one tx)');
  console.log('    - Lower fees (no CEX withdrawal)');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Find Felix contract addresses');
  console.log('    2. Check if Felix has perp markets');
  console.log('    3. Compare prices with HL');
  console.log('    4. Build arb scanner');
}
main().catch(console.error);
