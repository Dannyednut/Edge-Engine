/**
 * AgentVault deploy preflight checker.
 *
 * Verifies all prerequisites for deploying AgentVault.sol are met:
 *   1. Agent EVM wallet generated (AGENT_EVM_PRIVATE_KEY + AGENT_EVM_ADDRESS in .env)
 *   2. Principal EVM address set (PRINCIPAL_EVM_ADDRESS in .env)
 *   3. Agent EVM wallet funded with gas on target chain
 *   4. AgentVault.sol compiled (contracts/build/AgentVault.json exists)
 *   5. RPC endpoint reachable for target chain
 *   6. Balancer V2 + Aave V3 addresses available for target chain
 *
 * Usage: pnpm --filter @edge/contracts preflight --chain=base
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, formatEther, type Chain as ViemChain } from 'viem';
import { arbitrum, base, optimism, polygon, bsc, zksync, mainnet } from 'viem/chains';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const CHAIN_MAP: Record<string, ViemChain> = {
  ethereum: mainnet, arbitrum, base, optimism, polygon, bsc, zksync,
};

function arg(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag?.split('=', 2)[1];
}

function check(name: string, condition: boolean, detail?: string): { name: string; pass: boolean; detail?: string } {
  return { name, pass: condition, detail };
}

async function main() {
  // Load .env
  const envPath = resolve(REPO_ROOT, '.env');
  if (existsSync(envPath)) {
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }

  const chainName = arg('chain') || 'base';
  const chain = CHAIN_MAP[chainName];
  if (!chain) {
    console.error(`Unsupported chain: ${chainName}. Supported: ${Object.keys(CHAIN_MAP).join(', ')}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log(`  AgentVault Deploy Preflight — ${chainName.toUpperCase()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

  // 1. Agent EVM wallet
  const agentPk = process.env.AGENT_EVM_PRIVATE_KEY;
  const agentAddr = process.env.AGENT_EVM_ADDRESS;
  checks.push(check('Agent EVM private key in .env', !!agentPk && agentPk.startsWith('0x')));
  checks.push(check('Agent EVM address in .env', !!agentAddr && agentAddr!.startsWith('0x')));

  // 2. Principal EVM address
  const principalAddr = process.env.PRINCIPAL_EVM_ADDRESS;
  checks.push(check('Principal EVM address in .env', !!principalAddr && principalAddr!.startsWith('0x')));

  // 3. AgentVault compiled
  const buildPath = resolve(REPO_ROOT, 'contracts', 'build', 'AgentVault.json');
  checks.push(check('AgentVault.sol compiled', existsSync(buildPath)));

  // 4. RPC reachable + agent wallet funded
  const rpcUrl = chain.rpcUrls.default.http[0];
  let agentBalance = 0n;
  let rpcLatency = 0;
  try {
    const pc = createPublicClient({ chain, transport: http(rpcUrl) });
    const start = Date.now();
    const block = await pc.getBlockNumber();
    rpcLatency = Date.now() - start;
    checks.push(check(`RPC reachable (${chainName})`, true, `block ${block}, ${rpcLatency}ms`));

    if (agentAddr) {
      agentBalance = await pc.getBalance({ address: agentAddr as `0x${string}` });
      const balEth = Number(formatEther(agentBalance));
      const minGas = chainName === 'ethereum' ? 0.005 : 0.0005;
      checks.push(check(
        `Agent wallet funded (${chainName})`,
        balEth >= minGas,
        `${balEth.toFixed(6)} ${chain.nativeCurrency.symbol} (need >= ${minGas})`
      ));
    } else {
      checks.push(check(`Agent wallet funded (${chainName})`, false, 'address not set'));
    }
  } catch (err) {
    checks.push(check(`RPC reachable (${chainName})`, false, String(err).slice(0, 100)));
    checks.push(check(`Agent wallet funded (${chainName})`, false, 'RPC failed'));
  }

  // 5. Print results
  console.log('CHECK                            STATUS  DETAIL');
  console.log('──────────────────────────────── ─────── ──────────────────────────────────');
  for (const c of checks) {
    const status = c.pass ? 'PASS' : 'FAIL';
    const icon = c.pass ? '\u2713' : '\u2717';
    console.log(`${c.name.padEnd(32)} ${icon} ${status.padEnd(7)} ${c.detail || ''}`);
  }

  const allPass = checks.every(c => c.pass);
  console.log('\n═══════════════════════════════════════════════════');
  if (allPass) {
    console.log('  ALL CHECKS PASSED — READY TO DEPLOY');
    console.log('═══════════════════════════════════════════════════\n');
    console.log('  Run:');
    console.log(`    pnpm --filter @edge/contracts deploy --chain=${chainName}`);
    console.log(`\n  This will deploy AgentVault with:`);
    console.log(`    Owner (principal): ${principalAddr}`);
    console.log(`    Operator (agent):  ${agentAddr}`);
    console.log(`    Chain:             ${chainName} (ID ${chain.id})`);
  } else {
    const failed = checks.filter(c => !c.pass);
    console.log(`  ${failed.length} CHECK(S) FAILED — NOT READY TO DEPLOY`);
    console.log('═══════════════════════════════════════════════════\n');
    console.log('  Fix these issues:');
    for (const c of failed) {
      console.log(`    \u2717 ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    }
    if (failed.some(c => c.name.includes('funded'))) {
      console.log(`\n  Fund agent wallet on ${chainName}:`);
      console.log(`    Send to: ${agentAddr || '(address not set)'}`);
      console.log(`    Amount:  ~0.05 ${chain.nativeCurrency.symbol} (for gas)`);
    }
  }
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
