async function main() {
  console.log('── HL Position Sizing Calculator ──\n');
  
  const accountValue = 100000; // $100k
  const riskPerTrade = 0.02; // 2% per trade
  const maxRisk = accountValue * riskPerTrade;
  
  console.log(`Account: $${accountValue.toLocaleString()}`);
  console.log(`Max risk per trade: 2% = $${maxRisk.toLocaleString()}`);
  console.log('');
  
  const scenarios = [
    { coin: 'BTC', price: 83800, stopLoss: 0.02, maxLev: 40 },
    { coin: 'ETH', price: 2555, stopLoss: 0.03, maxLev: 25 },
    { coin: 'SOL', price: 113, stopLoss: 0.04, maxLev: 20 },
    { coin: 'HYPE', price: 87, stopLoss: 0.05, maxLev: 10 },
    { coin: 'W', price: 0.03, stopLoss: 0.10, maxLev: 5 },
  ];
  
  console.log('Coin     | Price $   | Stop Loss | Max Position | Size (units)  | Margin Needed | Leverage');
  console.log('─────────|───────────|───────────|──────────────|───────────────|───────────────|─────────');
  for (const s of scenarios) {
    const stopLossUsd = s.price * s.stopLoss;
    const maxSize = maxRisk / s.stopLoss;
    const size = maxSize / s.price;
    const margin = maxSize / s.maxLev;
    const lev = maxSize / accountValue * 100;
    console.log(`${s.coin.padEnd(9)}| $${s.price.toFixed(2).padStart(9)}| ${(s.stopLoss*100).toFixed(0).padStart(9)}%| $${maxSize.toFixed(0).padStart(12)}| ${size.toFixed(6).padStart(13)}| $${margin.toFixed(0).padStart(13)}| ${lev.toFixed(1)}% of account`);
  }
  
  console.log('\n── Risk-Adjusted Allocation ──\n');
  console.log('  Conservative: 5% per position × 10 positions = 50% deployed');
  console.log('  Moderate: 10% per position × 5 positions = 50% deployed');
  console.log('  Aggressive: 20% per position × 3 positions = 60% deployed');
  console.log('');
  console.log('  Our enterprise risk manager limits:');
  console.log('    Max position: $25k (25% of $100k)');
  console.log('    Max total exposure: $100k');
  console.log('    Max daily drawdown: 5%');
  console.log('    Max weekly drawdown: 10%');
}
main();
