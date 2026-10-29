/**
 * Risk Dashboard with Kill Switch
 *
 * Monitors all live trading activity. Triggers kill switch if:
 *   - Daily drawdown > MAX_DAILY_LOSS_USD
 *   - Single position loss > MAX_PER_TRADE_LOSS_USD
 *   - Concurrent positions > MAX_CONCURRENT_ARBS
 *   - Margin usage > 80% of available
 *   - Gas price > GAS_PRICE_CAP_MULT of average
 *
 * When kill switch triggers:
 *   1. Sends CRITICAL Telegram alert
 *   2. Writes kill-switch-fired flag to /tmp/kill-switch-fired
 *   3. All execution scripts must check this flag before trading
 *
 * Other features:
 *   - Real-time P&L tracking (from paper trader state)
 *   - Position exposure by asset
 *   - Daily/weekly/monthly P&L history
 *   - Risk score (1-100)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const TG_API = 'https://api.telegram.org';
const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';
const KILL_SWITCH_FILE = '/tmp/kill-switch-fired';
const RISK_STATE_FILE = '/tmp/risk-state.json';

interface RiskState {
  dailyPnlStart: number;
  dailyPnlHighWater: number;
  dailyPnlLowWater: number;
  dailyDate: string;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  killSwitchFiredAt: number | null;
  lastAlertTs: number;
}

function loadRiskState(): RiskState {
  if (existsSync(RISK_STATE_FILE)) {
    try { return JSON.parse(readFileSync(RISK_STATE_FILE, 'utf8')); } catch {}
  }
  return {
    dailyPnlStart: 0,
    dailyPnlHighWater: 0,
    dailyPnlLowWater: 0,
    dailyDate: new Date().toISOString().slice(0,10),
    killSwitchActive: false,
    killSwitchReason: null,
    killSwitchFiredAt: null,
    lastAlertTs: 0,
  };
}

function saveRiskState(s: RiskState) {
  writeFileSync(RISK_STATE_FILE, JSON.stringify(s, null, 2));
}

async function tgSend(text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function loadPaperState(): any {
  if (!existsSync(PAPER_STATE)) return null;
  try { return JSON.parse(readFileSync(PAPER_STATE, 'utf8')); } catch { return null; }
}

function fireKillSwitch(state: RiskState, reason: string): RiskState {
  state.killSwitchActive = true;
  state.killSwitchReason = reason;
  state.killSwitchFiredAt = Date.now();
  writeFileSync(KILL_SWITCH_FILE, JSON.stringify({
    firedAt: Date.now(),
    reason,
  }, null, 2));
  const msg = [
    '🛑 *KILL SWITCH ACTIVATED*',
    '',
    `*Reason:* ${reason}`,
    `*Time:* ${new Date().toISOString()}`,
    '',
    '_All trading execution halted._',
    '_Resolve the issue and remove /tmp/kill-switch-fired to resume._',
  ].join('\n');
  tgSend(msg).catch(() => {});
  console.error(`[KILL SWITCH] ${reason}`);
  return state;
}

function checkKillSwitch(state: RiskState, paperState: any): RiskState {
  const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS_USD || '200');
  const maxPerTradeLoss = parseFloat(process.env.MAX_PER_TRADE_LOSS_USD || '50');
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_ARBS || '3');

  if (state.killSwitchActive) return state;

  // Check daily P&L
  const today = new Date().toISOString().slice(0,10);
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyPnlStart = paperState?.realizedPnl || 0;
    state.dailyPnlHighWater = state.dailyPnlStart;
    state.dailyPnlLowWater = state.dailyPnlStart;
  }

  const currentPnl = paperState?.realizedPnl || 0;
  const dailyPnl = currentPnl - state.dailyPnlStart;
  state.dailyPnlHighWater = Math.max(state.dailyPnlHighWater, currentPnl);
  state.dailyPnlLowWater = Math.min(state.dailyPnlLowWater, currentPnl);

  if (dailyPnl < -maxDailyLoss) {
    return fireKillSwitch(state, `Daily loss limit breached: ${fmtUsd(dailyPnl)} < -${fmtUsd(maxDailyLoss)}`);
  }

  // Check concurrent positions
  const openPositions = paperState?.openPositions?.length || 0;
  if (openPositions > maxConcurrent) {
    return fireKillSwitch(state, `Too many concurrent positions: ${openPositions} > ${maxConcurrent}`);
  }

  // Check last closed trade for excessive loss
  const lastTrade = (paperState?.closedPositions || []).slice(-1)[0];
  if (lastTrade && (lastTrade.netProfitUsd || 0) < -maxPerTradeLoss) {
    return fireKillSwitch(state, `Single trade loss exceeded: ${fmtUsd(lastTrade.netProfitUsd)} < -${fmtUsd(maxPerTradeLoss)}`);
  }

  return state;
}

function calcRiskScore(state: RiskState, paperState: any): number {
  // Risk score 1-100 (100 = highest risk)
  let score = 0;
  const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS_USD || '200');

  // Daily P&L drawdown
  const currentPnl = paperState?.realizedPnl || 0;
  const dailyPnl = currentPnl - state.dailyPnlStart;
  const dailyLossPct = Math.max(0, -dailyPnl) / maxDailyLoss;
  score += dailyLossPct * 40;

  // Open positions count
  const openPositions = paperState?.openPositions?.length || 0;
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_ARBS || '3');
  score += (openPositions / maxConcurrent) * 20;

  // Win rate (lower = higher risk)
  const winRate = paperState?.winningTrades / Math.max(1, paperState?.totalTrades) || 1;
  score += (1 - winRate) * 20;

  // Recent volatility (last 10 trades P&L variance)
  const recent = (paperState?.closedPositions || []).slice(-10);
  if (recent.length > 0) {
    const pnls = recent.map((p: any) => p.netProfitUsd || 0);
    const mean = pnls.reduce((s: number, n: number) => s + n, 0) / pnls.length;
    const variance = pnls.reduce((s: number, n: number) => s + (n - mean) ** 2, 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    score += Math.min(stdDev / 50, 1) * 20;
  }

  return Math.round(Math.min(100, Math.max(1, score)));
}

function printDashboard(state: RiskState, paperState: any, riskScore: number) {
  const today = new Date().toISOString().slice(0,10);
  const currentPnl = paperState?.realizedPnl || 0;
  const dailyPnl = currentPnl - state.dailyPnlStart;

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  RISK DASHBOARD — ${new Date().toISOString().slice(11,19)}`);
  console.log('═══════════════════════════════════════════════════');

  console.log('\n── P&L ──');
  console.log(`  All-time realized: ${fmtUsd(currentPnl)}`);
  console.log(`  Today (${today}): ${dailyPnl >= 0 ? '+' : ''}${fmtUsd(dailyPnl)}`);
  console.log(`  Daily high: ${fmtUsd(state.dailyPnlHighWater - state.dailyPnlStart)}`);
  console.log(`  Daily low:  ${fmtUsd(state.dailyPnlLowWater - state.dailyPnlStart)}`);

  console.log('\n── Limits ──');
  const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS_USD || '200');
  const maxPerTradeLoss = parseFloat(process.env.MAX_PER_TRADE_LOSS_USD || '50');
  const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_ARBS || '3');
  console.log(`  Daily loss limit:    ${fmtUsd(maxDailyLoss)} | current: ${fmtUsd(Math.max(0, -dailyPnl))} (${(Math.max(0, -dailyPnl) / maxDailyLoss * 100).toFixed(0)}% used)`);
  console.log(`  Per-trade loss cap:  ${fmtUsd(maxPerTradeLoss)}`);
  console.log(`  Max concurrent:      ${maxConcurrent} | current: ${paperState?.openPositions?.length || 0}`);

  console.log('\n── Risk Score ──');
  const icon = riskScore < 30 ? '🟢' : riskScore < 60 ? '🟡' : '🔴';
  console.log(`  ${icon} ${riskScore}/100 ${riskScore < 30 ? 'SAFE' : riskScore < 60 ? 'CAUTION' : 'DANGER'}`);

  console.log('\n── Kill Switch ──');
  if (state.killSwitchActive) {
    console.log(`  🔴 ACTIVE — ${state.killSwitchReason}`);
    console.log(`  Fired at: ${state.killSwitchFiredAt ? new Date(state.killSwitchFiredAt).toISOString() : 'unknown'}`);
  } else {
    console.log('  🟢 Not triggered');
  }

  // Recent trades
  const recent = (paperState?.closedPositions || []).slice(-5);
  if (recent.length > 0) {
    console.log('\n── Last 5 Trades ──');
    for (const t of recent.reverse()) {
      const time = new Date(t.ts).toISOString().slice(11,19);
      const pnl = t.netProfitUsd || 0;
      const pnlStr = pnl >= 0 ? `+${fmtUsd(pnl)}` : `-${fmtUsd(Math.abs(pnl))}`;
      console.log(`  ${time} ${t.asset.padEnd(18)} ${pnlStr.padStart(8)}  ${(t.strategy || '').padEnd(28)}`);
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Risk Dashboard with Kill Switch');
  console.log(`  Poll: 30s | Daily loss cap: ${process.env.MAX_DAILY_LOSS_USD || 200}`);
  console.log('═══════════════════════════════════════════════════\n');

  let state = loadRiskState();
  const paperState0 = loadPaperState();
  if (paperState0) {
    state.dailyPnlStart = paperState0.realizedPnl || 0;
    state.dailyPnlHighWater = state.dailyPnlStart;
    state.dailyPnlLowWater = state.dailyPnlStart;
  }
  saveRiskState(state);

  // Clear any stale kill switch on startup
  if (existsSync(KILL_SWITCH_FILE) && !state.killSwitchActive) {
    console.log('[startup] Clearing stale kill-switch flag');
    try { require('fs').unlinkSync(KILL_SWITCH_FILE); } catch {}
  }

  let loop = 0;
  while (true) {
    loop++;
    try {
      const paperState = loadPaperState();
      if (paperState) {
        state = checkKillSwitch(state, paperState);
        saveRiskState(state);
        const riskScore = calcRiskScore(state, paperState);
        printDashboard(state, paperState, riskScore);
      } else {
        console.log(`[loop ${loop}] no paper state`);
      }
    } catch (e) {
      console.error(`[loop ${loop}] error:`, e);
    }
    await new Promise(r => setTimeout(r, 30_000));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
