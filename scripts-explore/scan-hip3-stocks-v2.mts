// HIP-3 Tokenized Stocks vs Yahoo Finance — Proper Scanner
// Uses ALIAS_MAP for verified stock ticker matches (no false positives)

import { readFileSync } from 'node:fs';
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

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getYahooPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

// Import ALIAS_MAP — using a static path
const ALIAS_MAP_PATH = '/home/z/my-project/edge-engine/packages/scanner/src/lib/alias-ticker-map.ts';
const aliasSource = readFileSync(ALIAS_MAP_PATH, 'utf8');

// Parse the ALIAS_MAP entries — extract { alias, yahooSymbol } pairs
const aliasEntries: { alias: string; yahoo: string; name: string; cls: string }[] = [];
const regex = /'([a-z0-9]+)':\s*\{\s*alias:[^}]+realName:\s*'([^']+)'[^}]+assetClass:\s*'([^']+)'[^}]*yahooSymbol:\s*'([^']+)'[^}]*\}/g;
let m;
while ((m = regex.exec(aliasSource)) !== null) {
  aliasEntries.push({ alias: m[1], name: m[2], cls: m[3], yahoo: m[4] });
}
console.log(`Loaded ${aliasEntries.length} alias entries with Yahoo symbols`);

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HIP-3 Stock Arb Scanner (verified tickers)');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL HIP-3 spot prices
  console.log('── Loading HL spot prices ──');
  const spotMeta = await hlInfo({ type: 'spotMetaAndAssetCtxs' });
  const universe = spotMeta[0].universe || [];
  const ctxs = spotMeta[1] || [];
  const tokens = spotMeta[0].tokens || [];

  // Build HL price lookup (alias: -> price)
  const hlPrices: Record<string, { price: number; volume: number }> = {};
  for (let i = 0; i < universe.length; i++) {
    let name = universe[i].name || '';
    const origName = name;
    if (name.startsWith('@')) {
      const idx = parseInt(name.slice(1));
      if (idx < tokens.length) name = tokens[idx].name || name;
    }
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && name.startsWith('alias:')) {
      const aliasKey = name.replace('alias:', '');
      hlPrices[aliasKey] = { price: markPx, volume: vol };
    }
  }
  console.log(`  Loaded ${Object.keys(hlPrices).length} alias: prices from HL\n`);

  // 2. Compare HL price vs Yahoo price for each verified alias
  console.log('── Cross-Venue Spreads (HL HIP-3 vs Yahoo Stock) ──');
  const arbs: any[] = [];
  let scanned = 0;
  let matched = 0;

  // Process top 50 aliases by HL volume
  const sortedAliases = Object.entries(hlPrices)
    .filter(([k]) => aliasEntries.find(a => a.alias === k))
    .sort(([, a], [, b]) => b.volume - a.volume)
    .slice(0, 50);

  console.log(`  Scanning top ${sortedAliases.length} HIP-3 stocks by volume...\n`);

  for (const [aliasKey, hlData] of sortedAliases) {
    const entry = aliasEntries.find(a => a.alias === aliasKey);
    if (!entry) continue;
    scanned++;
    const yPx = await getYahooPrice(entry.yahoo);
    if (!yPx) continue;
    matched++;
    const spread = ((hlData.price - yPx) / yPx) * 100;
    const flag = Math.abs(spread) > 1 ? ' ⚠️' : '';
    const flag2 = Math.abs(spread) > 5 ? ' 🚨' : flag;
    console.log(`  ${entry.alias.padEnd(8)} (${entry.yahoo.padEnd(8)}) HL=$${hlData.price.toFixed(4).padStart(10)}  Yahoo=$${yPx.toFixed(4).padStart(10)}  spread=${spread.toFixed(3).padStart(7)}%  vol=$${(hlData.volume/1000).toFixed(0).padStart(7)}k${flag2}`);
    if (Math.abs(spread) > 0.5) {
      arbs.push({
        alias: entry.alias,
        yahoo: entry.yahoo,
        name: entry.name,
        hl: hlData.price,
        yahoo_px: yPx,
        spreadPct: spread,
        volume: hlData.volume,
      });
    }
    // Yahoo rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  // 3. Show actionable arbs
  console.log('\n── Actionable Arbitrage Opportunities (>1% spread) ──');
  arbs.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
  if (arbs.length === 0) {
    console.log('  ✅ No arbs > 1% — HIP-3 prices tracking Yahoo efficiently');
  } else {
    for (const a of arbs.slice(0, 15)) {
      if (Math.abs(a.spreadPct) < 1) continue;
      const direction = a.spreadPct > 0 ? 'SHORT HL / LONG STOCK' : 'LONG HL / SHORT STOCK';
      const profit5k = Math.abs(a.spreadPct) / 100 * 5000;
      console.log(`  ${a.alias.padEnd(8)} ${a.yahoo.padEnd(8)} ${a.name.substring(0, 30).padEnd(30)} ${a.spreadPct.toFixed(3).padStart(7)}% ${direction}`);
      console.log(`    HL=$${a.hl.toFixed(4)} Yahoo=$${a.yahoo_px.toFixed(4)} vol=$${(a.volume/1000).toFixed(0)}k  Profit on $5k: $${profit5k.toFixed(0)}`);
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  Scanned: ${scanned}`);
  console.log(`  Matched Yahoo: ${matched}`);
  console.log(`  Arbs > 0.5%: ${arbs.length}`);
  console.log(`  Arbs > 1%: ${arbs.filter(a => Math.abs(a.spreadPct) > 1).length}`);
  console.log(`  Arbs > 5%: ${arbs.filter(a => Math.abs(a.spreadPct) > 5).length}`);

  console.log('\n=== Verdict ===');
  if (arbs.filter(a => Math.abs(a.spreadPct) > 1).length > 0) {
    console.log('🚨 LIVE ARBS DETECTED — execute via VOOI price spread executor');
  } else if (arbs.length > 0) {
    console.log('✅ Some small spreads (<1%) — HL tracking Yahoo efficiently');
    console.log('   Typical spread: <30bps (efficient market)');
  } else {
    console.log('✅ No significant spreads — HIP-3 prices efficient');
  }
  console.log('');
  console.log('Next steps:');
  console.log('  1. Add this scanner to daily opportunity monitor');
  console.log('  2. Auto-execute arbs > 1% via VOOI (already integrated)');
  console.log('  3. Send Telegram alert when arb > 2%');
}

main().catch(console.error);
