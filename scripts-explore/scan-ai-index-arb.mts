// AI Index Arbitrage Scanner
// Compare basket of AI tokens/perps on HL vs public AI ETFs
// Alert when deviation > threshold

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

// Yahoo Finance API (free, no key required)
async function getYahooPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    return meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  AI Index Arbitrage Scanner');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get HL perp prices for AI-related tokens
  console.log('── HL AI-Related Perp Prices ──');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];

  // AI-related tokens on HL perp
  const aiTokens = [
    { name: 'NVDA', etf: 'NVDA', sector: 'GPU' },
    { name: 'TSMC', etf: 'TSM', sector: 'GPU' },
    { name: 'PLTR', etf: 'PLTR', sector: 'AI Software' },
    { name: 'SOUNDHOUND', etf: 'SOUN', sector: 'AI Voice' },
    { name: 'XAI', etf: null, sector: 'AI Lab' },
    { name: 'NEAR', etf: 'NEAR', sector: 'AI Chain' },
    { name: 'WLD', etf: 'WLD', sector: 'AI Identity' },
    { name: 'ENA', etf: 'ENA', sector: 'AI Agent' },
    { name: 'LIT', etf: 'LIT', sector: 'AI Compute' },
    { name: 'ZRO', etf: 'ZRO', sector: 'AI Infra' },
    { name: 'AI16Z', etf: null, sector: 'AI Fund' },
    { name: 'TAO', etf: null, sector: 'AI Chain' },
    { name: 'GOAT', etf: null, sector: 'AI Meme' },
  ];

  const hlPrices: Record<string, number> = {};
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    if (markPx > 0 && aiTokens.some(t => t.name === name)) {
      hlPrices[name] = markPx;
    }
  }

  console.log('  HL perp prices found:');
  for (const t of aiTokens) {
    if (hlPrices[t.name]) {
      console.log(`    ${t.name.padEnd(15)} $${hlPrices[t.name].toFixed(4)}  (${t.sector})`);
    }
  }

  // 2. Get Yahoo Finance prices for same tickers
  console.log('\n── Yahoo Finance Stock Prices ──');
  const yahooPrices: Record<string, number> = {};
  for (const t of aiTokens) {
    if (t.etf) {
      const px = await getYahooPrice(t.etf);
      if (px) {
        yahooPrices[t.etf] = px;
        console.log(`    ${t.etf.padEnd(15)} $${px.toFixed(4)}  (Yahoo)`);
      } else {
        console.log(`    ${t.etf.padEnd(15)} (unavailable)`);
      }
    }
  }

  // 3. Compute spreads (HL perp vs Yahoo stock)
  console.log('\n── Cross-Venue Spreads (HL perp vs stock) ──');
  const spreads: any[] = [];
  for (const t of aiTokens) {
    const hlPx = hlPrices[t.name];
    const yPx = yahooPrices[t.etf || ''];
    if (hlPx && yPx) {
      const spread = ((hlPx - yPx) / yPx) * 100;
      spreads.push({ token: t.name, etf: t.etf, hl: hlPx, yahoo: yPx, spreadPct: spread });
      const flag = Math.abs(spread) > 1 ? ' ⚠️' : '';
      console.log(`  ${t.name.padEnd(15)} HL=$${hlPx.toFixed(4).padStart(10)}  Yahoo=$${yPx.toFixed(4).padStart(10)}  spread=${spread.toFixed(3).padStart(7)}%${flag}`);
    }
  }

  // 4. Find arbitrage opportunities
  console.log('\n── Arbitrage Opportunities (>1% spread) ──');
  const arbs = spreads.filter(s => Math.abs(s.spreadPct) > 1);
  if (arbs.length === 0) {
    console.log('  ✅ No arbs > 1% — HL perps tracking stocks well');
  } else {
    for (const a of arbs) {
      const direction = a.spreadPct > 0 ? 'SHORT HL / LONG STOCK' : 'LONG HL / SHORT STOCK';
      const profit = Math.abs(a.spreadPct) / 100 * 10000; // on $10k
      console.log(`  ${a.token}: ${a.spreadPct.toFixed(3)}% — ${direction}`);
      console.log(`    Profit on $10k: $${profit.toFixed(0)}/cycle`);
    }
  }

  // 5. AI Index basket
  console.log('\n── AI Index Basket (equal-weighted) ──');
  const basketMembers = aiTokens.filter(t => hlPrices[t.name] && t.etf && yahooPrices[t.etf]);
  if (basketMembers.length > 0) {
    let hlSum = 0, ySum = 0;
    for (const t of basketMembers) {
      hlSum += hlPrices[t.name];
      ySum += yahooPrices[t.etf];
    }
    const hlIndex = hlSum / basketMembers.length;
    const yIndex = ySum / basketMembers.length;
    const indexSpread = ((hlIndex - yIndex) / yIndex) * 100;
    console.log(`  Basket size: ${basketMembers.length} tokens`);
    console.log(`  HL basket price: $${hlIndex.toFixed(4)}`);
    console.log(`  Yahoo basket price: $${yIndex.toFixed(4)}`);
    console.log(`  Basket spread: ${indexSpread.toFixed(3)}%`);
  }

  // 6. AI ETF prices for comparison
  console.log('\n── AI ETF Prices (Yahoo) ──');
  const aiEtfs = ['BOTZ', 'IRBO', 'ARKQ', 'IGPT', 'CHAT', 'WISE'];
  for (const sym of aiEtfs) {
    const px = await getYahooPrice(sym);
    if (px) {
      console.log(`  ${sym.padEnd(8)} $${px.toFixed(4)}`);
    }
  }

  console.log('\n=== Verdict ===');
  if (spreads.length > 0) {
    const maxSpread = Math.max(...spreads.map(s => Math.abs(s.spreadPct)));
    const arbCount = arbs.length;
    console.log(`Scanned ${spreads.length} AI tokens, found ${arbCount} arb opportunities`);
    console.log(`Max spread: ${maxSpread.toFixed(3)}%`);
    if (maxSpread > 1) {
      console.log('  → actionable: deploy VOOI price spread executor');
    } else {
      console.log('  → no actionable arbs — HL tracking stocks efficiently');
    }
  } else {
    console.log('  No comparable HL perp + Yahoo stock pairs found');
    console.log('  Most AI tokens on HL are native crypto (NEAR, WLD, ENA), not stocks');
  }
}

main().catch(console.error);
