/**
 * Token Address Catalog
 * Discovered from HyperEVM transfer monitor:
 * - USDC: 0xb88339cb7199b77e23db6e890353e22632ba630f
 * - WHYPE: 0x5555555555555555555555555555555555555555
 * - Paper: 0xe40f17915daa230324030003a197cdaef2261c0e
 * - USD₮0: 0xb8ce59fc3717ada4c02eadf9682a9e9e934f625ebb
 * - Unit Pump: 0x27ec642013bcb3d80ca3706599d3cda04f6f4452
 * - Unit Bitcoin: 0x9fdbda0a5e284c32744d2f17ee5c74b284993463
 * - Unit Ethereum: 0xbe6727b535545c67d5caa73dea54865b92cf7907
 * - kHYPE: 0xfd739d4e423301ce9385c1fb8850539d657c296d
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }) });
  return (await r.json()).result || '0x';
}

async function main() {
  console.log('── HyperEVM Token Address Catalog ──\n');

  const tokens = [
    { name: 'USDC', addr: '0xb88339cb7199b77e23db6e890353e22632ba630f' },
    { name: 'WHYPE', addr: '0x5555555555555555555555555555555555555555' },
    { name: 'Paper', addr: '0xe40f17915daa230324030003a197cdaef2261c0e' },
    { name: 'USD₮0', addr: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb' },
    { name: 'Unit Pump', addr: '0x27ec642013bcb3d80ca3706599d3cda04f6f4452' },
    { name: 'Unit Bitcoin', addr: '0x9fdbda0a5e284c32744d2f17ee5c74b284993463' },
    { name: 'Unit Ethereum', addr: '0xbe6727b535545c67d5caa73dea54865b92cf7907' },
    { name: 'kHYPE', addr: '0xfd739d4e423301ce9385c1fb8850539d657c296d' },
    { name: 'hyperRAM', addr: '0x5555c2542836e7a6c8d3e133d5aa9773b65d5555' },
    { name: 'xRAM', addr: '0xae6d5fce541216bda471d311425b5412d9f1deb9' },
  ];

  console.log('Name              | Address                                      | Symbol    | Decimals | Total Supply');
  console.log('──────────────────|──────────────────────────────────────────────|──────────|──────────|─────────────');
  
  for (const t of tokens) {
    try {
      const symRes = await ethCall(t.addr, '0x95d89b41');
      const decRes = await ethCall(t.addr, '0x313ce567');
      const supRes = await ethCall(t.addr, '0x18160ddd');
      
      let symbol = '?';
      if (symRes && symRes !== '0x' && symRes.length > 10) {
        symbol = Buffer.from(symRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
      }
      
      let decimals = '?';
      if (decRes && decRes !== '0x' && decRes.length >= 66) {
        decimals = parseInt(BigInt('0x' + decRes.slice(2, 66))).toString();
      }
      
      let supply = '?';
      if (supRes && supRes !== '0x' && supRes.length >= 66) {
        const num = Number(BigInt('0x' + supRes.slice(2, 66)));
        const dec = parseInt(decimals) || 18;
        supply = (num / Math.pow(10, dec)).toFixed(0);
      }
      
      console.log(`${t.name.padEnd(18)}| ${t.addr}| ${symbol.padEnd(8)}| ${decimals.padStart(8)}| ${supply}`);
    } catch (e: any) {
      console.log(`${t.name.padEnd(18)}| ${t.addr}| ERROR: ${e.message?.substring(0, 30)}`);
    }
  }

  console.log('\n── Arb Opportunities ──\n');
  console.log('  1. UBTC (Unit Bitcoin) vs HL BTC perp');
  console.log('     - If UBTC trades at different price than HL BTC → arb');
  console.log('     - Flashloan UBTC on HyperEVM, sell HL BTC perp');
  console.log('');
  console.log('  2. UETH (Unit Ethereum) vs HL ETH perp');
  console.log('     - Same concept as UBTC');
  console.log('');
  console.log('  3. USDC vs USD₮0 (stablecoin arb)');
  console.log('     - If USDC ≠ USD₮0 on HyperSwap → arb');
  console.log('');
  console.log('  4. kHYPE vs hyperRAM (LST arb)');
  console.log('     - Compare discounts');
  console.log('     - Buy cheaper, redeem, buy expensive');
}
main().catch(console.error);
