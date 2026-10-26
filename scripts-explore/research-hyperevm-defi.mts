/**
 * Research: HyperEVM DeFi Ecosystem Deep Dive
 * 
 * Explores ALL DeFi protocols on HyperEVM:
 * - HyperSwap V3 (Uniswap fork)
 * - HyperLend (lending)
 * - Kinetiq (LST)
 * - Euler V2 (lending)
 * - Felix (derivatives)
 * - Hyperswap V2 (legacy)
 * - Any new protocols
 * 
 * Goal: Find unexplored arbitrage opportunities
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

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

async function getCode(addr: string): Promise<string> {
  return await rpc('eth_getCode', [addr, 'latest']);
}

async function getBalance(addr: string): Promise<number> {
  const bal = await rpc('eth_getBalance', [addr, 'latest']);
  return Number(BigInt(bal)) / 1e18;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RESEARCH: HyperEVM DeFi Ecosystem Deep Dive');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Known protocol addresses
  const protocols = [
    { name: 'HyperSwap V3 Factory', addr: '0xFaBd29ee07839225E7583d5A4b7E0d6A6F2B8A4c', type: 'AMM' },
    { name: 'HyperSwap V2 Factory', addr: '0x8cE2D14A7a5c1d5e3bB0d9c3E1F4A2b5C8d7E6f5', type: 'AMM' },
    { name: 'HyperLend Pool', addr: '0x0000000000000000000000000000000000000800', type: 'Lending' },
    { name: 'Kinetiq Staking', addr: '0x0000000000000000000000000000000000000801', type: 'LST' },
    { name: 'Euler V2 EVault', addr: '0x0000000000000000000000000000000000000802', type: 'Lending' },
    { name: 'CoreWriter', addr: '0x3333333333333333333333333333333333333333', type: 'HL Bridge' },
    { name: 'HL Perp Oracle', addr: '0x0000000000000000000000000000000000000807', type: 'Precompile' },
  ];

  console.log('── Known Protocol Verification ──\n');
  for (const p of protocols) {
    const code = await getCode(p.addr);
    const hasCode = code && code !== '0x' && code.length > 2;
    console.log(`  ${p.name.padEnd(25)} ${p.addr} | ${hasCode ? '✅ contract' : '⚠️  precompile/empty'} | ${p.type}`);
  }

  // 2. Scan for new contracts via logs
  console.log('\n── Recent Contract Deployments (via logs) ──\n');
  try {
    const latestBlock = parseInt(await rpc('eth_blockNumber'), 16);
    const fromBlock = '0x' + (latestBlock - 10000).toString(16); // last ~10k blocks
    
    const logs = await rpc('eth_getLogs', [{
      fromBlock,
      toBlock: 'latest',
      topics: ['0x' + '0'.repeat(64)], // topic0 = 0 (anonymous events)
    }]);
    
    if (Array.isArray(logs) && logs.length > 0) {
      console.log(`  Found ${logs.length} logs in last 10k blocks`);
      // Get unique contract addresses
      const addresses = new Set(logs.map((l: any) => l.address));
      console.log(`  Unique contracts emitting events: ${addresses.size}`);
      for (const addr of Array.from(addresses).slice(0, 20)) {
        console.log(`    ${addr}`);
      }
    } else {
      console.log('  No logs found in last 10k blocks');
    }
  } catch (e: any) {
    console.log(`  Error: ${e.message?.substring(0, 100)}`);
  }

  // 3. Check HyperSwap V3 pools
  console.log('\n── HyperSwap V3 Pool Scan ──\n');
  // Known V3 pools from our codebase
  const knownPools = [
    { pair: 'WHYPE/kHYPE', fee: 100, addr: '0x5cbe810071de393de35e574fb2830e16da794bab' },
    { pair: 'WHYPE/kHYPE', fee: 500, addr: '0x3fa4005668ae445e9cb88725fba8e8e88e508eb8' },
    { pair: 'WHYPE/kHYPE', fee: 3000, addr: '0xdf20a6a8a03ab178f7874303598bc0281eb13923' },
    { pair: 'WHYPE/kHYPE', fee: 10000, addr: '0x332ec9391bd388d561ff8837427fc08794b7eb72' },
  ];

  for (const pool of knownPools) {
    const code = await getCode(pool.addr);
    const hasCode = code && code !== '0x' && code.length > 2;
    if (hasCode) {
      // Get slot0 for price
      const slot0 = await rpc('eth_call', [{ to: pool.addr, data: '0x3850c7bd' }, 'latest']);
      let price = 'N/A';
      if (slot0 && slot0.length >= 66) {
        const sqrtPriceX96 = BigInt('0x' + slot0.slice(2, 66));
        if (sqrtPriceX96 > 0n) {
          const p = Number(sqrtPriceX96 * sqrtPriceX96 * 10n**18n / (2n**192n)) / 1e18;
          price = p.toFixed(6);
        }
      }
      // Get liquidity
      const liqRes = await rpc('eth_call', [{ to: pool.addr, data: '0x1a686502' }, 'latest']);
      let liq = '0';
      if (liqRes && liqRes.length >= 66) {
        liq = (Number(BigInt('0x' + liqRes.slice(2, 66))) / 1e18).toFixed(2);
      }
      console.log(`  ${pool.pair} ${pool.fee}bps: price=${price} liq=${liq} HYPE`);
    }
  }

  // 4. Explore: Felix Finance (new protocol)
  console.log('\n── Felix Finance Research ──\n');
  console.log('  Felix = Perpetual futures DEX on HyperEVM');
  console.log('  Alternative to HL perps but on HyperEVM');
  console.log('  Potential: arb between Felix perps and HL perps');
  console.log('  Need to find Felix contract addresses');
  console.log('  Search: docs.felix.xyz or felix.hyperliquid.xyz');

  // 5. Explore: HyperEVM bridge contracts
  console.log('\n── HyperEVM Bridge Research ──\n');
  console.log('  WHYPE = wrapped HYPE on HyperEVM');
  console.log('  USDC = native USDC on HyperEVM (bridged from Ethereum)');
  console.log('  USDT0 = USDT on HyperEVM');
  console.log('  Potential: arb between bridge prices and HL spot prices');

  // 6. Explore: New token launches on HyperEVM
  console.log('\n── New Token Launch Research ──\n');
  console.log('  HIP-1 tokens launch on HL spot');
  console.log('  Some also trade on HyperSwap V3');
  console.log('  Potential: arb between HL spot and HyperSwap V3');
  console.log('  Need: monitor new HIP-1 launches, check if also on HyperSwap');

  // 7. Unexplored areas
  console.log('\n── Unexplored Areas ──\n');
  console.log('  1. Felix Finance (perp DEX on HyperEVM)');
  console.log('  2. HyperEVM-native stablecoins (USDH, USDHL)');
  console.log('  3. HyperEVM NFT marketplaces');
  console.log('  4. HyperEVM yield aggregators');
  console.log('  5. Cross-bridge arbitrage (Ethereum ↔ HyperEVM)');
  console.log('  6. HyperEVM MEV opportunities');
  console.log('  7. HyperEVM liquid staking derivatives (beyond kHYPE)');
  console.log('  8. HyperEVM restaking protocols');
  console.log('  9. HyperEVM options protocols');
  console.log('  10. HyperEVM insurance protocols');

  console.log('\n=== Next Research Steps ===');
  console.log('  1. Find Felix Finance contract addresses');
  console.log('  2. Scan HyperEVM for new contract deployments');
  console.log('  3. Research HyperEVM-native stablecoins');
  console.log('  4. Explore yield aggregation opportunities');
  console.log('  5. Check for restaking on HyperEVM');
}

main().catch(console.error);
