// HL Vault Deployment Script
// Creates an HL vault for depositor funds
// This is the actual implementation of the vault creation action
//
// Action: createUserVault
// POST https://api.hyperliquid.xyz/exchange
// Body: { chain, action: { type, name, description, nonce } }
// Must be signed with agent EVM private key

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_EXCHANGE = 'https://api.hyperliquid.xyz/exchange';
const HL_INFO = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Construct and sign an HL exchange action
 * Uses ethers-like signing (simplified)
 */
async function signAndSubmitAction(action: any, privateKey: string): Promise<any> {
  // In production, this would use proper EIP-712 signing
  // For now, document the process

  const nonce = Date.now();
  const fullAction = { ...action, nonce };

  // Step 1: Hash the action
  // HL uses a specific hashing scheme
  // const actionHash = hashAction(fullAction);

  // Step 2: Sign with private key
  // const signature = sign(actionHash, privateKey);

  // Step 3: Submit to HL
  // const body = { chain: '1', action: fullAction, signature };
  // const res = await fetch(HL_EXCHANGE, { method: 'POST', body: JSON.stringify(body) });

  console.log('[vault-deploy] Action prepared:');
  console.log(JSON.stringify(fullAction, null, 2));
  console.log('\n[vault-deploy] ⚠️  Not submitted — needs proper EIP-712 signing');
  console.log('[vault-deploy] Implement with ethers.js or viem for production');

  return { status: 'prepared', action: fullAction };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Vault Deployment Script');
  console.log('═══════════════════════════════════════════════════\n');

  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY;

  if (!agentAddress || !agentPrivateKey) {
    console.log('❌ Agent wallet not configured');
    return;
  }

  console.log(`  Agent address: ${agentAddress}`);
  console.log(`  Private key: ${agentPrivateKey.substring(0, 10)}...`);
  console.log('');

  // 1. Check agent wallet balance
  console.log('── Checking Agent Wallet Balance ──');
  try {
    const portfolio = await hlInfo({ type: 'portfolio', user: agentAddress });
    if (Array.isArray(portfolio)) {
      const dayData = portfolio.find((p: any) => p[0] === 'day');
      const accountValue = dayData?.[1]?.accountValueHistory?.slice(-1)?.[0]?.[1] || '0';
      const value = parseFloat(accountValue);
      console.log(`  Account value: $${value.toFixed(2)}`);
      if (value < 100) {
        console.log('  ⚠️  Need $100+ USDC to create vault');
        console.log('  Fund agent wallet first');
        return;
      }
    }
  } catch (e: any) {
    console.log(`  Error checking balance: ${e.message}`);
  }

  // 2. Vault configuration
  console.log('\n── Vault Configuration ──\n');
  const vaultConfig = {
    name: 'Edge-Engine Alpha Vault',
    description: 'Delta-neutral arbitrage strategies on Hyperliquid. VOOI price spread, funding arb, kHYPE carry, HLP vault. Risk-managed with automated stop-losses.',
    vaultType: 'Escrow',
    // Fee structure (set after creation)
    managementFeePct: 0,    // 0% AUM fee
    profitSharePct: 10,     // 10% of profits
    // Risk parameters
    maxDrawdownPct: 10,     // Stop trading at 10% drawdown
    maxPositionSize: 25000, // $25k per strategy
    maxTotalExposure: 100000, // $100k total
  };
  console.log(`  Name: ${vaultConfig.name}`);
  console.log(`  Description: ${vaultConfig.description.substring(0, 80)}...`);
  console.log(`  Type: ${vaultConfig.vaultType}`);
  console.log(`  Management fee: ${vaultConfig.managementFeePct}%`);
  console.log(`  Profit share: ${vaultConfig.profitSharePct}%`);
  console.log(`  Max drawdown: ${vaultConfig.maxDrawdownPct}%`);
  console.log(`  Max position: $${vaultConfig.maxPositionSize.toLocaleString()}`);
  console.log('');

  // 3. Create vault action
  console.log('── Vault Creation Action ──\n');
  const createAction = {
    type: 'createUserVault',
    name: vaultConfig.name,
    description: vaultConfig.description,
    vaultType: vaultConfig.vaultType,
  };

  const result = await signAndSubmitAction(createAction, agentPrivateKey);

  // 4. Post-creation: Update fee structure
  console.log('\n── Fee Update Action (after vault creation) ──\n');
  const feeAction = {
    type: 'updateVaultEquityAndFee',
    // vaultAddress: '<from creation response>',
    managementFeePct: vaultConfig.managementFeePct,
    profitSharePct: vaultConfig.profitSharePct,
  };
  console.log('  Action prepared:');
  console.log(JSON.stringify(feeAction, null, 2));

  // 5. Vault marketing plan
  console.log('\n── Vault Marketing Plan ──\n');
  console.log('  Phase 1 (Pre-launch):');
  console.log('    - Deploy $25k own capital');
  console.log('    - Trade for 30 days');
  console.log('    - Publish daily P&L on Twitter/Telegram');
  console.log('    - Build audience (target: 500 followers)');
  console.log('');
  console.log('  Phase 2 (Launch):');
  console.log('    - Create vault on HL');
  console.log('    - Set 10% performance fee');
  console.log('    - Open to depositors (min $1,000)');
  console.log('    - Target: $100k AUM in month 1');
  console.log('');
  console.log('  Phase 3 (Scale):');
  console.log('    - Increase fee to 15% after 90 days');
  console.log('    - Marketing campaign');
  console.log('    - Target: $500k-1M AUM');
  console.log('');

  // 6. Revenue projection
  console.log('── Revenue Projection ──\n');
  const scenarios = [
    { aum: 100_000, fee: 0.10, apr: 8.48 },
    { aum: 500_000, fee: 0.10, apr: 8.48 },
    { aum: 1_000_000, fee: 0.15, apr: 8.48 },
    { aum: 5_000_000, fee: 0.20, apr: 8.48 },
  ];
  console.log('AUM         | Fee  | Annual Profit   | Creator Share  | APR on AUM');
  console.log('────────────|──────|─────────────────|────────────────|───────────');
  for (const s of scenarios) {
    const profit = s.aum * s.apr;
    const creator = profit * s.fee;
    console.log(`$${(s.aum/1000).toFixed(0).padStart(9)}k | ${(s.fee*100).toFixed(0).padStart(4)}% | $${(profit/1000).toFixed(0).padStart(13)}k | $${(creator/1000).toFixed(0).padStart(12)}k | ${(s.apr*100).toFixed(0)}%`);
  }

  console.log('\n=== Next Steps ===');
  console.log('  1. Fund agent wallet with $100+ USDC');
  console.log('  2. Implement proper EIP-712 signing (ethers.js)');
  console.log('  3. Submit createUserVault action');
  console.log('  4. Submit updateVaultEquityAndFee action');
  console.log('  5. Deploy $25k own capital');
  console.log('  6. Trade for 30 days');
  console.log('  7. Open vault to depositors');
}

main().catch(console.error);
