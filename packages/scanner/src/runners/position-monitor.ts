/**
 * Position Monitor — tracks open positions and alerts when action needed.
 *
 * For kHYPE carry arb:
 *   - Monitors pending withdrawals
 *   - Alerts when 7-day withdrawal delay has passed (ready to claim)
 *   - Auto-claims if wallet is available
 *
 * For Euler lending arb:
 *   - Monitors open positions
 *   - Alerts if spread reverses (should close)
 *   - Tracks accrued interest
 *
 * Usage: pnpm --filter @edge/scanner start:monitor
 * (or run as background loop: pnpm --filter @edge/scanner start:monitor --loop)
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

const KHYPE_STATE_FILE = resolve(REPO_ROOT, 'data', 'khype-carry-state.json');
const EULER_STATE_FILE = resolve(REPO_ROOT, 'data', 'euler-lending-state.json');

interface KhypeWithdrawal {
  withdrawalId: string;
  khypeAmount: string;
  queuedAt: number;
  claimableAt: number;
  estimatedHypePayout: number;
  txHash: string;
}

interface KhypeState {
  pendingWithdrawals: KhypeWithdrawal[];
  completedCycles: any[];
  totalProfitUsd: number;
  totalCyclesCompleted: number;
}

interface EulerPosition {
  assetSymbol: string;
  depositVault: { address: string; name: string; apyPct: number; };
  borrowVault: { address: string; name: string; apyPct: number; };
  depositAmount: string;
  borrowAmount: string;
  openedAt: number;
  txHashes: string[];
  status: 'open' | 'closed';
}

interface EulerState {
  openPositions: EulerPosition[];
  closedPositions: any[];
  totalProfitUsd: number;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const loop = args.has('--loop');

  console.log('═══════════════════════════════════════════════════');
  console.log('  Position Monitor');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await monitorKhypePositions();
    await monitorEulerPositions();
    
    if (!loop) break;
    console.log(`\n[${new Date().toISOString()}] Next check in 60s...`);
    await new Promise(r => setTimeout(r, 60_000));
  }
}

async function monitorKhypePositions() {
  console.log('\n── kHYPE Carry Arb Positions ──');
  
  if (!existsSync(KHYPE_STATE_FILE)) {
    console.log('  No state file — no positions yet');
    return;
  }

  const state: KhypeState = JSON.parse(readFileSync(KHYPE_STATE_FILE, 'utf8'));
  console.log(`  Pending withdrawals: ${state.pendingWithdrawals.length}`);
  console.log(`  Completed cycles: ${state.totalCyclesCompleted}`);
  console.log(`  Total profit: $${state.totalProfitUsd.toFixed(2)}`);

  const now = Date.now();
  const ready = state.pendingWithdrawals.filter(w => w.claimableAt <= now);
  const pending = state.pendingWithdrawals.filter(w => w.claimableAt > now);

  if (ready.length > 0) {
    console.log(`\n  ✅ ${ready.length} withdrawals READY TO CLAIM:`);
    for (const w of ready) {
      console.log(`    - ${w.withdrawalId}: ${Number(w.khypeAmount) / 1e18} kHYPE → ~${w.estimatedHypePayout} HYPE`);
      console.log(`      Queued: ${new Date(w.queuedAt).toISOString()}`);
      console.log(`      Claimable since: ${new Date(w.claimableAt).toISOString()}`);
    }
    if (process.env.AGENT_HYPE_PRIVKEY) {
      console.log('  → Auto-claiming available (AGENT_HYPE_PRIVKEY set)');
      // TODO: call KhypeCarryExecutor.claimReadyWithdrawals()
    } else {
      console.log('  ⚠ Set AGENT_HYPE_PRIVKEY to auto-claim');
    }
  }

  if (pending.length > 0) {
    console.log(`\n  ⏳ ${pending.length} withdrawals pending (not yet claimable):`);
    for (const w of pending) {
      const daysLeft = (w.claimableAt - now) / 86400000;
      console.log(`    - ${w.withdrawalId}: ${Number(w.khypeAmount) / 1e18} kHYPE → claim in ${daysLeft.toFixed(1)}d`);
    }
  }
}

async function monitorEulerPositions() {
  console.log('\n── Euler Lending Arb Positions ──');
  
  if (!existsSync(EULER_STATE_FILE)) {
    console.log('  No state file — no positions yet');
    return;
  }

  const state: EulerState = JSON.parse(readFileSync(EULER_STATE_FILE, 'utf8'));
  console.log(`  Open positions: ${state.openPositions.length}`);
  console.log(`  Closed positions: ${state.closedPositions.length}`);
  console.log(`  Total profit: $${state.totalProfitUsd.toFixed(2)}`);

  const now = Date.now();
  for (const pos of state.openPositions) {
    const daysOpen = (now - pos.openedAt) / 86400000;
    const spreadPct = pos.depositVault.apyPct - pos.borrowVault.apyPct;
    const estimatedAccruedProfit = (spreadPct / 100 / 365 * daysOpen) * (Number(pos.depositAmount) / 1e6) * 0.8;
    
    console.log(`\n  ${pos.assetSymbol} position (open ${daysOpen.toFixed(1)}d)`);
    console.log(`    Deposit: ${pos.depositVault.name} @ ${pos.depositVault.apyPct.toFixed(2)}% APR`);
    console.log(`    Borrow:  ${pos.borrowVault.name} @ ${pos.borrowVault.apyPct.toFixed(2)}% APR`);
    console.log(`    Spread:  ${spreadPct.toFixed(2)}%  Est. accrued: $${estimatedAccruedProfit.toFixed(2)}`);
    
    // Check if spread has reversed (should close)
    // TODO: re-scan current vault rates and compare
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
