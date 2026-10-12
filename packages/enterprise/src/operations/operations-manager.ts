/**
 * Enterprise Operations Manager
 *
 * Implements the enterprise structure from Enterprise_Structure_Manual.md
 * Manages:
 *   - Daily operations cycle
 *   - Background process supervision
 *   - Risk limit enforcement
 *   - Reporting schedule
 *   - Emergency procedures
 *
 * This is the "COO" of the enterprise — runs the daily cycle.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const SCANNER_DIR = resolve(REPO_ROOT, 'packages', 'scanner');
const ALERTS_DIR  = resolve(REPO_ROOT, 'packages', 'alerts');
const TSX_SCANNER = resolve(SCANNER_DIR, 'node_modules', '.bin', 'tsx');
const TSX_ALERTS  = resolve(ALERTS_DIR, 'node_modules', '.bin', 'tsx');

const STATE_FILE = '/home/z/my-project/download/enterprise-state.json';
const LOG_FILE   = '/home/z/my-project/download/enterprise-ops.log';

interface EnterpriseState {
  shiftStart: number;
  shiftEnd: number;
  lastProcessCheck: number;
  lastReportTime: number;
  processes: {
    scanner: boolean;
    listener: boolean;
    commandHandler: boolean;
    oppMonitor: boolean;
  };
  riskAlerts: { ts: number; type: string; message: string }[];
  dailyStats: {
    opportunitiesLogged: number;
    paperTradesExecuted: number;
    telegramMessagesSent: number;
    commitsPushed: number;
  };
}

function loadState(): EnterpriseState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    shiftStart: Date.now(),
    shiftEnd: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
    lastProcessCheck: 0,
    lastReportTime: 0,
    processes: { scanner: false, listener: false, commandHandler: false, oppMonitor: false },
    riskAlerts: [],
    dailyStats: { opportunitiesLogged: 0, paperTradesExecuted: 0, telegramMessagesSent: 0, commitsPushed: 0 },
  };
}

function saveState(state: EnterpriseState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  console.log(line.trim());
  if (existsSync(LOG_FILE)) {
    const existing = readFileSync(LOG_FILE, 'utf8');
    writeFileSync(LOG_FILE, existing + line);
  } else {
    writeFileSync(LOG_FILE, line);
  }
}

function isProcessRunning(pattern: string): boolean {
  try {
    const out = execSync(`pgrep -f "${pattern}" 2>/dev/null`, { encoding: 'utf8', stdio: 'pipe' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function startProcess(name: string, command: string, args: string[], cwd: string, logFile: string) {
  log(`Starting ${name}...`);
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: { ...process.env },
  });
  child.unref();
  return child.pid;
}

function ensureProcessesRunning(state: EnterpriseState): EnterpriseState {
  const checks = [
    { name: 'scanner', pattern: 'all-runner', cmd: TSX_SCANNER, args: ['src/runners/all-runner.ts'], cwd: SCANNER_DIR, log: '/tmp/scan-bg.log' },
    { name: 'listener', pattern: 'listener.ts', cmd: TSX_ALERTS, args: ['src/listener.ts'], cwd: ALERTS_DIR, log: '/tmp/listener-bg.log' },
    { name: 'commandHandler', pattern: 'command-handler', cmd: TSX_SCANNER, args: ['src/runners/command-handler.ts', '--loop'], cwd: SCANNER_DIR, log: '/tmp/cmd-handler.log' },
    { name: 'oppMonitor', pattern: 'opportunity-monitor', cmd: TSX_SCANNER, args: ['src/runners/opportunity-monitor.ts'], cwd: SCANNER_DIR, log: '/tmp/opp-monitor.log' },
  ];

  for (const c of checks) {
    const running = isProcessRunning(c.pattern);
    state.processes[c.name as keyof typeof state.processes] = running;
    if (!running) {
      log(`⚠️  ${c.name} not running — restarting...`);
      try {
        startProcess(c.name, c.cmd, c.args, c.cwd, c.log);
        state.processes[c.name as keyof typeof state.processes] = true;
        log(`✅ ${c.name} restarted`);
      } catch (e: any) {
        log(`❌ Failed to restart ${c.name}: ${e.message}`);
      }
    }
  }
  state.lastProcessCheck = Date.now();
  return state;
}

function checkInbox(): number {
  const inboxPath = '/tmp/telegram-inbox.jsonl';
  if (!existsSync(inboxPath)) return 0;
  try {
    const entries = readFileSync(inboxPath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    return entries.filter(e => !e.processed).length;
  } catch {
    return 0;
  }
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

function getProcessStatus(state: EnterpriseState): string {
  const emoji = (ok: boolean) => ok ? '✅' : '❌';
  return [
    `Scanner: ${emoji(state.processes.scanner)}`,
    `Listener: ${emoji(state.processes.listener)}`,
    `Cmd Handler: ${emoji(state.processes.commandHandler)}`,
    `Opp Monitor: ${emoji(state.processes.oppMonitor)}`,
  ].join(' | ');
}

async function main() {
  log('═══════════════════════════════════════════════════');
  log('  Enterprise Operations Manager — Starting');
  log('═══════════════════════════════════════════════════');

  let state = loadState();
  log(`Shift started: ${new Date(state.shiftStart).toISOString()}`);
  log(`Shift ends: ${new Date(state.shiftEnd).toISOString()}`);

  // Main operations loop — runs for 8 hours
  const CHECK_INTERVAL = 30_000; // 30 seconds

  while (Date.now() < state.shiftEnd) {
    // 1. Ensure all processes running
    state = ensureProcessesRunning(state);

    // 2. Check inbox
    const unread = checkInbox();
    if (unread > 0) {
      log(`📨 Inbox: ${unread} unread messages`);
    }

    // 3. Log status every 5 minutes
    if (Date.now() - state.lastReportTime > 5 * 60 * 1000) {
      const elapsed = Math.floor((Date.now() - state.shiftStart) / 1000 / 60);
      const remaining = Math.floor((state.shiftEnd - Date.now()) / 1000 / 60);
      log(`[${elapsed}min elapsed, ${remaining}min remaining] ${getProcessStatus(state)} | Inbox: ${unread}`);
      state.lastReportTime = Date.now();
    }

    // 4. Save state
    saveState(state);

    // 5. Sleep
    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }

  // End of shift
  log('═══════════════════════════════════════════════════');
  log('  Shift complete — saving state');
  log('═══════════════════════════════════════════════════');
  saveState(state);
}

// CLI mode — just check status and exit
if (process.argv.includes('--status')) {
  (async () => {
    const state = loadState();
    console.log('── Enterprise Status ──');
    console.log(`  Shift start: ${new Date(state.shiftStart).toISOString()}`);
    console.log(`  Shift end:   ${new Date(state.shiftEnd).toISOString()}`);
    console.log(`  Elapsed:     ${Math.floor((Date.now() - state.shiftStart) / 1000 / 60)} min`);
    console.log(`  Remaining:   ${Math.floor((state.shiftEnd - Date.now()) / 1000 / 60)} min`);
    console.log(`  Processes:`);
    console.log(`    Scanner:       ${state.processes.scanner ? '✅' : '❌'}`);
    console.log(`    Listener:      ${state.processes.listener ? '✅' : '❌'}`);
    console.log(`    Cmd Handler:   ${state.processes.commandHandler ? '✅' : '❌'}`);
    console.log(`    Opp Monitor:   ${state.processes.oppMonitor ? '✅' : '❌'}`);
    console.log(`  Daily Stats:`);
    console.log(`    Opportunities: ${state.dailyStats.opportunitiesLogged}`);
    console.log(`    Paper Trades:  ${state.dailyStats.paperTradesExecuted}`);
    console.log(`    TG Messages:   ${state.dailyStats.telegramMessagesSent}`);
    console.log(`    Commits:       ${state.dailyStats.commitsPushed}`);
    console.log(`  Risk Alerts: ${state.riskAlerts.length}`);
  })();
} else {
  main().catch(console.error);
}

export { loadState, saveState, ensureProcessesRunning, checkInbox, getProcessStatus };
