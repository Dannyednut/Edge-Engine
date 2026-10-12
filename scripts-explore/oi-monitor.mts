// Open Interest Monitor
// Track open interest across all HL perps
// When OI spikes or drops significantly, alert
//
// High OI = high leverage = potential liquidation cascade
// Low OI = low interest = potential volatility
// OI changes signal market sentiment shifts

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const HL_API = 'https://api.hyperliquid.xyz/info';
const OI_DB = '/home/z/my-project/download/oi-history.json';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function loadOiDb(): Record<string, { ts: number; oi: number }[]> {
  if (existsSync(OI_DB)) {
    return JSON.parse(readFileSync(OI_DB, 'utf8'));
  }
  return {};
}

function saveOiDb(db: Record<string, { ts: number; oi: number }[]>) {
  writeFileSync(OI_DB, JSON.stringify(db, null, 2));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Open Interest Monitor');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get current OI for all perps
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  const currentOi: { coin: string; oi: number; oiUsd: number; markPx: number; vol: number; funding: number }[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const oi = parseFloat(ctxs[i]?.openInterest || '0');
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    const funding = parseFloat(ctxs[i]?.funding || '0');
    if (oi > 0 && markPx > 0) {
      currentOi.push({ coin: name, oi, oiUsd: oi * markPx, markPx, vol, funding });
    }
  }

  // Sort by OI USD descending
  currentOi.sort((a, b) => b.oiUsd - a.oiUsd);

  console.log(`  Total perps: ${currentOi.length}`);
  let totalOiUsd = 0;
  for (const c of currentOi) totalOiUsd += c.oiUsd;
  console.log(`  Total OI: $${(totalOiUsd/1e9).toFixed(2)}B\n`);

  // 2. Show top 20 by OI
  console.log('── Top 20 by Open Interest ──');
  console.log('Coin      | OI (units)        | OI (USD)       | Mark Price     | 24h Vol       | Funding/h');
  console.log('──────────|───────────────────|────────────────|────────────────|───────────────|──────────');
  for (const c of currentOi.slice(0, 20)) {
    console.log(`${c.coin.padEnd(10)}| ${c.oi.toFixed(4).padStart(17)}| $${(c.oiUsd/1e6).toFixed(2).padStart(13)}M| $${c.markPx.toFixed(4).padStart(14)}| $${(c.vol/1e6).toFixed(2).padStart(12)}M| ${(c.funding*100).toFixed(4)}%`);
  }

  // 3. Update OI history database
  let oiDb = loadOiDb();
  const now = Date.now();
  for (const c of currentOi) {
    if (!oiDb[c.coin]) oiDb[c.coin] = [];
    oiDb[c.coin].push({ ts: now, oi: c.oiUsd });
    if (oiDb[c.coin].length > 144) oiDb[c.coin] = oiDb[c.coin].slice(-144); // 24h of 10-min intervals
  }
  saveOiDb(oiDb);

  // 4. Compute OI changes
  console.log('\n── OI Changes (vs last data point) ──');
  const changes: any[] = [];
  for (const c of currentOi) {
    const history = oiDb[c.coin] || [];
    if (history.length < 2) continue;
    const prev = history[history.length - 2];
    const change = ((c.oiUsd - prev.oi) / prev.oi) * 100;
    if (Math.abs(change) > 5) {
      changes.push({ coin: c.coin, change, current: c.oiUsd, previous: prev.oi });
    }
  }
  changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  for (const c of changes.slice(0, 10)) {
    const emoji = c.change > 0 ? '🟢' : '🔴';
    console.log(`  ${emoji} ${c.coin.padEnd(10)} ${c.change.toFixed(2).padStart(7)}%  $${(c.current/1e6).toFixed(1)}M → $${(c.current/1e6).toFixed(1)}M`);
  }

  // 5. Strategy implications
  console.log('\n── Strategy Implications ──\n');
  console.log('  OI monitoring enables:');
  console.log('  1. LIQUIDATION CASCADE PREDICTION');
  console.log('     - High OI + price drop = potential cascade');
  console.log('     - Alert when OI > historical + price volatile');
  console.log('');
  console.log('  2. MARKET SENTIMENT');
  console.log('     - Rising OI = new money entering');
  console.log('     - Falling OI = positions closing');
  console.log('     - Use as directional signal (risky)');
  console.log('');
  console.log('  3. FUNDING RATE CORRELATION');
  console.log('     - High OI + high funding = overleveraged');
  console.log('     - Signal for funding arb entry');
  console.log('');
  console.log('  4. VOLATILITY PREDICTION');
  console.log('     - Low OI = low interest = potential volatility');
  console.log('     - Spikes after low OI periods');
  console.log('');

  console.log('=== Verdict ===');
  console.log('OI Monitor is a USEFUL addition to existing strategies.');
  console.log('  ✅ Easy to build (uses existing HL API)');
  console.log('  ✅ Provides market intelligence');
  console.log('  ✅ Improves other strategy signals');
  console.log('  ⚠️ Not a standalone strategy');
  console.log('');
  console.log('ACTION: Add OI monitor to all-runner.ts');
  console.log('  Alert when OI changes > 10% in 1 hour');
  console.log('  Use as confirmation for funding arb');
}

main().catch(console.error);
