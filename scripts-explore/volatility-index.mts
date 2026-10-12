const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('── HL Volatility Index (24h ATR-based) ──\n');
  
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta?.[0]?.universe || [];
  
  const volData: any[] = [];
  
  for (let i = 0; i < Math.min(30, universe.length); i++) {
    const name = universe[i].name;
    try {
      const candles = await hlInfo({ type: 'candleSnapshot', req: { name: undefined, coin: name, interval: '1h', startTime: Date.now() - 24 * 60 * 60 * 1000 } });
      if (!Array.isArray(candles) || candles.length < 5) continue;
      
      const ranges = candles.map(c => (parseFloat(c.h) - parseFloat(c.l)) / parseFloat(c.o) * 100);
      const avgRange = ranges.reduce((s, x) => s + x, 0) / ranges.length;
      const maxRange = Math.max(...ranges);
      const vol = parseFloat(meta?.[1]?.[i]?.dayNtlVlm || '0');
      
      volData.push({ name, avgRange, maxRange, vol });
    } catch {}
  }
  
  volData.sort((a, b) => b.avgRange - a.avgRange);
  
  // Overall market volatility (weighted by volume)
  const totalVol = volData.reduce((s, x) => s + x.vol, 0);
  const weightedVol = volData.reduce((s, x) => s + x.avgRange * x.vol, 0) / totalVol;
  
  console.log(`Market Volatility Index: ${weightedVol.toFixed(2)}% (24h avg ATR)`);
  console.log(`  ${weightedVol > 3 ? '🔥 HIGH' : weightedVol > 1 ? '🟡 MEDIUM' : '🟢 LOW'}\n`);
  
  console.log('Most volatile (top 10):');
  console.log('Name     | Avg Range % | Max Range % | Vol $M');
  console.log('─────────|─────────────|─────────────|───────');
  for (const v of volData.slice(0, 10)) {
    console.log(`${v.name.padEnd(9)}| ${v.avgRange.toFixed(3).padStart(10)}%| ${v.maxRange.toFixed(3).padStart(10)}%| ${(v.vol/1e6).toFixed(1)}`);
  }
  
  console.log('\n  High volatility = more arb opportunities');
  console.log('  Low volatility = fewer arbs, tighter spreads');
}
main().catch(console.error);
