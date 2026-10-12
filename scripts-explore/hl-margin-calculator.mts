const HL_API = 'https://api.hyperliquid.xyz/info';
async function hlInfo(body: any) {
  const res = await fetch(HL_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}
async function main() {
  console.log('── HL Margin Calculator ──\n');
  const meta = await hlInfo({ type: 'meta' });
  const tables = meta?.marginTables || [];
  console.log(`Margin tables: ${tables.length}\n`);
  // Show margin requirements for top perps
  const topCoins = ['BTC', 'ETH', 'SOL', 'HYPE', 'W'];
  for (const coin of topCoins) {
    const idx = meta?.universe?.findIndex((u: any) => u.name === coin);
    if (idx >= 0) {
      const asset = meta.universe[idx];
      const maxLev = asset.maxLeverage;
      const initialMargin = 100 / maxLev;
      const maintMargin = initialMargin * 0.5; // approx
      console.log(`  ${coin.padEnd(6)} maxLev=${maxLev}x  initialMargin=${initialMargin.toFixed(2)}%  maintMargin=${maintMargin.toFixed(2)}%  szDecimals=${asset.szDecimals}`);
    }
  }
  console.log('\n  For $5k position at max leverage:');
  for (const coin of topCoins) {
    const idx = meta?.universe?.findIndex((u: any) => u.name === coin);
    if (idx < 0) continue;
    const maxLev = meta.universe[idx].maxLeverage;
    const notional = 5000 * maxLev;
    const margin = 5000;
    console.log(`    ${coin}: $${notional.toLocaleString()} notional with $${margin} margin (${maxLev}x)`);
  }
}
main().catch(console.error);
