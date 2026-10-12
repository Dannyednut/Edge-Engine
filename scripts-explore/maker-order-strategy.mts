async function main() {
  console.log('── HL Maker Order Strategy ──\n');
  
  console.log('Fee Schedule (from userFees):');
  console.log('  Perp maker: 1.5 bps (0.015%)');
  console.log('  Perp taker: 4.5 bps (0.045%)');
  console.log('  Spot maker: 4 bps (0.04%)');
  console.log('  Spot taker: 7 bps (0.07%)');
  console.log('');
  console.log('Builder code rebate: 10 bps (0.1%)');
  console.log('');
  
  console.log('── Maker Order Revenue ──\n');
  const scenarios = [
    { name: 'Conservative', trades: 5, size: 5000 },
    { name: 'Moderate', trades: 15, size: 5000 },
    { name: 'Active', trades: 30, size: 5000 },
    { name: 'High volume', trades: 50, size: 10000 },
  ];
  
  console.log('Scenario           | Trades/day | Size  | Daily Volume | Maker Fee | Builder Rebate | NET Profit');
  console.log('──────────────────|────────────|───────|──────────────|───────────|────────────────|───────────');
  for (const s of scenarios) {
    const dailyVol = s.trades * s.size;
    const makerFee = dailyVol * 0.00015; // 1.5 bps
    const rebate = dailyVol * 0.001; // 10 bps
    const net = rebate - makerFee;
    console.log(`${s.name.padEnd(18)}| ${s.trades.toString().padStart(10)}| $${s.size.toLocaleString().padStart(5)}| $${dailyVol.toLocaleString().padStart(12)}| $${makerFee.toFixed(2).padStart(9)}| $${rebate.toFixed(2).padStart(14)}| +$${net.toFixed(2)}`);
  }
  
  console.log('\n── Key Insight ──\n');
  console.log('  Builder code rebate (10 bps) > Maker fee (1.5 bps)');
  console.log('  Net: +8.5 bps per trade = PURE PROFIT');
  console.log('');
  console.log('  If ALL trades are maker orders:');
  console.log('    15 trades/day × $5k × 8.5 bps = $63.75/day');
  console.log('    Annual: $23,269/yr');
  console.log('');
  console.log('  This is BEFORE any arb profit!');
  console.log('  Arb profit + fee profit = double revenue');
  console.log('');
  console.log('── Strategy ──\n');
  console.log('  1. Always place LIMIT orders (maker)');
  console.log('  2. NEVER use market orders (taker)');
  console.log('  3. Include builder code in every order');
  console.log('  4. Place orders at mid-price ± 1 tick');
  console.log('  5. Wait for fill (may take seconds to minutes)');
  console.log('  6. Earn 8.5 bps per trade from fee differential');
  console.log('');
  console.log('  For VOOI arb:');
  console.log('    VOOI handles atomic execution (instant)');
  console.log('    But for HL direct orders: always use maker');
  console.log('    For CEX-HL funding arb: maker on HL, any on CEX');
}
main();
