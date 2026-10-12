/**
 * Daily Summary Report Generator
 *
 * Aggregates data from all running systems into a single Telegram message.
 * Sends at end of day (or on-demand via --send flag).
 *
 * Sections:
 *   1. Paper trader performance (today's P&L, win rate, # trades)
 *   2. Top 5 opportunities seen today (from opp-db)
 *   3. Alerts fired today (from alert history)
 *   4. Background process health (alive/dead)
 *   5. Live market snapshot (top HL funding rates)
 *   6. Wallet balance summary
 *   7. Recommendations
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const TG_API = 'https://api.telegram.org';
const HL_API = 'https://api.hyperliquid.xyz/info';
const PAPER_STATE = '/home/z/my-project/download/paper-trading-state.json';
const ALERT_HISTORY = '/tmp/opp-alert-history.jsonl';
const OPP_DB_PATH = resolve(REPO_ROOT, 'data', 'opportunities.db');

async function tgSend(text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) { console.log('[no-tg]', text); return; }
  await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── 1. Paper Trader Performance ──
function paperTraderSection(): string {
  if (!existsSync(PAPER_STATE)) return '  _No paper trader state found_';
  try {
    const state = JSON.parse(readFileSync(PAPER_STATE, 'utf8'));
    const today = new Date().toISOString().slice(0,10);
    const todayTrades = (state.closedPositions || []).filter((p: any) => {
      try {
        const ts = typeof p.ts === 'number' ? p.ts : Date.parse(p.ts);
        return new Date(ts).toISOString().slice(0,10) === today;
      } catch { return false; }
    });
    const todayPnl = todayTrades.reduce((s: number, p: any) => s + (p.netProfitUsd || p.profitUsd || 0), 0);
    const wins = todayTrades.filter((p: any) => (p.netProfitUsd || p.profitUsd || 0) > 0).length;
    const losses = todayTrades.filter((p: any) => (p.netProfitUsd || p.profitUsd || 0) < 0).length;
    const winRate = todayTrades.length > 0 ? (wins / todayTrades.length * 100).toFixed(1) : '0.0';
    const startCapital = state.startingCapital || 100000;
    const currentCapital = state.currentCapital || 0;
    const roi = startCapital > 0 ? (((currentCapital - startCapital) / startCapital) * 100).toFixed(2) : '0';
    return [
      `*Capital:* ${fmtUsd(currentCapital)} (started ${fmtUsd(startCapital)})`,
      `*Realized P&L (all-time):* ${fmtUsd(state.realizedPnl || 0)}`,
      `*ROI:* ${roi}%`,
      `*Today:* ${todayTrades.length} trades, P&L ${fmtUsd(todayPnl)} (${winRate}% win)`,
      `*Total:* ${state.closedPositions?.length || 0} closed | ${state.totalTrades || 0} total trades`,
      `*Win/Loss:* ${state.winningTrades || 0}W / ${state.losingTrades || 0}L`,
    ].join('\n');
  } catch (e) {
    return `  _Error reading paper state: ${e}_`;
  }
}

// ── 2. Top Opportunities Today ──
function oppDbSection(): string {
  if (!existsSync(OPP_DB_PATH)) return '  _No opp database yet_';
  try {
    const db = new DatabaseSync(OPP_DB_PATH);
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.getTime();

    const topPrice = db.prepare(`
      SELECT asset, MAX(spread) as max_spread, AVG(spread) as avg_spread, COUNT(*) as n
      FROM opportunities WHERE type = 'PRICE' AND ts >= ?
      GROUP BY asset ORDER BY max_spread DESC LIMIT 5
    `).all(since) as any[];

    const topFunding = db.prepare(`
      SELECT asset, MAX(funding) as max_funding, AVG(funding) as avg_funding, COUNT(*) as n
      FROM opportunities WHERE type = 'FUNDING' AND ts >= ?
      GROUP BY asset ORDER BY max_funding DESC LIMIT 5
    `).all(since) as any[];

    const totalOpps = db.prepare('SELECT COUNT(*) as n FROM opportunities WHERE ts >= ?').get(since) as any;

    const lines: string[] = [`*Total opps recorded today:* ${totalOpps.n}`];

    if (topPrice.length > 0) {
      lines.push('\n*Top 5 Price Spread (today):*');
      for (const r of topPrice) {
        lines.push(`  ${r.asset.padEnd(18)} max=${r.max_spread.toFixed(2)}% (n=${r.n})`);
      }
    }

    if (topFunding.length > 0) {
      lines.push('\n*Top 5 Funding Rate (today):*');
      for (const r of topFunding) {
        lines.push(`  ${r.asset.padEnd(18)} max=${r.max_funding.toFixed(0)}%/yr (n=${r.n})`);
      }
    }

    return lines.join('\n');
  } catch (e) {
    return `  _Error reading opp DB: ${e}_`;
  }
}

// ── 3. Alerts Fired Today ──
function alertsSection(): string {
  const entries = readJsonl(ALERT_HISTORY);
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const since = startOfDay.getTime();
  const today = entries.filter(e => e.ts >= since);
  if (today.length === 0) return '  _No alerts fired today_';
  const byType: Record<string, number> = {};
  for (const e of today) byType[e.type] = (byType[e.type] || 0) + 1;
  const typeSummary = Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(', ');
  const lines = [
    `*Total alerts:* ${today.length} (${typeSummary})`,
    '\n*Latest 5 alerts:*',
  ];
  for (const e of today.slice(-5).reverse()) {
    const time = new Date(e.ts).toISOString().slice(11,19);
    const detail = e.type === 'PRICE'
      ? `spread=${e.spread.toFixed(2)}% profit=${fmtUsd(e.profit5k)}`
      : `funding=${e.funding.toFixed(0)}%/yr profit/day=${fmtUsd(e.profit5k)}`;
    lines.push(`  ${time} ${e.type} ${e.asset} ${e.venues} ${detail}`);
  }
  return lines.join('\n');
}

// ── 4. Background Process Health ──
function healthSection(): string {
  const checks = [
    { name: 'telegram-listener',   pattern: 'tsx.*listener' },
    { name: 'command-handler',     pattern: 'tsx.*command-handler' },
    { name: 'realtime-opp-alerts', pattern: 'tsx.*realtime-opp-alerts' },
    { name: 'opp-db',              pattern: 'tsx.*opp-db' },
    { name: 'paper-trader',        pattern: 'tsx.*paper-trader' },
  ];
  // We can't run pgrep synchronously here, but we can check log file mtimes
  const lines: string[] = [];
  const now = Date.now();
  for (const c of checks) {
    const logPath = resolve(REPO_ROOT, 'logs', `${c.name}.log`);
    if (existsSync(logPath)) {
      const mtime = statSync(logPath).mtimeMs;
      const ageSec = Math.floor((now - mtime) / 1000);
      const status = ageSec < 120 ? '🟢' : ageSec < 600 ? '🟡' : '🔴';
      lines.push(`  ${status} ${c.name.padEnd(22)} last activity ${ageSec}s ago`);
    } else {
      lines.push(`  ❓ ${c.name.padEnd(22)} no log file`);
    }
  }
  return lines.join('\n');
}

// ── 5. Live Market Snapshot ──
async function marketSection(): Promise<string> {
  try {
    const r = await hlPost({ type: 'metaAndAssetCtxs' });
    const universe = r?.[0]?.universe || [];
    const ctxs = r?.[1] || [];
    const markets = universe
      .map((u: any, i: number) => ({ name: u.name, ctx: ctxs[i] }))
      .filter((m: any) => !m.name.startsWith('@') && m.ctx)
      .map((m: any) => {
        const fundingHourly = parseFloat(m.ctx.funding) || 0;
        const fundingAnnual = fundingHourly * 24 * 365 * 100;
        const oi = parseFloat(m.ctx.openInterest) * parseFloat(m.ctx.markPx);
        return { name: m.name, fundingAnnual, oi };
      })
      .sort((a: any, b: any) => b.fundingAnnual - a.fundingAnnual);

    const top = markets.slice(0, 5);
    const bottom = markets.slice(-5).reverse();
    const totalOi = markets.reduce((s: number, m: any) => s + m.oi, 0);
    const totalMarkets = markets.length;

    const lines = [
      `*Total HL markets:* ${totalMarkets}`,
      `*Total OI:* ${fmtUsd(totalOi)}`,
      '\n*Top 5 funding (short harvest):*',
      ...top.map((m: any) => `  ${m.name.padEnd(12)} +${m.fundingAnnual.toFixed(0)}%/yr  OI=${fmtUsd(m.oi)}`),
      '\n*Bottom 5 funding (long harvest):*',
      ...bottom.map((m: any) => `  ${m.name.padEnd(12)} ${m.fundingAnnual.toFixed(0)}%/yr  OI=${fmtUsd(m.oi)}`),
    ];
    return lines.join('\n');
  } catch (e) {
    return `  _Error fetching HL data: ${e}_`;
  }
}

// ── 6. Wallet Balance ──
async function walletSection(): Promise<string> {
  const agentAddr = process.env.AGENT_EVM_ADDRESS;
  if (!agentAddr) return '  _No agent EVM address configured_';
  try {
    // HL clearing house state
    const res = await hlPost({ type: 'clearingHouseState', user: agentAddr });
    if (res?.error) {
      return `*Agent EVM:* \`${agentAddr}\`\n  HL: ${res.error}`;
    }
    const marginUsed = parseFloat(res?.marginUsed || 0);
    const withdrawable = parseFloat(res?.withdrawable || 0);
    return [
      `*Agent EVM:* \`${agentAddr}\``,
      `*HL margin used:* ${fmtUsd(marginUsed)}`,
      `*HL withdrawable:* ${fmtUsd(withdrawable)}`,
      withdrawable > 0 ? '_Ready for trading!_' : '_⚠️ No USDC deposited yet — fund wallet to start live trading_',
    ].join('\n');
  } catch (e) {
    return `*Agent EVM:* \`${agentAddr}\`\n  _HL: not yet deposited (wallet not on HL)_`;
  }
}

// ── Main ──
async function main() {
  console.log('Generating daily summary report...');

  const [market, wallet] = await Promise.all([marketSection(), walletSection()]);

  const report = [
    '📊 *DAILY SUMMARY REPORT*',
    `_Generated: ${new Date().toISOString().slice(0,19)}Z_`,
    '',
    '── *1. Paper Trader* ──',
    paperTraderSection(),
    '',
    '── *2. Top Opportunities Today* ──',
    oppDbSection(),
    '',
    '── *3. Alerts Fired Today* ──',
    alertsSection(),
    '',
    '── *4. Background Process Health* ──',
    healthSection(),
    '',
    '── *5. Live HL Market Snapshot* ──',
    market,
    '',
    '── *6. Agent Wallet* ──',
    wallet,
    '',
    '── *7. Recommendations* ──',
    '  • Review top funding rates for delta-neutral harvest',
    '  • If wallet funded, deploy $5k into top VOOI price spread',
    '  • Monitor paper trader for strategy validation',
  ].join('\n');

  console.log('\n' + report + '\n');

  if (process.argv[2] === '--send') {
    await tgSend(report);
    console.log('Sent to Telegram.');
  } else {
    console.log('Dry run. Use --send to deliver via Telegram.');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
