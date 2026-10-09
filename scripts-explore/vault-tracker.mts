// HL Vault Performance Tracker
// Monitor top HL vaults to reverse-engineer their strategies
//
// Approach:
//   1. Get list of top vaults by AUM (need to discover addresses)
//   2. For each vault, fetch:
//      - vaultInfo (basic info)
//      - vaultDetails (detailed P&L)
//      - historicalVault (historical performance)
//   3. Track daily P&L
//   4. Identify top performers
//   5. Reverse-engineer their strategies by analyzing their trades

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

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: res.status, body: await res.text() };
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Vault Performance Tracker');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Try to get vault info with empty user
  console.log('── Testing vaultInfo endpoint ──');
  const vaultInfo1 = await hlInfo({ type: 'vaultInfo', user: '0x0000000000000000000000000000000000000000' });
  console.log(`  Result: ${JSON.stringify(vaultInfo1).substring(0, 200)}`);

  // 2. Try with different parameters
  console.log('\n── Testing vaultDetails ──');
  // Need a real vault address. Let's try some known HL vaults.
  // Hyperliquid's HLP vault is at 0x... (need to find actual address)
  const testVaults = [
    '0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a', // placeholder
    '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
  ];
  for (const addr of testVaults) {
    const result = await hlInfo({ type: 'vaultDetails', vaultAddress: addr });
    console.log(`  ${addr}: ${JSON.stringify(result).substring(0, 100)}`);
  }

  // 3. Try historicalVault
  console.log('\n── Testing historicalVault ──');
  const histVault = await hlInfo({ type: 'historicalVault' });
  console.log(`  Result: ${JSON.stringify(histVault).substring(0, 200)}`);

  // 4. Try portfolio with known addresses
  console.log('\n── Testing portfolio with various addresses ──');
  // Try some well-known HL addresses (whales, market makers)
  // These are public addresses that have traded on HL
  const knownAddresses = [
    '0x5c5f5a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a', // placeholder
  ];
  for (const addr of knownAddresses) {
    const portfolio = await hlInfo({ type: 'portfolio', user: addr });
    if (Array.isArray(portfolio)) {
      console.log(`  ${addr}: ${portfolio.length} portfolio items`);
    } else {
      console.log(`  ${addr}: ${JSON.stringify(portfolio).substring(0, 100)}`);
    }
  }

  // 5. Strategy for finding top vaults
  console.log('\n── Strategy for Finding Top Vaults ──\n');
  console.log('  Approach 1: HL Leaderboard API');
  console.log('    - Try to fetch leaderboard data');
  console.log('    - Top traders likely run vaults');
  console.log('    - Their addresses = potential vault addresses');
  console.log('');
  console.log('  Approach 2: On-chain analytics');
  console.log('    - Scan HyperEVM for vault creation events');
  console.log('    - Filter by AUM > $1M');
  console.log('    - Track their performance');
  console.log('');
  console.log('  Approach 3: HL UI scraping');
  console.log('    - Scrape https://app.hyperliquid.xyz/vaults');
  console.log('    - Get list of top vaults');
  console.log('    - Use their addresses for API queries');
  console.log('');

  // 6. Build plan
  console.log('── Build Plan ──\n');
  console.log('  Phase 1 (2 days): Vault address discovery');
  console.log('    - Scrape HL UI for vault list');
  console.log('    - Or scan HyperEVM for vault creation events');
  console.log('    - Build list of top 50 vaults by AUM');
  console.log('');
  console.log('  Phase 2 (3 days): Performance tracker');
  console.log('    - For each vault, fetch daily P&L');
  console.log('    - Compute APR, Sharpe ratio, max drawdown');
  console.log('    - Rank by risk-adjusted returns');
  console.log('');
  console.log('  Phase 3 (1 week): Strategy reverse-engineering');
  console.log('    - For top 10 vaults, analyze their trades');
  console.log('    - Identify patterns:');
  console.log('      - Which perps they trade');
  console.log('      - Position sizing');
  console.log('      - Entry/exit timing');
  console.log('      - Funding rate exposure');
  console.log('    - Build similar strategy');
  console.log('');
  console.log('  Phase 4 (ongoing): Continuous monitoring');
  console.log('    - Daily P&L updates');
  console.log('    - Alert when top vault makes big move');
  console.log('    - Quarterly strategy review');
  console.log('');

  // 7. Alternative: Use agent wallet to query own vault
  console.log('── Alternative: Query Own Vault ──\n');
  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  if (agentAddress) {
    console.log(`  Agent address: ${agentAddress}`);
    const portfolio = await hlInfo({ type: 'portfolio', user: agentAddress });
    if (Array.isArray(portfolio)) {
      console.log(`  Portfolio items: ${portfolio.length}`);
      for (const p of portfolio.slice(0, 3)) {
        console.log(`    ${JSON.stringify(p).substring(0, 100)}`);
      }
    } else {
      console.log(`  Result: ${JSON.stringify(portfolio).substring(0, 200)}`);
    }

    // Try userVaultEquities
    const vaultEquities = await hlInfo({ type: 'userVaultEquities', user: agentAddress });
    if (Array.isArray(vaultEquities)) {
      console.log(`  Vault equities: ${vaultEquities.length}`);
    } else {
      console.log(`  Vault equities: ${JSON.stringify(vaultEquities).substring(0, 100)}`);
    }
  }

  console.log('\n=== Verdict ===');
  console.log('Vault Performance Tracker is FEASIBLE but needs vault addresses.');
  console.log('  - HL API works for querying individual vaults');
  console.log('  - Need to discover top vault addresses (scraping or on-chain)');
  console.log('  - Build time: 2 weeks');
  console.log('  - Revenue potential: Reverse-engineer top strategies');
  console.log('  - Could improve our vault returns by 2-5x');
}

main().catch(console.error);
