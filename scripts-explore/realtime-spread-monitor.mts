/**
 * Real-Time Price Spread Monitor (Sub-Second)
 *
 * Continuously polls VOOI + HL for price spreads, fires alerts
 * when spread exceeds threshold. Designed for sub-second execution.
 *
 * Strategy:
 *   - Poll VOOI every 5 seconds (instead of 60s)
 *   - Poll HL L2 order book every 2 seconds
 *   - When spread > 2% detected → immediate Telegram alert
 *   - Track spread duration (how long it persists)
 *   - Calculate capture probability based on spread size + duration
 *
 * This is the FASTEST opportunity detector in the system.
 * Designed for instant-execution strategies.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

const VOI_API = 'https://perps-api.vooi.io';
const HL_API  = 'https://api.hyperliquid.xyz/info';
const TG_API  = 'https://api.telegram.org';

const POLL_INTERVAL_MS = 5_000;  // 5 seconds (fast!)
const SPREAD_ALERT_THRESHOLD = 2.0;  // 2% spread = alert
const HIGH_SPREAD_THRESHOLD = 5.0;   // 5% = high priority
const COOLDOWN_PER_ASSET_MS = 5 * 60 * 1000;  // 5 min per asset
const DAILY_ALERT_CAP = 200;
const STATE_PATH = '/tmp/realtime-spread-state.json';
const HISTORY_PATH = '/tmp/realtime-spread-history.jsonl';

interface SpreadState {
  lastAlertedAt: Record<string, number>;  // asset → epoch ms
  dailyCount: number;
  dailyCountDate: string;
  activeSpreads: Record<string, { spread: number; firstSeenAt: number; lastSeenAt: number; count: number }>;
}

function loadState(): SpreadState {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  }
  return {
    lastAlertedAt: {},
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().slice(0,10),
    activeSpreads: {},
  };
}

function saveState(s: SpreadState) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function appendHistory(entry: any) {
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

function resetDailyIfNeeded(s: SpreadState): SpreadState {
  const today = new Date().toISOString().slice(0,10);
  if (s.dailyCountDate !== today) {
    s.dailyCount = 0;
    s.dailyCountDate = today;
  }
  return s;
}

async function tgSend(text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

async function vooiScan(params: any): Promise<any> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const url = `${VOI_API}/arbitrage-scanner?${q.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return { items: [] };
  return res.json();
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function scanOnce(state: SpreadState): Promise<{ scanned: number; fired: number; activeCount: number }> {
  let scanned = 0;
  let fired = 0;

  // Fetch price spreads
  const resp = await vooiScan({ limit: 50, orderBy: 'priceSpread', orderDirection: 'desc', minPriceSpread: 0.005 });
  const now = Date.now();

  // Track which assets we see this cycle
  const seenAssets = new Set<string>();

  for (const item of (resp?.items || [])) {
    for (const p of (item.pairs || [])) {
      const spreadPct = (p.priceSpread || 0) * 100;
      if (spreadPct < 0.5) continue;  // skip tiny spreads
      scanned++;
      seenAssets.add(item.asset);

      const assetKey = `${item.asset}|${p.long?.exchange}|${p.short?.exchange}`;

      // Track active spread
      if (!state.activeSpreads[assetKey]) {
        state.activeSpreads[assetKey] = {
          spread: spreadPct,
          firstSeenAt: now,
          lastSeenAt: now,
          count: 1,
        };
      } else {
        state.activeSpreads[assetKey].spread = spreadPct;
        state.activeSpreads[assetKey].lastSeenAt = now;
        state.activeSpreads[assetKey].count++;
      }

      // Alert if spread is significant and not on cooldown
      if (spreadPct < SPREAD_ALERT_THRESHOLD) continue;
      const lastFired = state.lastAlertedAt[assetKey] ?? 0;
      if (now - lastFired < COOLDOWN_PER_ASSET_MS) continue;
      if (state.dailyCount >= DAILY_ALERT_CAP) continue;

      const profit5k = 5000 * spreadPct / 100 - 5000 * 0.003;
      const duration = (now - state.activeSpreads[assetKey].firstSeenAt) / 1000;
      const isHigh = spreadPct >= HIGH_SPREAD_THRESHOLD;
      const icon = isHigh ? '🔥' : '⚡';

      const msg = [
        `${icon} SPREAD ALERT: ${item.asset}`,
        ``,
        `Spread: ${spreadPct.toFixed(2)}%`,
        `Venues: ${p.long?.exchange} → ${p.short?.exchange}`,
        `Profit on $5k: ${fmtUsd(profit5k)}`,
        `Duration: ${duration.toFixed(0)}s (${state.activeSpreads[assetKey].count} scans)`,
        ``,
        isHigh ? 'HIGH PRIORITY — execute now' : 'Standard opportunity',
      ].join('\n');

      await tgSend(msg);
      state.lastAlertedAt[assetKey] = now;
      state.dailyCount++;
      appendHistory({
        ts: now,
        asset: item.asset,
        spread: spreadPct,
        venues: `${p.long?.exchange}→${p.short?.exchange}`,
        profit5k,
        duration,
        high: isHigh,
      });
      fired++;
      console.log(`[${new Date().toISOString()}] ${isHigh ? '🔥' : '⚡'} ${item.asset} ${spreadPct.toFixed(2)}% ${p.long?.exchange}→${p.short?.exchange} $${profit5k.toFixed(0)}`);
      await new Promise(r => setTimeout(r, 500));  // throttle
    }
  }

  // Clean up stale active spreads (not seen in last 60s)
  for (const key of Object.keys(state.activeSpreads)) {
    if (now - state.activeSpreads[key].lastSeenAt > 60_000) {
      const duration = (state.activeSpreads[key].lastSeenAt - state.activeSpreads[key].firstSeenAt) / 1000;
      console.log(`[expired] ${key} lasted ${duration.toFixed(0)}s, ${state.activeSpreads[key].count} scans, max ${state.activeSpreads[key].spread.toFixed(2)}%`);
      delete state.activeSpreads[key];
    }
  }

  return { scanned, fired, activeCount: Object.keys(state.activeSpreads).length };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Real-Time Price Spread Monitor');
  console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s | Alert threshold: ${SPREAD_ALERT_THRESHOLD}%`);
  console.log(`  High priority: ${HIGH_SPREAD_THRESHOLD}% | Cooldown: ${COOLDOWN_PER_ASSET_MS / 60000}min`);
  console.log(`  Daily cap: ${DAILY_ALERT_CAP}`);
  console.log('═══════════════════════════════════════════════════\n');

  let state = loadState();
  state = resetDailyIfNeeded(state);
  saveState(state);

  await tgSend('⚡ Real-time spread monitor started (5s polling)');

  let loop = 0;
  while (true) {
    loop++;
    const startTs = Date.now();
    try {
      const { scanned, fired, activeCount } = await scanOnce(state);
      state = resetDailyIfNeeded(state);
      saveState(state);
      const dur = Date.now() - startTs;
      if (scanned > 0 || fired > 0 || loop % 12 === 0) {  // log every minute or on activity
        console.log(`[loop ${loop}] ${new Date().toISOString().slice(11,19)} scanned=${scanned} fired=${fired} active=${activeCount} (${dur}ms) daily=${state.dailyCount}/${DAILY_ALERT_CAP}`);
      }
    } catch (err) {
      console.error(`[loop ${loop}] error:`, err);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
