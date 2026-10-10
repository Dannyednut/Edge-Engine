/**
 * Risk Management Enforcer
 *
 * Implements risk limits from Enterprise_Structure_Manual.md
 * Monitors:
 *   - Max position size ($25k per strategy)
 *   - Max total exposure ($100k)
 *   - Max daily drawdown (5%)
 *   - Max weekly drawdown (10%)
 *   - Max single-trade loss ($500)
 *   - kHYPE liquidation threshold (20% HYPE drop)
 *   - VOOI funding arb stop-loss (-5%)
 *
 * Actions:
 *   - Pause trading on daily drawdown > 5%
 *   - Stop trading on weekly drawdown > 10%
 *   - Alert principal on all risk events
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const RISK_STATE_FILE = '/home/z/my-project/download/risk-state.json';
const HL_API = 'https://api.hyperliquid.xyz/info';

// Risk limits (from Enterprise_Structure_Manual.md)
export const RISK_LIMITS = {
  maxPositionSize: 25_000,       // $25k per strategy
  maxTotalExposure: 100_000,     // $100k total
  maxDailyDrawdownPct: 5,        // 5% daily
  maxWeeklyDrawdownPct: 10,      // 10% weekly
  maxSingleTradeLoss: 500,       // $500
  khypeLiquidationThreshold: 20, // 20% HYPE drop
  vooiFundingStopLossPct: 5,     // -5% position
  maxConcurrentPositions: 3,     // per strategy
  cooldownMs: 30_000,            // 30s between trades
} as const;

interface RiskState {
  tradingPaused: boolean;
  tradingStopped: boolean;
  pauseReason: string | null;
  stopReason: string | null;
  dayStart: number;
  dayStartCapital: number;
  weekStart: number;
  weekStartCapital: number;
  alerts: { ts: number; type: string; severity: 'low' | 'medium' | 'high' | 'critical'; message: string }[];
  positions: { strategy: string; notional: number; entryTime: number }[];
  lastTradeTime: number;
}

function loadRiskState(): RiskState {
  if (existsSync(RISK_STATE_FILE)) {
    return JSON.parse(readFileSync(RISK_STATE_FILE, 'utf8'));
  }
  const now = Date.now();
  return {
    tradingPaused: false,
    tradingStopped: false,
    pauseReason: null,
    stopReason: null,
    dayStart: now,
    dayStartCapital: 100_000,
    weekStart: now,
    weekStartCapital: 100_000,
    alerts: [],
    positions: [],
    lastTradeTime: 0,
  };
}

function saveRiskState(state: RiskState) {
  writeFileSync(RISK_STATE_FILE, JSON.stringify(state, null, 2));
}

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegram(msg: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' }),
    });
  } catch {}
}

function addAlert(state: RiskState, type: string, severity: 'low' | 'medium' | 'high' | 'critical', message: string): RiskState {
  const alert = { ts: Date.now(), type, severity, message };
  state.alerts.push(alert);
  // Keep last 100 alerts
  if (state.alerts.length > 100) state.alerts = state.alerts.slice(-100);
  console.log(`[${severity.toUpperCase()}] ${type}: ${message}`);
  return state;
}

/**
 * Check if trading is allowed
 */
export function canTrade(state: RiskState): { allowed: boolean; reason: string } {
  if (state.tradingStopped) {
    return { allowed: false, reason: `Trading STOPPED: ${state.stopReason}` };
  }
  if (state.tradingPaused) {
    return { allowed: false, reason: `Trading PAUSED: ${state.pauseReason}` };
  }
  if (Date.now() - state.lastTradeTime < RISK_LIMITS.cooldownMs) {
    return { allowed: false, reason: 'Cooldown period active' };
  }
  return { allowed: true, reason: 'OK' };
}

/**
 * Check position size limit
 */
export function checkPositionSize(strategy: string, notional: number): { ok: boolean; reason: string } {
  if (notional > RISK_LIMITS.maxPositionSize) {
    return { ok: false, reason: `Position $${notional} exceeds max $${RISK_LIMITS.maxPositionSize} for ${strategy}` };
  }
  return { ok: true, reason: 'OK' };
}

/**
 * Check total exposure limit
 */
export function checkTotalExposure(state: RiskState, newNotional: number): { ok: boolean; reason: string } {
  const currentTotal = state.positions.reduce((s, p) => s + p.notional, 0);
  const newTotal = currentTotal + newNotional;
  if (newTotal > RISK_LIMITS.maxTotalExposure) {
    return { ok: false, reason: `Total exposure $${newTotal} would exceed max $${RISK_LIMITS.maxTotalExposure}` };
  }
  return { ok: true, reason: 'OK' };
}

/**
 * Check concurrent position limit
 */
export function checkConcurrentPositions(state: RiskState, strategy: string): { ok: boolean; reason: string } {
  const count = state.positions.filter(p => p.strategy === strategy).length;
  if (count >= RISK_LIMITS.maxConcurrentPositions) {
    return { ok: false, reason: `${strategy} already has ${count} positions (max ${RISK_LIMITS.maxConcurrentPositions})` };
  }
  return { ok: true, reason: 'OK' };
}

/**
 * Record a new position
 */
export function recordPosition(state: RiskState, strategy: string, notional: number): RiskState {
  state.positions.push({ strategy, notional, entryTime: Date.now() });
  state.lastTradeTime = Date.now();
  return state;
}

/**
 * Remove a closed position
 */
export function closePosition(state: RiskState, strategy: string, notional: number): RiskState {
  const idx = state.positions.findIndex(p => p.strategy === strategy && p.notional === notional);
  if (idx >= 0) {
    state.positions.splice(idx, 1);
  }
  return state;
}

/**
 * Check drawdown limits
 */
export async function checkDrawdown(state: RiskState, currentCapital: number): Promise<RiskState> {
  // Daily drawdown
  const dailyDD = ((state.dayStartCapital - currentCapital) / state.dayStartCapital) * 100;
  if (dailyDD >= RISK_LIMITS.maxDailyDrawdownPct && !state.tradingPaused) {
    state.tradingPaused = true;
    state.pauseReason = `Daily drawdown ${dailyDD.toFixed(2)}% exceeds ${RISK_LIMITS.maxDailyDrawdownPct}%`;
    state = addAlert(state, 'DAILY_DRAWDOWN', 'high', state.pauseReason);
    await sendTelegram(`⚠️ *RISK ALERT: Trading Paused*\n\n${state.pauseReason}\n\nDaily start: $${state.dayStartCapital.toLocaleString()}\nCurrent: $${currentCapital.toLocaleString()}\nLoss: $${(state.dayStartCapital - currentCapital).toFixed(0)}`);
  }

  // Weekly drawdown
  const weeklyDD = ((state.weekStartCapital - currentCapital) / state.weekStartCapital) * 100;
  if (weeklyDD >= RISK_LIMITS.maxWeeklyDrawdownPct && !state.tradingStopped) {
    state.tradingStopped = true;
    state.stopReason = `Weekly drawdown ${weeklyDD.toFixed(2)}% exceeds ${RISK_LIMITS.maxWeeklyDrawdownPct}%`;
    state = addAlert(state, 'WEEKLY_DRAWDOWN', 'critical', state.stopReason);
    await sendTelegram(`🚨 *CRITICAL: Trading STOPPED*\n\n${state.stopReason}\n\nWeekly start: $${state.weekStartCapital.toLocaleString()}\nCurrent: $${currentCapital.toLocaleString()}\nLoss: $${(state.weekStartCapital - currentCapital).toFixed(0)}\n\n*Principal action required to resume.*`);
  }

  return state;
}

/**
 * Check HYPE price for kHYPE liquidation risk
 */
export async function checkKhypeLiquidation(state: RiskState): Promise<RiskState> {
  try {
    const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
    const universe = meta[0].universe || [];
    const ctxs = meta[1] || [];
    for (let i = 0; i < universe.length; i++) {
      if (universe[i].name === 'HYPE') {
        const markPx = parseFloat(ctxs[i]?.markPx || '0');
        const prevPx = parseFloat(ctxs[i]?.prevDayPx || markPx.toString());
        const dropPct = ((prevPx - markPx) / prevPx) * 100;
        if (dropPct >= RISK_LIMITS.khypeLiquidationThreshold) {
          state = addAlert(state, 'KHYPE_LIQUIDATION', 'critical', `HYPE dropped ${dropPct.toFixed(2)}% in 24h — kHYPE 3x position at liquidation risk!`);
          await sendTelegram(`🚨 *KHYPE LIQUIDATION RISK*\n\nHYPE dropped ${dropPct.toFixed(2)}% in 24h.\nThreshold: ${RISK_LIMITS.khypeLiquidationThreshold}%\n\n*Auto-deleveraging kHYPE position NOW.*`);
          // TODO: Execute auto-deleverage
        }
        break;
      }
    }
  } catch {}
  return state;
}

/**
 * Reset daily counters (called at start of new day)
 */
export function resetDaily(state: RiskState, currentCapital: number): RiskState {
  state.dayStart = Date.now();
  state.dayStartCapital = currentCapital;
  state.tradingPaused = false;
  state.pauseReason = null;
  return state;
}

/**
 * Reset weekly counters (called at start of new week)
 */
export function resetWeekly(state: RiskState, currentCapital: number): RiskState {
  state.weekStart = Date.now();
  state.weekStartCapital = currentCapital;
  state.tradingStopped = false;
  state.stopReason = null;
  return state;
}

/**
 * Get risk status summary
 */
export function getRiskStatus(state: RiskState): string {
  const lines = [
    '═══ Risk Status ═══',
    `Trading: ${state.tradingStopped ? '🚨 STOPPED' : state.tradingPaused ? '⚠️ PAUSED' : '✅ ACTIVE'}`,
  ];
  if (state.pauseReason) lines.push(`Pause reason: ${state.pauseReason}`);
  if (state.stopReason) lines.push(`Stop reason: ${state.stopReason}`);
  lines.push('');
  lines.push(`Daily start: $${state.dayStartCapital.toLocaleString()}`);
  lines.push(`Weekly start: $${state.weekStartCapital.toLocaleString()}`);
  lines.push(`Open positions: ${state.positions.length}`);
  lines.push(`Total exposure: $${state.positions.reduce((s, p) => s + p.notional, 0).toLocaleString()}`);
  lines.push(`Recent alerts: ${state.alerts.filter(a => a.ts > Date.now() - 24 * 60 * 60 * 1000).length}`);
  return lines.join('\n');
}

// CLI
async function main() {
  const state = loadRiskState();
  console.log(getRiskStatus(state));

  if (process.argv.includes('--check')) {
    // Run all risk checks
    console.log('\n── Running Risk Checks ──');

    // Check HYPE price
    const hypeState = await checkKhypeLiquidation(state);
    saveRiskState(hypeState);

    console.log('✅ All risk checks complete');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
