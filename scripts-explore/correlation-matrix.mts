const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Cross-Pair Correlation Matrix ──\n');
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  const ctxs = meta?.[1] || [];
  
  // Get 24h % change for top perps
  const top: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i].name || '';
    const markPx = parseFloat(ctxs[i]?.markPx || '0');
    const dayPct = parseFloat(ctxs[i]?.midDayPctChange || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (markPx > 0 && vol > 10_000_000) {
      top.push({ name, dayPct, vol });
    }
  }
  top.sort((a, b) => b.vol - a.vol);
  
  console.log('Top 15 perps by 24h change (correlation proxy):');
  console.log('Name       | 24h Change | Vol $M     | Category');
  console.log('───────────|────────────|────────────|──────────');
  const categories: Record<string, string> = {
    BTC: 'Crypto', ETH: 'Crypto', SOL: 'Crypto', XRP: 'Crypto', ADA: 'Crypto',
    AVAX: 'Crypto', DOT: 'Crypto', LINK: 'Crypto', DOGE: 'Crypto', LTC: 'Crypto',
    BCH: 'Crypto', BNB: 'Crypto', ATOM: 'Crypto', NEAR: 'Crypto', SUI: 'Crypto',
    HYPE: 'HL Native', W: 'AI', WLD: 'AI', TAO: 'AI',
    ZEC: 'Privacy', XMR: 'Privacy',
    PUMP: 'Meme',
  };
  for (const t of top.slice(0, 15)) {
    const cat = categories[t.name] || 'Other';
    const emoji = t.dayPct > 2 ? '🟢' : t.dayPct < -2 ? '🔴' : '⚪';
    console.log(`${t.name.padEnd(10)}| ${emoji}${t.dayPct.toFixed(2).padStart(8)}%| ${(t.vol/1e6).toFixed(1).padStart(10)}| ${cat}`);
  }
  
  console.log('\n  Correlation insights:');
  console.log('    - If correlated assets diverge → mean reversion arb');
  console.log('    - If uncorrelated assets both move → market-wide event');
  console.log('    - If one asset diverges from category → idiosyncratic move');
  console.log('');
  console.log('  Strategy: Long underperformer, short overperformer within same category');
  console.log('  Example: If BTC +3% but ETH -1% → long ETH, short BTC (expect convergence)');
}
main().catch(console.error);
