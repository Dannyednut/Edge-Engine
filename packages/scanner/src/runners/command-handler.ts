/**
 * command-handler — reads Telegram inbox, recognizes commands, responds.
 *
 * Commands recognized:
 *   /status      — show scanner status + latest scan results
 *   /opportunities — show top 5 current arb opportunities
 *   /khype       — show kHYPE LST carry arb details
 *   /euler       — show Euler HL lending arb details
 *   /scan        — trigger an immediate scan (if scanner running)
 *   /help        — show available commands
 *
 * Usage: pnpm --filter @edge/scanner command-handler
 * (or run as a loop: pnpm --filter @edge/scanner command-handler --loop)
 *
 * Architecture:
 *   listener → /tmp/telegram-inbox.jsonl
 *   command-handler (this) → reads inbox, responds via TelegramAlerter
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TelegramAlerter } from '@edge/alerts';
import { HlLstArbScanner } from '../strategies/hl-lst-arb-scanner.js';
import { EulerLendingArbScanner } from '../strategies/euler-lending-arb-scanner.js';
import { KinetiqClient } from '@edge/executor';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');
const INBOX_PATH = '/tmp/telegram-inbox.jsonl';

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

interface InboxEntry {
  id: string;
  ts: number;
  from: string;
  text: string;
  processed: boolean;
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }

  const alerter = new TelegramAlerter({ botToken, chatId });
  const args = new Set(process.argv.slice(2));
  const loop = args.has('--loop');

  console.log('[command-handler] started — polling inbox for commands');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const unprocessed = readInbox();
    if (unprocessed.length === 0) {
      if (!loop) break;
      await new Promise(r => setTimeout(r, 5000));  // poll every 5s
      continue;
    }

    for (const entry of unprocessed) {
      console.log(`[command-handler] processing: ${entry.text} (from ${entry.from})`);
      const response = await handleCommand(entry.text);
      if (response) {
        await alerter.send(response).catch(e => console.error('Send failed:', e.message));
      }
    }

    if (!loop) break;
  }
}

function readInbox(): InboxEntry[] {
  if (!existsSync(INBOX_PATH)) return [];
  const lines = readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
  const entries: InboxEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as InboxEntry); }
    catch { /* skip */ }
  }
  const unprocessed = entries.filter(e => !e.processed);
  // Mark all as processed
  const updated = entries.map(e => ({ ...e, processed: true }));
  writeFileSync(INBOX_PATH, updated.map(e => JSON.stringify(e)).join('\n') + '\n');
  return unprocessed;
}

async function handleCommand(text: string): Promise<string | null> {
  const cmd = text.trim().toLowerCase();
  console.log(`[command-handler] command: ${cmd}`);

  if (cmd === '/help' || cmd === 'help') {
    return [
      'Edge-Engine Bot Commands:',
      '',
      '/status — Scanner status + latest scan',
      '/opportunities — Top 5 current arb opportunities',
      '/khype — kHYPE LST carry arb details',
      '/euler — Euler HL lending arb details',
      '/kinetiq — Kinetiq staking status',
      '/vooi — VOOI perp funding arb details (TOP opportunity)',
      '/help — This message',
    ].join('\n');
  }

  if (cmd === '/status' || cmd === 'status') {
    return await handleStatus();
  }

  if (cmd === '/opportunities' || cmd === '/opps') {
    return await handleOpportunities();
  }

  if (cmd === '/khype') {
    return await handleKhype();
  }

  if (cmd === '/euler') {
    return await handleEuler();
  }

  if (cmd === '/kinetiq') {
    return await handleKinetiq();
  }

  if (cmd === '/vooi') {
    return await handleVooi();
  }

  // Unknown command — don't respond (avoid spam)
  return null;
}

async function handleStatus(): Promise<string> {
  try {
    // Check if scanner is running
    const { execSync } = await import('node:child_process');
    let scannerRunning = false;
    try {
      const out = execSync('pgrep -f all-runner 2>/dev/null', { encoding: 'utf8' });
      scannerRunning = out.trim().length > 0;
    } catch { /* pgrep returns non-zero if no match */ }

    return [
      '═══ Edge-Engine Status ═══',
      `Time: ${new Date().toISOString()}`,
      `Scanner: ${scannerRunning ? '✅ RUNNING' : '⚠️ NOT RUNNING'}`,
      `Strategies: 18 active`,
      '',
      'Latest opportunities:',
      '  /opportunities — for top 5',
      '  /khype — kHYPE carry arb',
      '  /euler — Euler lending arb',
    ].join('\n');
  } catch (e: any) {
    return `Status check failed: ${e.message}`;
  }
}

async function handleOpportunities(): Promise<string> {
  try {
    const lines: string[] = ['═══ Top Opportunities ═══', ''];

    // kHYPE LST carry arb
    const hlLstArb = new HlLstArbScanner({
      minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100,
    });
    const khypeAlerts = await hlLstArb.scan();
    if (khypeAlerts.length > 0) {
      const a = khypeAlerts[0];
      const annualProfit = a.estimatedProfitUsd * (365 / 8);
      lines.push(`#1 kHYPE LST carry arb`);
      lines.push(`  Discount: ${a.discountPct.toFixed(2)}%  APR: ${((annualProfit / 5000) * 100).toFixed(1)}%`);
      lines.push(`  Est. profit: $${annualProfit.toFixed(0)}/yr on $5k`);
      lines.push('');
    }

    // Euler lending arb
    const eulerArb = new EulerLendingArbScanner({
      minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000,
    });
    const eulerAlerts = await eulerArb.scan();
    for (const a of eulerAlerts.slice(0, 3)) {
      lines.push(`#${lines.filter(l => l.startsWith('#')).length + 1} Euler ${a.assetSymbol} lending arb`);
      lines.push(`  Spread: ${a.spreadPct.toFixed(2)}%  Profit: $${a.estimatedProfitUsd.toFixed(0)}/yr on $5k`);
      lines.push(`  Deposit: ${a.depositVault.apyPct.toFixed(2)}%  Borrow: ${a.borrowVault.apyPct.toFixed(2)}%`);
      lines.push('');
    }

    const totalProfit = (khypeAlerts[0] ? khypeAlerts[0].estimatedProfitUsd * (365 / 8) : 0)
                      + eulerAlerts.slice(0, 3).reduce((s, a) => s + a.estimatedProfitUsd, 0);
    lines.push(`Total: $${totalProfit.toFixed(0)}/yr on $20k = ${((totalProfit / 20000) * 100).toFixed(1)}% APR`);

    return lines.join('\n');
  } catch (e: any) {
    return `Opportunities scan failed: ${e.message}`;
  }
}

async function handleKhype(): Promise<string> {
  try {
    const hlLstArb = new HlLstArbScanner({
      minDiscountPct: 0.1, maxSizeUsd: 5_000, preferredFeeTier: 100,
    });
    const alerts = await hlLstArb.scan();
    if (alerts.length === 0) return 'No kHYPE arb opportunity right now.';

    const a = alerts[0];
    const annualProfit = a.estimatedProfitUsd * (365 / 8);
    return [
      '═══ kHYPE LST Carry Arb ═══',
      '',
      `Discount: ${a.discountPct.toFixed(2)}% on HyperSwap V3`,
      `kHYPE price: ${a.khypePrice.toFixed(6)} WHYPE`,
      `Pool liquidity: ${a.poolLiquidity.toString()}`,
      `Fee tier: ${a.feeTier/10000}%`,
      `Flashloan fee: ${a.flashloanFeePct.toFixed(2)}%`,
      '',
      `Net profit per 8-day cycle: $${a.estimatedProfitUsd.toFixed(2)}`,
      `Annualized: $${annualProfit.toFixed(0)} (${((annualProfit / 5000) * 100).toFixed(1)}% APR)`,
      '',
      'Execution:',
      '  1. Buy kHYPE on HyperSwap V3',
      '  2. Queue 7-day Kinetiq withdrawal',
      '  3. Claim HYPE after 7 days',
      '  4. Wrap to WHYPE, repeat',
      '',
      '⚠️ Needs AGENT_HYPE_PRIVKEY to execute',
    ].join('\n');
  } catch (e: any) {
    return `kHYPE scan failed: ${e.message}`;
  }
}

async function handleEuler(): Promise<string> {
  try {
    const eulerArb = new EulerLendingArbScanner({
      minSpreadPct: 0.5, minLiquidityUsd: 10_000, maxSizeUsd: 5_000,
    });
    const alerts = await eulerArb.scan();
    if (alerts.length === 0) return 'No Euler lending arb right now.';

    const lines: string[] = ['═══ Euler HL Lending Arb ═══', ''];
    for (const a of alerts) {
      lines.push(`${a.assetSymbol}: ${a.spreadPct.toFixed(2)}% spread`);
      lines.push(`  Deposit: ${a.depositVault.name} @ ${a.depositVault.apyPct.toFixed(2)}%`);
      lines.push(`  Borrow:  ${a.borrowVault.name} @ ${a.borrowVault.apyPct.toFixed(2)}%`);
      lines.push(`  Profit:  $${a.estimatedProfitUsd.toFixed(0)}/yr on $5k`);
      lines.push(`  TVL:     $${(a.totalLiquidityUsd / 1000).toFixed(0)}k combined`);
      lines.push('');
    }
    return lines.join('\n');
  } catch (e: any) {
    return `Euler scan failed: ${e.message}`;
  }
}

async function handleKinetiq(): Promise<string> {
  try {
    const kinetiq = new KinetiqClient();
    const status = await kinetiq.getStatus();
    return [
      '═══ Kinetiq Staking Status ═══',
      '',
      `Min stake: ${status.minStakeAmountHype} HYPE`,
      `Max stake: ${status.maxStakeAmountHype} HYPE`,
      `Withdrawal delay: ${status.withdrawalDelayDays.toFixed(1)} days`,
      `Unstake fee: ${status.unstakeFeeRatePct}%`,
      `Total staked: ${status.totalStakedHype.toLocaleString()} HYPE`,
      `Queued withdrawals: ${status.totalQueuedWithdrawals.toLocaleString()} HYPE`,
      `Whitelist: ${status.whitelistEnabled ? 'ENABLED' : 'OPEN'}`,
    ].join('\n');
  } catch (e: any) {
    return `Kinetiq status failed: ${e.message}`;
  }
}

async function handleVooi(): Promise<string> {
  try {
    const { VooiClient } = await import('@edge/vooi-client');
    const { getAliasInfo } = await import('../lib/alias-ticker-map.js');
    const vooi = new VooiClient({ apiToken: process.env.VOOI_API_TOKEN });
    const r = await vooi.scanArbitrage({
      minFundingSpread: 0,
      minOpenInterest: 100_000,
      notionalUsd: 5000,
      orderBy: 'fundingSpread1h',
      orderDirection: 'desc',
      limit: 100,
    });

    const opps: Array<{asset: string, name: string, apr: number, daily: number, longOi: number, shortOi: number, venues: string}> = [];
    for (const item of r.items) {
      const best = item.pairs[0];
      if (!best) continue;
      const apr = best.fundingSpread1h * 24 * 365 * 100;
      if (apr < 50) continue;
      const longOi = Number(best.long.openInterest) * Number(best.long.price);
      const shortOi = Number(best.short.openInterest) * Number(best.short.price);
      if (longOi < 100_000 || shortOi < 100_000) continue;
      const info = getAliasInfo(item.asset);
      const name = info ? `${info.realTicker} (${info.realName})` : item.asset;
      opps.push({
        asset: item.asset, name,
        apr,
        daily: (apr / 100 / 365) * 5000,
        longOi, shortOi,
        venues: `${best.long.exchange}->${best.short.exchange}`,
      });
    }
    opps.sort((a, b) => b.daily - a.daily);

    const lines: string[] = ['=== VOOI Perp Funding Arb (TOP Opportunity) ===', ''];
    for (const o of opps.slice(0, 10)) {
      lines.push(`${o.name.slice(0, 30)}`);
      lines.push(`  ${o.venues}  APR: ${o.apr.toFixed(0)}%  Daily: $${o.daily.toFixed(0)}/5k`);
      lines.push(`  OI: $${(o.longOi / 1e6).toFixed(0)}M / $${(o.shortOi / 1e6).toFixed(0)}M`);
      lines.push('');
    }
    const top5Daily = opps.slice(0, 5).reduce((s, o) => s + o.daily, 0);
    lines.push(`Top 5: $${top5Daily.toFixed(0)}/day = $${(top5Daily * 365 / 1000).toFixed(0)}k/yr on $25k`);
    lines.push(`Combined APR: ${((top5Daily * 365 / 25000) * 100).toFixed(0)}%`);
    lines.push('');
    lines.push('Execution: VOOI atomic paired-leg');
    lines.push('Needs: VOOI capital + principal approval');

    return lines.join('\n');
  } catch (e: any) {
    return `VOOI scan failed: ${e.message}`;
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
