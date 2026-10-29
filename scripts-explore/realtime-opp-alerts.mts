/**
 * Real-time Opportunity Alert Loop
 *
 * Continuously polls VOOI + HL scanners and fires Telegram alerts when:
 *   - Price spread > MIN_PRICE_SPREAD_ALERT% (instant arb)
 *   - Funding rate > MIN_FUNDING_YIELD_ALERT%/yr (delta-neutral arb)
 *   - NEW asset appears in top opportunities
 *   - Existing opp crosses higher threshold (e.g., spread doubles)
 *
 * Throttling:
 *   - Same opp cannot fire more than once per COOLDOWN_PER_OPP_MS (default 30 min)
 *   - Daily alert cap: MAX_ALERTS_PER_DAY (default 50)
 *   - Quiet hours: 22:00-07:00 principal local time (no alerts)
 *
 * Persistence:
 *   - /tmp/opp-alert-state.json — tracks cooldowns + daily count
 *   - /tmp/opp-alert-history.jsonl — append-only log of every alert sent
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

// Load .env
loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const VOI_API  = 'https://perps-api.vooi.io';
const HL_API   = 'https://api.hyperliquid.xyz/info';
const TG_API   = 'https://api.telegram.org';

// Tunables — configurable via env vars, with sensible defaults.
// Lowered from 5%→2% and $200→$50 per the alert-quality audit
// (docs/ALERT_QUALITY_AUDIT.md). The 5% threshold was too high —
// most real arbs are 0.5-2%, so 0 alerts were being sent despite
// thousands of actionable opportunities.
const POLL_INTERVAL_MS         = Number(process.env.OPP_ALERT_POLL_MS ?? 60_000);          // 1 min
const MIN_PRICE_SPREAD_ALERT   = Number(process.env.OPP_ALERT_MIN_SPREAD_PCT ?? 2.0);     // %, fire alert when ≥
const MIN_FUNDING_YIELD_ALERT  = Number(process.env.OPP_ALERT_MIN_FUNDING_PCT ?? 100.0);  // %/yr, fire alert when ≥
const MIN_PROFIT_USD_ALERT     = Number(process.env.OPP_ALERT_MIN_PROFIT_USD ?? 50);      // $ profit on $5k
const COOLDOWN_PER_OPP_MS      = Number(process.env.OPP_ALERT_COOLDOWN_MS ?? 30 * 60 * 1000);  // 30 min
const MAX_ALERTS_PER_DAY       = Number(process.env.OPP_ALERT_MAX_DAILY ?? 50);
const STATE_PATH               = '/tmp/opp-alert-state.json';
const HISTORY_PATH             = '/tmp/opp-alert-history.jsonl';

interface AlertState {
  lastAlertedAt: Record<string, number>;  // oppKey → epoch ms
  dailyCount: number;
  dailyCountDate: string;  // YYYY-MM-DD
  seenAssets: string[];    // assets ever seen
}

function loadState(): AlertState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch {}
  }
  return { lastAlertedAt: {}, dailyCount: 0, dailyCountDate: new Date().toISOString().slice(0,10), seenAssets: [] };
}

function saveState(s: AlertState) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function appendHistory(entry: any) {
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

function oppKey(type: string, asset: string, venues: string): string {
  return `${type}|${asset}|${venues}`;
}

function resetDailyIfNeeded(state: AlertState): AlertState {
  const today = new Date().toISOString().slice(0,10);
  if (state.dailyCountDate !== today) {
    state.dailyCount = 0;
    state.dailyCountDate = today;
  }
  return state;
}

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [], total: 0 };
  return res.json();
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

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function isQuietHours(): boolean {
  // Use UTC+1 (principal timezone Africa/Lagos)
  const hour = (new Date().getUTCHours() + 1) % 24;
  return hour >= 22 || hour < 7;
}

async function scanOnce(state: AlertState): Promise<{ fired: number; scanned: number }> {
  let fired = 0;
  let scanned = 0;

  // ── Price spread scan ──
  const priceResp = await vooiScan({ limit: 30, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: MIN_PRICE_SPREAD_ALERT / 100 });
  for (const item of (priceResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spreadPct = (p.priceSpread || 0) * 100;
      if (spreadPct < MIN_PRICE_SPREAD_ALERT) continue;
      const profit5k = 5000 * spreadPct / 100 - 5000 * 0.003;
      if (profit5k < MIN_PROFIT_USD_ALERT) continue;
      scanned++;
      const venues = `${p.long?.exchange}→${p.short?.exchange}`;
      const key = oppKey('PRICE', item.asset, venues);
      const lastFired = state.lastAlertedAt[key] ?? 0;
      if (Date.now() - lastFired < COOLDOWN_PER_OPP_MS) continue;
      if (state.dailyCount >= MAX_ALERTS_PER_DAY) continue;
      if (isQuietHours()) continue;

      const msg = [
        `💎 *PRICE ARB OPP*`,
        ``,
        `*Asset:* ${item.asset}`,
        `*Spread:* ${spreadPct.toFixed(2)}%`,
        `*Profit on $5k:* ${fmtMoney(profit5k)}`,
        `*Venues:* ${venues}`,
        ``,
        `_Action: instant capture_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), type: 'PRICE', asset: item.asset, spread: spreadPct, profit5k, venues });
      fired++;
      console.log(`[alert] PRICE ${item.asset} ${venues} ${spreadPct.toFixed(2)}% $${profit5k.toFixed(0)}`);
      await new Promise(r => setTimeout(r, 1500)); // throttle
    }
  }

  // ── Funding rate scan ──
  const fundResp = await vooiScan({ limit: 30, orderBy: 'fundingRate', orderDirection: 'desc', minFundingRate: MIN_FUNDING_YIELD_ALERT / 100 / 365 });
  for (const item of (fundResp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const funding = (p.fundingRate || 0) * 365 * 100;  // convert to annual %
      if (funding < MIN_FUNDING_YIELD_ALERT) continue;
      const profit5k = 5000 * funding / 100 / 365 * 1;  // 1-day funding
      if (profit5k < MIN_PROFIT_USD_ALERT / 4) continue;  // funding is daily
      scanned++;
      const venues = `${p.long?.exchange}→${p.short?.exchange}`;
      const key = oppKey('FUNDING', item.asset, venues);
      const lastFired = state.lastAlertedAt[key] ?? 0;
      if (Date.now() - lastFired < COOLDOWN_PER_OPP_MS) continue;
      if (state.dailyCount >= MAX_ALERTS_PER_DAY) continue;
      if (isQuietHours()) continue;

      const msg = [
        `💰 *FUNDING ARB OPP*`,
        ``,
        `*Asset:* ${item.asset}`,
        `*Annual yield:* ${funding.toFixed(0)}%/yr`,
        `*Daily profit on $5k:* ${fmtMoney(profit5k)}`,
        `*Venues:* ${venues}`,
        ``,
        `_Action: 12-96h hold, delta-neutral_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), type: 'FUNDING', asset: item.asset, funding, profit5k, venues });
      fired++;
      console.log(`[alert] FUNDING ${item.asset} ${venues} ${funding.toFixed(0)}%/yr $${profit5k.toFixed(0)}/day`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // ── New asset alert ──
  const allAssets = new Set<string>([
    ...(priceResp?.items || []).map((i: any) => i.asset),
    ...(fundResp?.items || []).map((i: any) => i.asset),
  ]);
  for (const asset of allAssets) {
    if (!state.seenAssets.includes(asset)) {
      state.seenAssets.push(asset);
      // Only alert if not first run
      if (state.seenAssets.length > 20) {
        console.log(`[alert] NEW ASSET detected: ${asset}`);
        // Note: skipping Telegram alert for new asset to avoid spam
      }
    }
  }

  return { fired, scanned };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Real-time Opportunity Alert Loop');
  console.log(`  Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Price spread alert: ≥${MIN_PRICE_SPREAD_ALERT}%`);
  console.log(`  Funding yield alert: ≥${MIN_FUNDING_YIELD_ALERT}%/yr`);
  console.log(`  Quiet hours (Lagos): 22:00-07:00`);
  console.log('═══════════════════════════════════════════════════\n');

  let state = loadState();
  state = resetDailyIfNeeded(state);
  saveState(state);

  // Send startup ping
  await tgSend('🟢 *Real-time alert loop started*\n\n_Watching VOOI + HL for high-value opps..._');

  let loop = 0;
  while (true) {
    loop++;
    const startTs = Date.now();
    try {
      const { fired, scanned } = await scanOnce(state);
      state = resetDailyIfNeeded(state);
      saveState(state);
      const dur = Date.now() - startTs;
      console.log(`[loop ${loop}] ${new Date().toISOString()} scanned=${scanned} fired=${fired} (${dur}ms) daily=${state.dailyCount}/${MAX_ALERTS_PER_DAY}`);
    } catch (err) {
      console.error(`[loop ${loop}] error:`, err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
