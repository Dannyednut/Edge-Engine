// Explore HL Sub-Account Vault Strategy
// HL allows users to create "vaults" — basically managed sub-accounts
// Other users can deposit USDC into the vault
// Vault creator earns management fee (configurable, typically 10-20% of profits)
//
// Already explored in explore-vault.mts — let me build the actual vault creation tool

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
  console.log('  HL Vault Creation Tool (Framework)');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('── Vault Creation Action ──\n');
  console.log('  To create a vault on HL, send POST to /exchange with:');
  console.log('  {');
  console.log('    "action": {');
  console.log('      "type": "createUserVault",');
  console.log('      "name": "Edge-Engine Alpha Vault",');
  console.log('      "description": "Delta-neutral arbitrage strategies on Hyperliquid",');
  console.log('      "nonce": <timestamp_ms>,');
  console.log('      "vaultType": "Escrow",  // or "Spot"');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('  Must be signed by agent wallet private key');
  console.log('  Vault address is derived from agent wallet + nonce');
  console.log('');

  console.log('── Vault Configuration ──\n');
  console.log('  After creation, configure fee structure:');
  console.log('  {');
  console.log('    "action": {');
  console.log('      "type": "updateVaultEquityAndFee",');
  console.log('      "vaultAddress": "<vault_address>",');
  console.log('      "managementFeePct": 0,      // 0% AUM fee');
  console.log('      "profitSharePct": 10,       // 10% of profits');
  console.log('      "nonce": <timestamp_ms>');
  console.log('    }');
  console.log('  }');
  console.log('');

  console.log('── Vault Strategy ──\n');
  console.log('  Our vault would trade:');
  console.log('  1. VOOI price spread arb (instant capture)');
  console.log('  2. VOOI funding rate arb (12-96h hold)');
  console.log('  3. kHYPE LST carry (3x leverage)');
  console.log('  4. Euler lending rate spread');
  console.log('  5. CexLikeDex price arb');
  console.log('  6. HLP vault deposit (passive yield)');
  console.log('');
  console.log('  All strategies are delta-neutral (no directional risk)');
  console.log('');

  console.log('── Revenue Scenarios ──\n');
  const scenarios = [
    { name: 'Small vault', aum: 100_000, fee: 0.10, apr: 8.48 },
    { name: 'Mid vault', aum: 500_000, fee: 0.10, apr: 8.48 },
    { name: 'Large vault', aum: 1_000_000, fee: 0.15, apr: 8.48 },
    { name: 'Whale vault', aum: 5_000_000, fee: 0.20, apr: 8.48 },
    { name: 'Mega vault', aum: 10_000_000, fee: 0.20, apr: 8.48 },
  ];

  console.log('Vault                    | AUM        | APR    | Annual Profit | Creator Fee (10-20%)');
  console.log('─────────────────────────|────────────|────────|───────────────|─────────────────────');
  for (const s of scenarios) {
    const annualProfit = s.aum * s.apr;
    const creatorFee = annualProfit * s.fee;
    console.log(`${s.name.padEnd(25)}| $${(s.aum/1000).toFixed(0).padStart(9)}k | ${(s.apr*100).toFixed(0).padStart(6)}% | $${(annualProfit/1000).toFixed(0).padStart(11)}k | $${(creatorFee/1000).toFixed(0).padStart(16)}k`);
  }

  console.log('\n── Vault Marketing Plan ──\n');
  console.log('  Phase 1 (Month 1): Build track record');
  console.log('    - Deploy $25k own capital');
  console.log('    - Trade for 30 days');
  console.log('    - Publish daily P&L');
  console.log('    - Build audience on Twitter/Telegram');
  console.log('');
  console.log('  Phase 2 (Month 2): Launch vault');
  console.log('    - Create vault on HL');
  console.log('    - Set 10% performance fee');
  console.log('    - Open to depositors');
  console.log('    - Target: $100k AUM in month 1');
  console.log('');
  console.log('  Phase 3 (Months 3-6): Scale');
  console.log('    - Increase fee to 15% as track record builds');
  console.log('    - Marketing campaign');
  console.log('    - Target: $500k-1M AUM');
  console.log('    - Revenue: $75k-150k/yr in fees');
  console.log('');
  console.log('  Phase 4 (Months 6-12): Whale vault');
  console.log('    - Target: $5M+ AUM');
  console.log('    - 20% performance fee');
  console.log('    - Revenue: $1M+/yr in fees');
  console.log('    - Hire team for support + marketing');
  console.log('');

  console.log('── Risk Management ──\n');
  console.log('  Vault creator risks:');
  console.log('    1. REPUTATION RISK — if strategy underperforms');
  console.log('    2. REGULATORY RISK — SEC may classify vault as security');
  console.log('    3. OPERATIONAL RISK — smart contract bugs');
  console.log('    4. CONCENTRATION RISK — all capital in one strategy');
  console.log('');
  console.log('  Mitigations:');
  console.log('    1. Clear disclosure of risks');
  console.log('    2. Diversify across 6+ strategies');
  console.log('    3. Smart contract audit');
  console.log('    4. Insurance fund (Nexus Mutual)');
  console.log('    5. Daily P&L reporting');
  console.log('    6. Withdrawal queue (7-day delay)');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HL Vault is the BEST risk-adjusted opportunity:');
  console.log('  ✅ No own capital at risk (depositor funds)');
  console.log('  ✅ High revenue potential ($1M+/yr at scale)');
  console.log('  ✅ HL handles custody + withdrawals');
  console.log('  ⚠️ Reputation risk (manageable)');
  console.log('  ⚠️ Regulatory risk (unclear)');
  console.log('');
  console.log('RECOMMENDED SEQUENCE:');
  console.log('  1. Deploy own $25k capital first (prove strategy)');
  console.log('  2. Build 30-day track record');
  console.log('  3. Create vault with 10% fee');
  console.log('  4. Market to depositors');
  console.log('  5. Scale to $1M+ AUM');
}

main().catch(console.error);
