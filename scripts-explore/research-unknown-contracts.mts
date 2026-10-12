/**
 * Research: Unknown HyperEVM Contracts
 * 
 * Investigate the largest contracts found during scan:
 * 1. 0xd78d...3bae (18148 bytes) — LARGEST
 * 2. 0x0000...032 (16035 bytes)
 * 3. 0x6131...37b5 (13724 bytes)
 * 4. 0xc09e...f819 (13298 bytes)
 * 5. 0xac12...4f9d (12984 bytes)
 */

const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function rpc(method: string, params: any[] = []): Promise<any> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const data = await res.json() as any;
  return data.result;
}

async function ethCall(to: string, data: string): Promise<string> {
  return await rpc('eth_call', [{ to, data }, 'latest']);
}

async function tryERC20(addr: string): Promise<void> {
  try {
    const nameRes = await ethCall(addr, '0x06fdde03');
    if (nameRes && nameRes !== '0x' && nameRes.length > 10) {
      const name = Buffer.from(nameRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
      if (name && name.length > 0 && name.length < 50) {
        const symRes = await ethCall(addr, '0x95d89b41');
        const symbol = Buffer.from(symRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
        const totalRes = await ethCall(addr, '0x18160ddd');
        const totalSupply = Number(BigInt(totalRes)) / 1e18;
        console.log(`  ✅ ERC20: ${name} (${symbol}) supply=${totalSupply.toFixed(0)}`);
        return;
      }
    }
  } catch {}
  console.log(`  ❌ Not ERC20`);
}

async function tryLending(addr: string): Promise<void> {
  // Try common lending pool functions
  try {
    // totalAssets() — common in ERC4626 vaults
    const totalAssets = await ethCall(addr, '0x01e1d114');
    if (totalAssets && totalAssets !== '0x' && totalAssets.length > 10) {
      console.log(`  ✅ Possible lending vault (totalAssets: ${Number(BigInt(totalAssets)) / 1e18})`);
    }
  } catch {}
}

async function tryAMM(addr: string): Promise<void> {
  // Try slot0() — Uniswap V3 pools
  try {
    const slot0 = await ethCall(addr, '0x3850c7bd');
    if (slot0 && slot0 !== '0x' && slot0.length >= 66) {
      const sqrtPrice = BigInt('0x' + slot0.slice(2, 66));
      if (sqrtPrice > 0n) {
        const price = Number(sqrtPrice * sqrtPrice * 10n**18n / (2n**192n)) / 1e18;
        console.log(`  ✅ Possible AMM pool (price: ${price})`);
      }
    }
  } catch {}
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RESEARCH: Unknown HyperEVM Contracts');
  console.log('═══════════════════════════════════════════════════\n');

  const contracts = [
    { addr: '0xd78d199f8c402e7b5cc2abe278df0412400a3bae', size: 18148 },
    { addr: '0x0000000071727de22e5e9d8baf0edac6f37da032', size: 16035 },
    { addr: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', size: 13724 },
    { addr: '0xc09ee0453b1aa59b896877c98e03e646f5baf819', size: 13298 },
    { addr: '0xac12919599eb6e6dd3bdd7a993da48440da49f9d', size: 12984 },
    { addr: '0x382e5db8ec64e8506879b94568b41d159d64577f', size: 11993 },
    { addr: '0x1bd74c9001ba1b0536348cb8b081109ff87ac801', size: 11312 },
    { addr: '0xe647c33d2e96c989e9bcea92883d1a049787b512', size: 5193 },
    { addr: '0x1308d7b56641d4b096560d987b548c187561ff6c', size: 4969 },
  ];

  for (const c of contracts) {
    console.log(`\n── ${c.addr} (${c.size} bytes) ──`);
    await tryERC20(c.addr);
    await tryLending(c.addr);
    await tryAMM(c.addr);
  }

  console.log('\n── Analysis ──\n');
  console.log('  Known contracts:');
  console.log('    0x0000...032 = HyperLiquid native contract (system)');
  console.log('    0xd78d...3bae = Large contract (18KB) — likely a DEX or lending protocol');
  console.log('    0x6131...37b5 = Possible DeFi protocol (13KB)');
  console.log('    0xc09e...f819 = Possible DeFi protocol (13KB)');
  console.log('    0xac12...4f9d = Possible DeFi protocol (13KB)');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Decode contract ABI via bytecode analysis');
  console.log('    2. Check transaction history for usage patterns');
  console.log('    3. Look for function signatures in bytecode');
  console.log('    4. Try common DeFi function calls');
}

main().catch(console.error);
