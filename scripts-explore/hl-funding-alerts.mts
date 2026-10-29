/**
 * HL Funding Rate Alert Bot
 *
 * Continuously monitors HL perp funding rates.
 * Fires Telegram alerts when:
 *   - Funding > 100%/yr → delta-neutral SHORT harvest opportunity
 *   - Funding < -50%/yr → delta-neutral LONG harvest opportunity
 *   - Funding FLIP (sign change) → trend reversal signal
 *   - Funding spike (5x previous value in 1 hour)
 *
 * Cooldowns:
 *   - Same coin+direction: 2 hours
 *   - Daily alert cap: 30
 *   - Quiet hours: 22:00-07:00 Lagos time
 *
 * State: /tmp/hl-funding-alert-state.json
 * History: /tmp/hl-funding-alert-history.jsonl
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const HL_API  = 'https://api.hyperliquid.xyz/info';
const TG_API  = 'https://api.telegram.org';

const POLL_INTERVAL_MS       = 60_000;            // 1 min
const COOLDOWN_PER_COIN_MS   = 2 * 60 * 60 * 1000; // 2 hours
const MAX_ALERTS_PER_DAY     = 30;
const SPIKE_MULTIPLIER       = 5;                  // 5x = spike
const STATE_PATH             = '/tmp/hl-funding-alert-state.json';
const HISTORY_PATH           = '/tmp/hl-funding-alert-history.jsonl';

interface AlertState {
  lastAlertedAt: Record<string, number>;  // coin|direction → epoch ms
  prevFunding: Record<string, number>;    // coin → last funding %
  dailyCount: number;
  dailyCountDate: string;
}

function loadState(): AlertState {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  }
  return {
    lastAlertedAt: {},
    prevFunding: {},
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().slice(0,10),
  };
}

function saveState(s: AlertState) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function appendHistory(entry: any) {
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

function resetDailyIfNeeded(s: AlertState): AlertState {
  const today = new Date().toISOString().slice(0,10);
  if (s.dailyCountDate !== today) {
    s.dailyCount = 0;
    s.dailyCountDate = today;
  }
  return s;
}

function isQuietHours(): boolean {
  // Lagos = UTC+1
  const hour = (new Date().getUTCHours() + 1) % 24;
  return hour >= 22 || hour < 7;
}

async function hlPost(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function getFundingRates(): Promise<Array<{ coin: string; fundingAnnual: number; fundingHourly: number; oi: number; markPx: number; prevDayPx: number; dailyChange: number }>> {
  const r = await hlPost({ type: 'metaAndAssetCtxs' });
  const universe = r?.[0]?.universe || [];
  const ctxs = r?.[1] || [];
  return universe
    .map((u: any, i: number) => ({ name: u.name, ctx: ctxs[i] }))
    .filter((m: any) => !m.name.startsWith('@') && m.ctx)
    .map((m: any) => {
      const fundingHourly = parseFloat(m.ctx.funding) || 0;
      const fundingAnnual = fundingHourly * 24 * 365 * 100;
      const markPx = parseFloat(m.ctx.markPx);
      const prevDayPx = parseFloat(m.ctx.prevDayPx);
      const oi = parseFloat(m.ctx.openInterest) * markPx;
      const dailyChange = prevDayPx > 0 ? (markPx - prevDayPx) / prevDayPx * 100 : 0;
      return { coin: m.name, fundingAnnual, fundingHourly, oi, markPx, prevDayPx, dailyChange };
    });
}

async function scanOnce(state: AlertState): Promise<{ fired: number; extreme: number; flips: number; spikes: number }> {
  let fired = 0, extreme = 0, flips = 0, spikes = 0;
  const markets = await getFundingRates();

  for (const m of markets) {
    const prevFunding = state.prevFunding[m.coin] ?? 0;
    state.prevFunding[m.coin] = m.fundingAnnual;

    // Detect flip (sign change)
    const flipSign = prevFunding !== 0 && Math.sign(prevFunding) !== Math.sign(m.fundingAnnual) && Math.abs(m.fundingAnnual) > 20;
    if (flipSign) flips++;

    // Detect spike (5x previous)
    const spike = prevFunding > 0 && m.fundingAnnual > prevFunding * SPIKE_MULTIPLIER;
    if (spike) spikes++;

    // Extreme funding
    if (m.oi < 500_000) continue;  // skip low-OI markets (false positive prevention)
    const isExtremePositive = m.fundingAnnual >= 100;
    const isExtremeNegative = m.fundingAnnual <= -50;
    if (isExtremePositive || isExtremeNegative) extreme++;

    // Should fire alert?
    const direction = m.fundingAnnual > 0 ? 'SHORT' : 'LONG';
    const key = `${m.coin}|${direction}`;
    const lastFired = state.lastAlertedAt[key] ?? 0;
    if (Date.now() - lastFired < COOLDOWN_PER_COIN_MS) continue;
    if (state.dailyCount >= MAX_ALERTS_PER_DAY) continue;
    if (isQuietHours()) continue;

    if (isExtremePositive) {
      const dailyProfit5k = 5000 * m.fundingAnnual / 100 / 365;
      const msg = [
        `🔥 *FUNDING HARVEST — SHORT*`,
        ``,
        `*Coin:* ${m.coin}`,
        `*Funding:* +${m.fundingAnnual.toFixed(0)}%/yr`,
        `*Daily profit on $5k:* ${fmtUsd(dailyProfit5k)}`,
        `*Open interest:* ${fmtUsd(m.oi)}`,
        `*24h change:* ${m.dailyChange.toFixed(2)}%`,
        ``,
        `_Action: short perp + spot long (delta-neutral)_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), coin: m.coin, direction, funding: m.fundingAnnual, oi: m.oi, dailyProfit5k });
      fired++;
      console.log(`[alert] FUNDING SHORT ${m.coin} ${m.fundingAnnual.toFixed(0)}%/yr OI=${fmtUsd(m.oi)}`);
      await new Promise(r => setTimeout(r, 1500));
    } else if (isExtremeNegative) {
      const dailyProfit5k = 5000 * Math.abs(m.fundingAnnual) / 100 / 365;
      const msg = [
        `❄️ *FUNDING HARVEST — LONG*`,
        ``,
        `*Coin:* ${m.coin}`,
        `*Funding:* ${m.fundingAnnual.toFixed(0)}%/yr (longs get paid)`,
        `*Daily profit on $5k:* ${fmtUsd(dailyProfit5k)}`,
        `*Open interest:* ${fmtUsd(m.oi)}`,
        `*24h change:* ${m.dailyChange.toFixed(2)}%`,
        ``,
        `_Action: long perp + spot short (delta-neutral)_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), coin: m.coin, direction, funding: m.fundingAnnual, oi: m.oi, dailyProfit5k });
      fired++;
      console.log(`[alert] FUNDING LONG ${m.coin} ${m.fundingAnnual.toFixed(0)}%/yr OI=${fmtUsd(m.oi)}`);
      await new Promise(r => setTimeout(r, 1500));
    } else if (flipSign) {
      const msg = [
        `🔄 *FUNDING FLIP — trend signal*`,
        ``,
        `*Coin:* ${m.coin}`,
        `*Previous:* ${prevFunding.toFixed(0)}%/yr`,
        `*Current:* ${m.fundingAnnual.toFixed(0)}%/yr`,
        `*24h change:* ${m.dailyChange.toFixed(2)}%`,
        ``,
        `_Sign flip = market sentiment shift_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), coin: m.coin, type: 'FLIP', prev: prevFunding, current: m.fundingAnnual });
      fired++;
      console.log(`[alert] FLIP ${m.coin} ${prevFunding.toFixed(0)}%→${m.fundingAnnual.toFixed(0)}%`);
      await new Promise(r => setTimeout(r, 1500));
    } else if (spike) {
      const msg = [
        `📈 *FUNDING SPIKE*`,
        ``,
        `*Coin:* ${m.coin}`,
        `*Previous:* ${prevFunding.toFixed(0)}%/yr`,
        `*Current:* ${m.fundingAnnual.toFixed(0)}%/yr (${SPIKE_MULTIPLIER}x spike)`,
        `*Open interest:* ${fmtUsd(m.oi)}`,
        ``,
        `_Funding pressure increasing rapidly_`,
      ].join('\n');
      await tgSend(msg);
      state.lastAlertedAt[key] = Date.now();
      state.dailyCount++;
      appendHistory({ ts: Date.now(), coin: m.coin, type: 'SPIKE', prev: prevFunding, current: m.fundingAnnual });
      fired++;
      console.log(`[alert] SPIKE ${m.coin} ${prevFunding.toFixed(0)}%→${m.fundingAnnual.toFixed(0)}%`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return { fired, extreme, flips, spikes };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Funding Rate Alert Bot');
  console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s | Cooldown: ${COOLDOWN_PER_COIN_MS / 60000}min`);
  console.log(`  Daily cap: ${MAX_ALERTS_PER_DAY} | Quiet hours (Lagos): 22:00-07:00`);
  console.log('═══════════════════════════════════════════════════\n');

  let state = loadState();
  state = resetDailyIfNeeded(state);
  saveState(state);

  await tgSend('🟢 *HL Funding Rate Alert Bot started*\n\n_Watching all HL perps for extreme funding, flips, and spikes..._');

  let loop = 0;
  while (true) {
    loop++;
    const startTs = Date.now();
    try {
      const { fired, extreme, flips, spikes } = await scanOnce(state);
      state = resetDailyIfNeeded(state);
      saveState(state);
      const dur = Date.now() - startTs;
      console.log(`[loop ${loop}] ${new Date().toISOString()} extreme=${extreme} flips=${flips} spikes=${spikes} fired=${fired} (${dur}ms) daily=${state.dailyCount}/${MAX_ALERTS_PER_DAY}`);
    } catch (err) {
      console.error(`[loop ${loop}] error:`, err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
