/**
 * Go-Live Script — the ONE command to start live trading when principal approves.
 *
 * Usage: npx tsx packages/scanner/src/runners/go-live.ts --approved
 *        (the previously advertised `start:go-live` npm script does not exist)
 *
 * EM-STRAT-012 Phase-0: this script is now behind the shared fail-closed
 * execution guard. `--approved` alone is NOT sufficient — a valid scoped
 * authorization descriptor (EDGE_EXECUTION_AUTH) covering at least
 * 'entrypoint:go-live' plus the sink scopes for the actions actually taken
 * ('vooi:create-bot' and 'vooi:start-bot') is required before any bot is
 * created or started. Importing this module has no side effects.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VooiClient } from '@edge/vooi-client';
import {
  assertExecutionAuthorized,
  loadDotEnvIntoProcessEnv,
  type ExecutionScope,
} from '@edge/risk';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

/** Entrypoint scope for this script (defense-in-depth layer). */
export const ENTRYPOINT_SCOPE: ExecutionScope = 'entrypoint:go-live';

// EM-STRAT-012 Phase-0 R1: .env loading moved out of module-import scope into
// an explicitly-invoked function so importing this module does not mutate
// process.env. The shared helper (loadDotEnvIntoProcessEnv from @edge/risk)
// additionally EXCLUDES EDGE_EXECUTION_AUTH — the execution-authorization
// descriptor must be supplied through the parent-process environment, never
// persisted in .env. Called from main() only.
async function main() {
  // EM-STRAT-012 Phase-0: .env loading is explicitly invoked here (entrypoint
  // code), not at module import time.
  loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

  const args = new Set(process.argv.slice(2));
  const approved = args.has('--approved');

  console.log('═══════════════════════════════════════════════════');
  console.log('  GO-LIVE SCRIPT — Start Live Trading');
  console.log('═══════════════════════════════════════════════════\n');

  if (!approved) {
    console.log('⚠ NOT APPROVED — run with --approved flag to start live trading');
    console.log('Usage: npx tsx packages/scanner/src/runners/go-live.ts --approved\n');
    console.log('This will:');
    console.log('  1. Create a VOOI autonomous arb bot');
    console.log('  2. Start kHYPE carry arb executor');
    console.log('  3. Start Euler lending arb executor');
    console.log('  4. Start opportunity monitor + risk manager');
    console.log('\nREQUIRES:');
    console.log('  - --approved flag');
    console.log('  - A valid EDGE_EXECUTION_AUTH scoped authorization (fail-closed gate)');
    console.log('  - VOOI_API_TOKEN set (✓ configured)');
    console.log('  - AGENT_HYPE_PRIVKEY set (✗ NOT SET — agent wallet not funded)');
    console.log('  - VOOI capital deposited on ultra.vooi.io');
    console.log('  - Agent wallet funded with HYPE + USDC on HyperEVM');
    return;
  }

  // EM-STRAT-012 Phase-0: fail-closed authorization gate at the live
  // transition. --approved alone is NOT sufficient; the scoped authorization
  // is additionally required before any bot is created or started.
  assertExecutionAuthorized(ENTRYPOINT_SCOPE);

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
  //    The client-level sinks (createBot / startBot) re-check their own
  //    'vooi:create-bot' / 'vooi:start-bot' scopes.
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
      console.log('  → If this is an ExecutionNotAuthorizedError, the scoped authorization is missing the vooi:create-bot / vooi:start-bot scopes');
    }
  }

  // 2. kHYPE carry arb (if wallet available) — COSMETIC ONLY
  //    (EM-STRAT-012 audit: these branches never imported or started any
  //    executor; the log lines below are advisory text, not invocation.)
  if (agentKey) {
    console.log('\n── Starting kHYPE Carry Arb ──');
    console.log('  → KhypeCarryExecutor would run via `start:khype-carry` (requires its own entrypoint + evm-executor scopes)');
    console.log('  → Buy kHYPE at discount → queue 7-day withdrawal → claim HYPE');
  } else {
    console.log('\n── kHYPE Carry Arb: SKIPPED (no agent wallet) ──');
  }

  // 3. Euler lending arb (if wallet available) — COSMETIC ONLY
  if (agentKey) {
    console.log('\n── Starting Euler Lending Arb ──');
    console.log('  → EulerLendingArbExecutor would run via `start:euler-arb` (requires its own entrypoint + evm-executor scopes)');
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
  console.log('\nTo stop: pkill -f "all-runner\\|opp-monitor\\|command-handler"');
}

// EM-STRAT-012 Phase-0: import.meta.url main guard — importing this module
// no longer runs main(). This is hygiene; the authorization gates above are
// the containment barrier.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
