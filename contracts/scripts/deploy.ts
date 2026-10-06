/**
 * Deploy AgentVault.sol to a chain.
 *
 * Usage:
 *   pnpm --filter @edge/contracts deploy --chain base
 *   pnpm --filter @edge/contracts deploy --chain arbitrum
 *
 * Prerequisites:
 *   - Agent EVM wallet funded with native gas (ETH/BNB/MATIC)
 *   - .env contains AGENT_EVM_PRIVATE_KEY and PRINCIPAL_EVM_ADDRESS
 *   - pnpm --filter @edge/contracts compile  (run first)
 *
 * Output:
 *   - Prints the deployed contract address
 *   - Saves address to .env as AGENT_VAULT_ADDRESS_<CHAIN>
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, parseEther, type Chain as ViemChain } from 'viem';
import { arbitrum, base, optimism, polygon, bsc, zksync, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const CHAIN_MAP: Record<string, ViemChain> = {
  ethereum: mainnet, arbitrum, base, optimism, polygon, bsc, zksync,
};

// Balancer V2 Vault address (same on all chains where deployed)
const BALANCER_VAULT_BY_CHAIN: Record<string, `0x${string}` | null> = {
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base:     '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  optimism: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  bsc:      null,
  zksync:   null,
};

// Aave V3 Pool address (same on all chains where deployed — Aave V3 uses CREATE2 for same address cross-chain)
const AAVE_V3_POOL_BY_CHAIN: Record<string, `0x${string}` | null> = {
  ethereum:  '0x87870Bca3F3f6D5b4017c7e233794f7d7e233794f7',  // Aave V3 Ethereum mainnet Pool
  arbitrum:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Aave V3 Arbitrum Pool
  base:      '0xA238Dd80C259a72e81D7e4664a980159A193764E',  // Aave V3 Base Pool
  optimism:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Aave V3 Optimism Pool
  polygon:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Aave V3 Polygon Pool
  bsc:       null,
  zksync:    null,
};

// Load .env
function loadEnv() {
  const envPath = resolve(REPO_ROOT, '.env');
  if (!existsSync(envPath)) {
    console.error('Error: .env not found. Run `cp .env.example .env` first.');
    process.exit(1);
  }
  const env = readFileSync(envPath, 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

function arg(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag?.split('=', 2)[1];
}

async function main() {
  loadEnv();

  const chainName = arg('chain');
  if (!chainName) {
    console.error('Error: --chain=<chain> required');
    console.error('  Supported: ethereum, arbitrum, base, optimism, polygon, bsc, zksync');
    process.exit(1);
  }

  const chain = CHAIN_MAP[chainName];
  if (!chain) {
    console.error(`Error: unsupported chain "${chainName}"`);
    process.exit(1);
  }

  const agentPk = process.env.AGENT_EVM_PRIVATE_KEY as `0x${string}`;
  if (!agentPk) {
    console.error('Error: AGENT_EVM_PRIVATE_KEY not set in .env');
    console.error('  Run: pnpm --filter @edge/data-sources gen:agent-wallets');
    process.exit(1);
  }

  const principalAddress = process.env.PRINCIPAL_EVM_ADDRESS as `0x${string}` | undefined;
  if (!principalAddress) {
    console.error('Error: PRINCIPAL_EVM_ADDRESS not set in .env');
    console.error('  Add the principal (owner) EVM wallet address to .env:');
    console.error('  PRINCIPAL_EVM_ADDRESS=0x...');
    process.exit(1);
  }

  const balancerVault = BALANCER_VAULT_BY_CHAIN[chainName];
  const aaveV3Pool = AAVE_V3_POOL_BY_CHAIN[chainName];

  if (!balancerVault && !aaveV3Pool) {
    console.error(`Error: no flashloan provider available on ${chainName}`);
    process.exit(1);
  }

  // Load compiled bytecode + ABI
  const buildPath = resolve(REPO_ROOT, 'contracts', 'build', 'AgentVault.json');
  if (!existsSync(buildPath)) {
    console.error('Error: AgentVault.json not found. Run `pnpm --filter @edge/contracts compile` first.');
    process.exit(1);
  }
  const { abi, bytecode } = JSON.parse(readFileSync(buildPath, 'utf8'));

  // Setup wallet client
  const account = privateKeyToAccount(agentPk);
  const rpcUrl = process.env[`${chainName.toUpperCase()}_RPC`] || chain.rpcUrls.default.http[0];
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  Deploying AgentVault to ${chainName.toUpperCase()}`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  Chain ID:        ${chain.id}`);
  console.log(`  Owner:           ${principalAddress}  (principal)`);
  console.log(`  Operator:        ${account.address}  (agent)`);
  console.log(`  Profit recipient: ${principalAddress}  (default = owner)`);
  console.log(`  Balancer Vault:  ${balancerVault ?? '(not available on this chain)'}`);
  console.log(`  Aave V3 Pool:    ${aaveV3Pool ?? '(not available on this chain)'}`);
  console.log(`  RPC:             ${rpcUrl}`);
  console.log(`───────────────────────────────────────────────────────`);

  // Check agent balance
  const publicClient = await import('viem').then(m => m.createPublicClient({ chain, transport: http(rpcUrl) }));
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`  Agent balance:   ${balance.toString()} wei`);

  if (balance === 0n) {
    console.error('\nError: agent wallet has 0 native gas. Fund it first:');
    console.error(`  Send ~0.05 ${chain.nativeCurrency.symbol} to ${account.address}`);
    process.exit(1);
  }

  // Deploy
  console.log('\nDeploying...');
  const hash = await walletClient.deployContract({
    abi,
    bytecode: bytecode as `0x${string}`,
    args: [
      principalAddress,             // owner
      account.address,              // operator (agent)
      principalAddress,             // profitRecipient (default = owner)
      balancerVault ?? '0x0000000000000000000000000000000000000001',  // Balancer Vault (or sentinel if not on chain)
      aaveV3Pool ?? '0x0000000000000000000000000000000000000001',     // Aave V3 Pool (or sentinel)
      chain.id,                     // chainId
    ],
    account,
    chain,
    gas: 5_000_000n,   // AgentVault deploy ~3M gas; pad to 5M for safety
  });

  console.log(`  Tx hash: ${hash}`);
  console.log('  Waiting for confirmation...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error('\nError: deploy transaction reverted');
    process.exit(1);
  }

  const vaultAddress = receipt.contractAddress;
  if (!vaultAddress) {
    console.error('\nError: contract address not found in receipt');
    process.exit(1);
  }

  console.log(`\nDeployed at: ${vaultAddress}`);
  console.log(`  Block:   ${receipt.blockNumber}`);
  console.log(`  Gas used: ${receipt.gasUsed.toString()}`);

  // Save to .env
  const envVar = `AGENT_VAULT_ADDRESS_${chainName.toUpperCase()}`;
  const envPath = resolve(REPO_ROOT, '.env');
  const env = readFileSync(envPath, 'utf8');
  const newEntry = `${envVar}=${vaultAddress}`;
  if (env.includes(`${envVar}=`)) {
    const updated = env.replace(new RegExp(`^${envVar}=.*$`, 'm'), newEntry);
    appendFileSync(envPath, ''); // touch to ensure file exists
    const { writeFileSync } = await import('node:fs');
    writeFileSync(envPath, updated);
  } else {
    appendFileSync(envPath, `\n# Deployed AgentVault on ${chainName}\n${newEntry}\n`);
  }
  console.log(`\n  Saved to .env as ${envVar}`);

  console.log(`\n───────────────────────────────────────────────────────`);
  console.log(`  NEXT STEPS`);
  console.log(`───────────────────────────────────────────────────────`);
  console.log(`  1. Principal verifies the contract on chain explorer:`);
  console.log(`     ${chain.blockExplorers?.default.url}/address/${vaultAddress}`);
  console.log(`  2. Principal whitelists targets (or grants operator to do so):`);
  console.log(`     Call setWhitelistedTargets([...dexRouterAddresses], true)`);
  console.log(`  3. Principal funds the vault with trading capital:`);
  console.log(`     Transfer USDC/ETH/etc to ${vaultAddress}`);
  console.log(`  4. Principal protects the principal:`);
  console.log(`     Call protectToken(USDC_ADDRESS, depositedAmount)`);
  console.log(`  5. Agent can now call execute() and balancerFlashLoan()`);
}

main().catch(err => { console.error(err); process.exit(1); });
