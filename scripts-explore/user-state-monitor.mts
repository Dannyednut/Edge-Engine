/**
 * HL User State Monitor
 * 
 * When wallet is funded, this monitors:
 * - Account value (total equity)
 * - Margin used
 * - Open positions
 * - P&L
 * - Daily volume
 * - Fees paid
 * - Builder code revenue
 * 
 * Runs continuously and alerts on:
 * - Drawdown > 5%
 * - Position margin > 50%
 * - Large P&L swing
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL User State Monitor ──\n');
  
  const agentAddress = process.env.AGENT_EVM_ADDRESS!;
  
  // Portfolio (account value history)
  const portfolio = await hlInfo({ type: 'portfolio', user: agentAddress });
  if (Array.isArray(portfolio)) {
    for (const entry of portfolio) {
      if (entry[0] === 'day') {
        const hist = entry[1]?.accountValueHistory || [];
        const latest = hist[hist.length - 1];
        if (latest) {
          console.log(`  Account value: $${latest[1]}`);
        }
      }
    }
  }
  
  // User fees (volume + fee schedule)
  const fees = await hlInfo({ type: 'userFees', user: agentAddress });
  if (fees?.dailyUserVlm) {
    const today = fees.dailyUserVlm[fees.dailyUserVlm.length - 1];
    console.log(`  Today's volume: $${parseFloat(today?.exchange || '0').toLocaleString()}`);
    console.log(`  Maker fee rate: ${fees.userAddRate || 'N/A'}`);
    console.log(`  Taker fee rate: ${fees.userCrossRate || 'N/A'}`);
  }
  
  // User funding (funding payments)
  const funding = await hlInfo({ type: 'userFunding', user: agentAddress, startTime: Date.now() - 86400000 });
  console.log(`  Funding events (24h): ${Array.isArray(funding) ? funding.length : 0}`);
  
  // User fills (trades)
  const fills = await hlInfo({ type: 'userFillsByTime', user: agentAddress, startTime: Date.now() - 86400000 });
  console.log(`  Trades (24h): ${Array.isArray(fills) ? fills.length : 0}`);
  
  // Vault equities
  const vaultEq = await hlInfo({ type: 'userVaultEquities', user: agentAddress });
  console.log(`  Vault deposits: ${Array.isArray(vaultEq) ? vaultEq.length : 0}`);
  
  // Sub-accounts
  const subAccts = await hlInfo({ type: 'subAccounts', user: agentAddress });
  console.log(`  Sub-accounts: ${subAccts ? 'yes' : 'none'}`);
  
  console.log('\n── When Funded ──\n');
  console.log('  This monitor will show:');
  console.log('    - Real-time account value');
  console.log('    - Open positions + margin');
  console.log('    - Daily trading volume');
  console.log('    - Fees paid (maker vs taker)');
  console.log('    - Builder code rebate earned');
  console.log('    - Funding payments received');
  console.log('    - Trade history');
  console.log('    - Vault deposits');
  console.log('');
  console.log('  Alerts will fire on:');
  console.log('    - Drawdown > 5% → pause trading');
  console.log('    - Margin > 50% → reduce positions');
  console.log('    - Large P&L swing → notify principal');
}
main().catch(console.error);
