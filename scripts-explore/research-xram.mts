/**
 * Research: xRAM + hyperRAM — NEW LST on HyperEVM
 * 
 * Discovered via contract scanner:
 * - xRAM token: 0xae6d5fce541216bda471d311425b5412d9f1deb9
 * - hyperRAM LST: 0x5555c2542836e7a6c8d3e133d5aa9773b65d5555
 * 
 * This is a NEW liquid staking protocol on HyperEVM
 * Potential: arb between hyperRAM and kHYPE (two LSTs)
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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RESEARCH: xRAM + hyperRAM — NEW LST Discovery');
  console.log('═══════════════════════════════════════════════════\n');

  const xRAM = '0xae6d5fce541216bda471d311425b5412d9f1deb9';
  const hyperRAM = '0x5555c2542836e7a6c8d3e133d5aa9773b65d5555';

  // 1. Get token details
  console.log('── xRAM Token Details ──\n');
  
  // totalSupply()
  const totalSupply = await ethCall(xRAM, '0x18160ddd');
  console.log(`  Total supply: ${Number(BigInt(totalSupply)) / 1e18}`);

  // name()
  const nameRes = await ethCall(xRAM, '0x06fdde03');
  const name = Buffer.from(nameRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
  console.log(`  Name: ${name}`);

  // symbol()
  const symRes = await ethCall(xRAM, '0x95d89b41');
  const symbol = Buffer.from(symRes.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim();
  console.log(`  Symbol: ${symbol}`);

  // 2. Get hyperRAM LST details
  console.log('\n── hyperRAM LST Details ──\n');
  
  const hTotalSupply = await ethCall(hyperRAM, '0x18160ddd');
  console.log(`  Total supply: ${Number(BigInt(hTotalSupply)) / 1e18}`);

  const hName = await ethCall(hyperRAM, '0x06fdde03');
  console.log(`  Name: ${Buffer.from(hName.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim()}`);

  const hSym = await ethCall(hyperRAM, '0x95d89b41');
  console.log(`  Symbol: ${Buffer.from(hSym.slice(2), 'hex').toString('utf8').replace(/\0/g, '').trim()}`);

  // 3. Check if hyperRAM is on HyperSwap V3
  console.log('\n── Check HyperSwap V3 for hyperRAM pool ──\n');
  // We'd need to check the factory for pool existence
  // For now, check if the contract has any HyperSwap-like functions
  
  // 4. Compare with kHYPE
  console.log('── LST Comparison: kHYPE vs hyperRAM ──\n');
  console.log('  kHYPE:');
  console.log('    - Kinetiq staking protocol');
  console.log('    - 7-day withdrawal');
  console.log('    - ~2.49% discount on HyperSwap V3');
  console.log('    - 1.7% APR');
  console.log('');
  console.log('  hyperRAM:');
  console.log('    - NEW liquid staking protocol');
  console.log('    - Unknown withdrawal period');
  console.log('    - Unknown discount');
  console.log('    - Unknown APR');
  console.log('    - NEED TO RESEARCH FURTHER');

  // 5. Arb potential
  console.log('\n── Arb Potential ──\n');
  console.log('  If both kHYPE and hyperRAM trade on HyperSwap V3:');
  console.log('    1. Compare discounts (kHYPE vs hyperRAM)');
  console.log('    2. If one is cheaper, buy it, redeem for HYPE');
  console.log('    3. Re-stake into the more expensive LST');
  console.log('    4. Capture the discount difference');
  console.log('');
  console.log('  Or:');
  console.log('    1. Flashloan USDC');
  console.log('    2. Buy cheaper LST');
  console.log('    3. Swap for WHYPE');
  console.log('    4. Buy more expensive LST');
  console.log('    5. Sell on HyperSwap');
  console.log('    6. Repay flashloan');
  console.log('    7. Profit = discount difference');

  console.log('\n── Next Research Steps ──\n');
  console.log('  1. Find hyperRAM staking contract (where you deposit HYPE to get hyperRAM)');
  console.log('  2. Check if hyperRAM is on HyperSwap V3');
  console.log('  3. Compare withdrawal periods (kHYPE 7d vs hyperRAM ?)');
  console.log('  4. Compare APRs');
  console.log('  5. Look for arb between kHYPE and hyperRAM');
  console.log('  6. Research RAM protocol (what is xRAM?)');
}

main().catch(console.error);
