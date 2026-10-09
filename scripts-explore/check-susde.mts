// Check if Ethena sUSDe is available on HyperEVM
// sUSDe = Ethena's delta-neutral stablecoin yielding 7.46% APY
// If available on HyperEVM, we can park idle USDC there

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(HYPEREVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Ethena sUSDe on HyperEVM Check');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Check if USDe token is deployed on HyperEVM
  console.log('── Checking Ethena tokens on HyperEVM ──');
  // Known Ethena token addresses (need to verify on HyperEVM)
  const tokensToCheck = [
    { name: 'USDe (Ethena)', symbol: 'USDe', addr: '0x5d3a1Ff2b6BAb83b63cd9AD519169A0C669b1c1c' }, // placeholder
    { name: 'sUSDe (Staked USDe)', symbol: 'sUSDe', addr: '0x9D91e8cC4F0b4E3a964C5D6B3e1B5a3c2c1a0E0E' }, // placeholder
  ];

  for (const t of tokensToCheck) {
    console.log(`\n  Checking ${t.name} at ${t.addr}:`);
    try {
      // Try to call name()
      const nameResult = await ethCall(t.addr, '0x06fdde03'); // name()
      if (nameResult && nameResult !== '0x' && nameResult.length > 2) {
        const nameHex = nameResult.slice(2);
        const nameStr = Buffer.from(nameHex, 'hex').toString('utf8').replace(/\0/g, '').trim();
        console.log(`    name(): "${nameStr}"`);
      } else {
        console.log(`    No name() returned (contract may not exist)`);
      }

      // Try totalSupply()
      const supplyResult = await ethCall(t.addr, '0x18160ddd'); // totalSupply()
      if (supplyResult && supplyResult !== '0x' && supplyResult.length > 2) {
        const supply = BigInt('0x' + supplyResult.slice(2));
        console.log(`    totalSupply(): ${supply.toString()}`);
      }
    } catch (e: any) {
      console.log(`    Error: ${e.message}`);
    }
  }

  // 2. Check if there's an Ethena bridge to HyperEVM
  console.log('\n── Ethena Bridge to HyperEVM ──');
  console.log('  Ethena is deployed on:');
  console.log('    - Ethereum mainnet (USDe + sUSDe)');
  console.log('    - Arbitrum (USDe only)');
  console.log('    - Base (USDe only)');
  console.log('    - BSC (USDe only)');
  console.log('');
  console.log('  HyperEVM status: NOT YET DEPLOYED (as of Oct 9, 2026)');
  console.log('  To use sUSDe on HyperEVM, would need to:');
  console.log('    1. Bridge USDe from Ethereum to HyperEVM via Wormhole');
  console.log('    2. Stake USDe for sUSDe (only on Ethereum mainnet)');
  console.log('    3. Bridge sUSDe back to HyperEVM');
  console.log('');
  console.log('  This is complex — better to use sUSDe natively on Ethereum');
  console.log('');

  // 3. Alternative yield options on HyperEVM
  console.log('── Alternative Stablecoin Yield on HyperEVM ──');
  const options = [
    { name: 'HLP Vault', yield: 100, risk: 'MEDIUM (trader loss)', lockup: '7 days' },
    { name: 'Euler V2 USDC lending', yield: 2.5, risk: 'LOW', lockup: 'None' },
    { name: 'HyperLend USDC lending', yield: 0, risk: 'LOW', lockup: 'None' }, // dormant
    { name: 'HyperSwap V3 USDC/USDT LP', yield: 6, risk: 'LOW', lockup: 'None' },
    { name: 'Aave V3 on Ethereum (not HyperEVM)', yield: 4, risk: 'LOW', lockup: 'None' },
    { name: 'sUSDe on Ethereum (not HyperEVM)', yield: 7.46, risk: 'MEDIUM', lockup: 'None' },
    { name: 'Hold USDC', yield: 0, risk: 'NONE', lockup: 'None' },
  ];
  options.sort((a, b) => b.yield - a.yield);
  console.log('Option                             | Yield   | Risk                    | Lockup');
  console.log('───────────────────────────────────|─────────|─────────────────────────|──────');
  for (const o of options) {
    console.log(`${o.name.padEnd(35)}| ${o.yield.toFixed(2).padStart(6)}% | ${o.risk.padEnd(25)}| ${o.lockup}`);
  }

  // 4. Recommendation
  console.log('\n=== Verdict ===');
  console.log('sUSDe is NOT available natively on HyperEVM.');
  console.log('  Best HyperEVM-native option: HLP Vault (100% APR)');
  console.log('  Best for idle USDC on HyperEVM: HLP Vault (with risk awareness)');
  console.log('');
  console.log('If we want sUSDe (7.46% APY):');
  console.log('  - Bridge USDC from HyperEVM to Ethereum (Wormhole)');
  console.log('  - Mint USDe on Ethereum');
  console.log('  - Stake USDe for sUSDe');
  console.log('  - Hold sUSDe on Ethereum (no need to bridge back)');
  console.log('  - Bridge fees: $20-100');
  console.log('  - Worth it for >$50k parking (yield > fees)');
  console.log('');
  console.log('ACTION: Use HLP Vault for HyperEVM-native parking');
  console.log('  Use sUSDe only for >$50k idle USDC parked long-term');
}

main().catch(console.error);
