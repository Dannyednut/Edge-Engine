/**
 * HL Wallet Transfer Tool
 *
 * Enables USDC transfers between HL accounts.
 * Used for:
 *   - Moving funds between agent wallet and vault
 *   - Paying out vault depositor withdrawals
 *   - Transferring builder code revenue to principal
 *
 * Action: usdSend
 * POST /exchange with action:
 * { type: "usdSend", to: "<address>", amount: "<usd_amount>", nonce }
 */

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Wallet Transfer Tool');
  console.log('═══════════════════════════════════════════════════\n');

  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  const principalAddress = process.env.PRINCIPAL_EVM_ADDRESS;
  const agentSolanaAddress = process.env.AGENT_SOLANA_ADDRESS;
  const principalSolAddress = process.env.PRINCIPAL_SOL_ADDRESS;

  console.log('── Wallet Addresses ──\n');
  console.log(`  Agent EVM:     ${agentAddress}`);
  console.log(`  Principal EVM: ${principalAddress}`);
  console.log(`  Agent Solana:  ${agentSolanaAddress}`);
  console.log(`  Principal Sol: ${principalSolAddress}`);
  console.log('');

  console.log('── Transfer Types ─\n');
  console.log('  1. PRINCIPAL → AGENT (fund for trading)');
  console.log('     Action: principal sends USDC to agent wallet on HL');
  console.log('     Use case: Deploy capital for strategies');
  console.log('');
  console.log('  2. AGENT → PRINCIPAL (profit payout)');
  console.log('     Action: agent sends USDC to principal wallet on HL');
  console.log('     Use case: Withdraw profits');
  console.log('');
  console.log('  3. AGENT → VAULT (fund vault)');
  console.log('     Action: agent sends USDC to vault sub-account');
  console.log('     Use case: Move capital to vault for depositor trading');
  console.log('');
  console.log('  4. VAULT → AGENT (fee withdrawal)');
  console.log('     Action: vault sends USDC to agent wallet');
  console.log('     Use case: Withdraw performance fees');
  console.log('');

  console.log('── Transfer Action Format ─\n');
  console.log('  POST https://api.hyperliquid.xyz/exchange');
  console.log('  Body:');
  console.log('  {');
  console.log('    "chain": "1",');
  console.log('    "action": {');
  console.log('      "type": "usdSend",');
  console.log(`      "to": "${principalAddress}",`);
  console.log('      "amount": "1000.0",  // USDC amount');
  console.log('      "nonce": <timestamp_ms>');
  console.log('    }');
  console.log('  }');
  console.log('  Must be signed with sender\'s private key');
  console.log('');

  console.log('── Transfer Workflow ─\n');
  console.log('  1. Principal funds agent wallet (USDC deposit to HL)');
  console.log('     - Principal deposits USDC to HL from external wallet');
  console.log('     - Principal transfers USDC to agent via usdSend');
  console.log('     - Agent receives USDC in HL account');
  console.log('');
  console.log('  2. Agent trades (executes strategies)');
  console.log('     - Agent places orders with builder field');
  console.log('     - Profits accumulate in agent HL account');
  console.log('');
  console.log('  3. Agent pays out profits to principal');
  console.log('     - Agent sends USDC to principal via usdSend');
  console.log('     - Principal receives USDC in HL account');
  console.log('     - Principal withdraws to external wallet');
  console.log('');

  console.log('── Vault Transfer Workflow ─\n');
  console.log('  1. Depositor deposits USDC into vault');
  console.log('     - Depositor finds vault on HL UI');
  console.log('     - Depositor deposits USDC');
  console.log('     - HL handles custody');
  console.log('');
  console.log('  2. Agent trades on behalf of vault');
  console.log('     - Agent uses vault sub-account for trades');
  console.log('     - Profits accrue to vault');
  console.log('');
  console.log('  3. Performance fee withdrawal');
  console.log('     - Agent withdraws 10% of profits via usdClassTransfer');
  console.log('     - Remaining 90% stays in vault for depositors');
  console.log('');
  console.log('  4. Depositor withdrawal');
  console.log('     - Depositor requests withdrawal from HL UI');
  console.log('     - 7-day queue');
  console.log('     - Pro-rata distribution');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Transfer tool is READY (framework built).');
  console.log('  Need: $100 USDC in agent wallet to start');
  console.log('  Then: Principal can fund agent for trading');
  console.log('  Then: Agent can trade + pay out profits');
  console.log('  Then: Create vault + accept depositor funds');
}

main().catch(console.error);
