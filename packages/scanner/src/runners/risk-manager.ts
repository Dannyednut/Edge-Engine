/**
 * Risk Manager — monitors open positions and enforces risk limits.
 *
 * Features:
 *   - Max position size per asset
 *   - Max total exposure across all positions
 *   - Max drawdown stop-loss
 *   - Daily profit target (stop when reached)
 *   - Daily loss limit (stop when reached)
 *   - Position timeout (close after N hours)
 *
 * Usage: pnpm --filter @edge/scanner start:risk-manager
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';


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

interface RiskLimits {
  maxPositionSizeUsd: number;      // max per position (default $5k)
  maxTotalExposureUsd: number;     // max across all positions (default $50k)
  maxDrawdownPct: number;          // stop trading if drawdown exceeds (default 10%)
  dailyProfitTargetUsd: number;    // stop when reached (default $500)
  dailyLossLimitUsd: number;       // stop when reached (default $200)
  positionTimeoutHours: number;    // close after N hours (default 24)
  maxConcurrentPositions: number;  // max open at once (default 10)
  minOiUsd: number;                // min OI for entry (default $100k)
  maxSpreadCapturePct: number;     // don't enter if spread > this (likely stale, default 20%)
}

interface Position {
  id: string;
  asset: string;
  venue: string;
  side: 'long' | 'short';
  sizeUsd: number;
  entryPrice: number;
  openedAt: number;
  strategy: 'price_spread' | 'funding_rate';
}

interface RiskState {
  positions: Position[];
  dailyPnlUsd: number;
  dailyTrades: number;
  dailyDate: string;  // YYYY-MM-DD
  totalPnlUsd: number;
  maxDrawdownPct: number;
  tradingEnabled: boolean;
  lastResetAt: number;
}

const DEFAULT_LIMITS: RiskLimits = {
  maxPositionSizeUsd: 5_000,
  maxTotalExposureUsd: 50_000,
  maxDrawdownPct: 10,
  dailyProfitTargetUsd: 500,
  dailyLossLimitUsd: 200,
  positionTimeoutHours: 24,
  maxConcurrentPositions: 10,
  minOiUsd: 100_000,
  maxSpreadCapturePct: 20,
};

const STATE_FILE = resolve(REPO_ROOT, 'data', 'risk-state.json');

function loadState(): RiskState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    positions: [],
    dailyPnlUsd: 0,
    dailyTrades: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalPnlUsd: 0,
    maxDrawdownPct: 0,
    tradingEnabled: true,
    lastResetAt: Date.now(),
  };
}

function saveState(state: RiskState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export class RiskManager {
  private state: RiskState;
  private limits: RiskLimits;

  constructor(limits: Partial<RiskLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.state = loadState();
    this.checkDailyReset();
  }

  private checkDailyReset(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.dailyDate !== today) {
      this.state.dailyDate = today;
      this.state.dailyPnlUsd = 0;
      this.state.dailyTrades = 0;
      this.state.tradingEnabled = true;
      this.state.lastResetAt = Date.now();
      saveState(this.state);
    }
  }

  canOpenPosition(_asset: string, sizeUsd: number): { allowed: boolean; reason?: string } {
    this.checkDailyReset();

    if (!this.state.tradingEnabled) {
      return { allowed: false, reason: 'Trading disabled (daily limit reached or drawdown)' };
    }

    if (sizeUsd > this.limits.maxPositionSizeUsd) {
      return { allowed: false, reason: `Position size $${sizeUsd} exceeds max $${this.limits.maxPositionSizeUsd}` };
    }

    const totalExposure = this.state.positions.reduce((s, p) => s + p.sizeUsd, 0);
    if (totalExposure + sizeUsd > this.limits.maxTotalExposureUsd) {
      return { allowed: false, reason: `Total exposure would exceed $${this.limits.maxTotalExposureUsd}` };
    }

    if (this.state.positions.length >= this.limits.maxConcurrentPositions) {
      return { allowed: false, reason: `Max concurrent positions (${this.limits.maxConcurrentPositions}) reached` };
    }

    if (this.state.dailyPnlUsd >= this.limits.dailyProfitTargetUsd) {
      this.state.tradingEnabled = false;
      saveState(this.state);
      return { allowed: false, reason: `Daily profit target $${this.limits.dailyProfitTargetUsd} reached` };
    }

    if (this.state.dailyPnlUsd <= -this.limits.dailyLossLimitUsd) {
      this.state.tradingEnabled = false;
      saveState(this.state);
      return { allowed: false, reason: `Daily loss limit $${this.limits.dailyLossLimitUsd} reached` };
    }

    return { allowed: true };
  }

  recordPosition(position: Omit<Position, 'openedAt'>): void {
    this.state.positions.push({ ...position, openedAt: Date.now() });
    this.state.dailyTrades++;
    saveState(this.state);
  }

  closePosition(positionId: string, _exitPrice: number, pnlUsd: number): void {
    const pos = this.state.positions.find(p => p.id === positionId);
    if (!pos) return;
    this.state.positions = this.state.positions.filter(p => p.id !== positionId);
    this.state.dailyPnlUsd += pnlUsd;
    this.state.totalPnlUsd += pnlUsd;
    if (pnlUsd < 0) {
      const drawdownPct = Math.abs(this.state.totalPnlUsd) / this.limits.maxTotalExposureUsd * 100;
      if (drawdownPct > this.state.maxDrawdownPct) {
        this.state.maxDrawdownPct = drawdownPct;
      }
      if (drawdownPct > this.limits.maxDrawdownPct) {
        this.state.tradingEnabled = false;
      }
    }
    saveState(this.state);
  }

  getExpiredPositions(): Position[] {
    const cutoff = Date.now() - this.limits.positionTimeoutHours * 3600_000;
    return this.state.positions.filter(p => p.openedAt < cutoff);
  }

  getStatus(): RiskState {
    this.checkDailyReset();
    return this.state;
  }

  getLimits(): RiskLimits {
    return this.limits;
  }
}

// CLI
async function main() {
  const rm = new RiskManager();
  const status = rm.getStatus();
  const limits = rm.getLimits();

  console.log('═══════════════════════════════════════════════════');
  console.log('  Risk Manager Status');
  console.log(`  ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  console.log('Risk Limits:');
  console.log(`  Max position size:     $${limits.maxPositionSizeUsd.toLocaleString()}`);
  console.log(`  Max total exposure:    $${limits.maxTotalExposureUsd.toLocaleString()}`);
  console.log(`  Max drawdown:          ${limits.maxDrawdownPct}%`);
  console.log(`  Daily profit target:   $${limits.dailyProfitTargetUsd}`);
  console.log(`  Daily loss limit:      $${limits.dailyLossLimitUsd}`);
  console.log(`  Position timeout:      ${limits.positionTimeoutHours}h`);
  console.log(`  Max concurrent:        ${limits.maxConcurrentPositions}`);
  console.log('');

  console.log('Current State:');
  console.log(`  Trading enabled:       ${status.tradingEnabled ? 'YES' : 'NO'}`);
  console.log(`  Open positions:        ${status.positions.length}`);
  console.log(`  Total exposure:        $${status.positions.reduce((s, p) => s + p.sizeUsd, 0).toLocaleString()}`);
  console.log(`  Daily P&L:             $${status.dailyPnlUsd.toFixed(2)}`);
  console.log(`  Daily trades:          ${status.dailyTrades}`);
  console.log(`  Total P&L:             $${status.totalPnlUsd.toFixed(2)}`);
  console.log(`  Max drawdown:          ${status.maxDrawdownPct.toFixed(2)}%`);
  console.log('');

  if (status.positions.length > 0) {
    console.log('Open Positions:');
    for (const p of status.positions) {
      const age = (Date.now() - p.openedAt) / 3600_000;
      console.log(`  ${p.asset.padEnd(12)} ${p.side.padEnd(6)} $${p.sizeUsd.toFixed(0)} @ ${p.entryPrice} (${age.toFixed(1)}h old)`);
    }
  }

  const expired = rm.getExpiredPositions();
  if (expired.length > 0) {
    console.log(`\n⚠ ${expired.length} positions exceeded timeout — should be closed`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
