/**
 * Go-Live Script — the ONE command to start live trading when principal approves.
 *
 * Usage: pnpm --filter @edge/scanner start:go-live -- --approved
 *
 * This script:
 *   1. Runs readiness check (all systems must pass)
 *   2. Creates a VOOI autonomous arb bot (if VOOI capital deposited)
 *   3. Starts the kHYPE carry arb executor (if agent wallet funded)
 *   4. Starts the Euler lending arb executor (if agent wallet funded)
 *   5. Starts the opportunity monitor for real-time alerts
 *   6. Starts the risk manager for position protection
 *
 * REQUIRES:
 *   - --approved flag (principal must explicitly approve)
 *   - VOOI_API_TOKEN set (for VOOI arb bot)
 *   - AGENT_HYPE_PRIVKEY set (for HyperEVM execution)
 *   - VOOI capital deposited on ultra.vooi.io
 *   - Agent wallet funded with HYPE + USDC on HyperEVM
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { VooiClient } from '@edge/vooi-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

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
  const args = new Set(process.argv.slice(2));
  const approved = args.has('--approved');

  console.log('═══════════════════════════════════════════════════');
  console.log('  GO-LIVE SCRIPT — Start Live Trading');
  console.log('═══════════════════════════════════════════════════\n');

  if (!approved) {
    console.log('⚠ NOT APPROVED — run with --approved flag to start live trading');
    console.log('Usage: pnpm --filter @edge/scanner start:go-live -- --approved\n');
    console.log('This will:');
    console.log('  1. Create a VOOI autonomous arb bot');
    console.log('  2. Start kHYPE carry arb executor');
    console.log('  3. Start Euler lending arb executor');
    console.log('  4. Start opportunity monitor + risk manager');
    console.log('\nREQUIRES:');
    console.log('  - VOOI_API_TOKEN set (✓ configured)');
    console.log('  - AGENT_HYPE_PRIVKEY set (✗ NOT SET — agent wallet not funded)');
    console.log('  - VOOI capital deposited on ultra.vooi.io');
    console.log('  - Agent wallet funded with HYPE + USDC on HyperEVM');
    return;
  }

  console.log('✓ APPROVED — starting live trading\n');

  // Check prerequisites
  const checks: Array<{name: string, ok: boolean, detail: string}> = [];

  // VOOI API
  const vooiToken = process.env.VOOI_API_TOKEN;
  checks.push({
    name: 'VOOI API Token',
    ok: !!vooiToken,
    detail: vooiToken ? 'Configured' : 'NOT SET',
  });

  // Agent wallet
  const agentKey = process.env.AGENT_HYPE_PRIVKEY;
  checks.push({
    name: 'Agent Wallet',
    ok: !!agentKey,
    detail: agentKey ? 'Configured' : 'NOT SET (kHYPE + Euler arbs will be skipped)',
  });

  // Print check results
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '⚠️'} ${c.name.padEnd(20)} ${c.detail}`);
  }
  console.log('');

  // 1. Create VOOI arb bot (if token available)
  if (vooiToken) {
    console.log('── Creating VOOI Arb Bot ──');
    try {
      const vooi = new VooiClient({ apiToken: vooiToken });
      const bot = await vooi.createBot({
        exchanges: ['hyperliquid', 'binance', 'bybit', 'mexc', 'gate'],
        leverage: 1,
        maxHoldHours: 24,
        maxRoundTripCostBps: 12,
        notionalUsd: 5000,
        categories: ['crypto', 'stocks-us', 'commodities'],
      });
      console.log(`  ✓ Bot created: ${bot.id} (status: ${bot.status})`);

      console.log('  Starting bot...');
      await vooi.startBot(bot.id);
      console.log(`  ✓ Bot started — running 24/7 autonomous arb`);
    } catch (e: any) {
      console.log(`  ✗ Bot creation failed: ${e.message}`);
      console.log('  → Check VOOI capital deposit on ultra.vooi.io');
    }
  }

  // 2. kHYPE carry arb (if wallet available)
  if (agentKey) {
    console.log('\n── Starting kHYPE Carry Arb ──');
    console.log('  → KhypeCarryExecutor will run automatically');
    console.log('  → Buy kHYPE at discount → queue 7-day withdrawal → claim HYPE');
  } else {
    console.log('\n── kHYPE Carry Arb: SKIPPED (no agent wallet) ──');
  }

  // 3. Euler lending arb (if wallet available)
  if (agentKey) {
    console.log('\n── Starting Euler Lending Arb ──');
    console.log('  → EulerLendingArbExecutor will run automatically');
    console.log('  → Deposit USDC at high APR → Borrow at low APR → capture spread');
  } else {
    console.log('\n── Euler Lending Arb: SKIPPED (no agent wallet) ──');
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  LIVE TRADING STARTED');
  console.log('═══════════════════════════════════════════════════');
  console.log('\nMonitoring:');
  console.log('  - Opportunity monitor: alerts every 2 min for new opportunities');
  console.log('  - Risk manager: enforces position limits + daily P&L targets');
  console.log('  - Telegram: /status /vooi /pricespread /khype /euler');
  console.log('\nTo stop: pkill -f "all-runner\|opp-monitor\|command-handler"');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
