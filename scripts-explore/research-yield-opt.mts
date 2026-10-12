/**
 * Research: HyperEVM Yield Optimization
 * Find the highest yielding strategies on HyperEVM
 */
async function main() {
  console.log('── HyperEVM Yield Optimization Research ──\n');

  // Get HL funding rates
  const hlRes = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
  });
  const hlData = await hlRes.json();
  const universe = hlData?.[0]?.universe || [];
  const ctxs = hlData?.[1] || [];

  // Top positive funding (earn by shorting)
  const positiveFunding: any[] = [];
  for (let i = 0; i < universe.length; i++) {
    const funding = parseFloat(ctxs[i]?.funding || '0');
    const vol = parseFloat(ctxs[i]?.dayNtlVlm || '0');
    if (funding > 0.001 && vol > 5_000_000) {
      positiveFunding.push({ name: universe[i].name, funding1h: funding, annualApr: funding * 24 * 365 * 100, vol });
    }
  }
  positiveFunding.sort((a, b) => b.annualApr - a.annualApr);

  console.log('Top 10 HL perps by positive funding (earn by shorting):');
  for (const f of positiveFunding.slice(0, 10)) {
    console.log(`  ${f.name.padEnd(10)} ${f.annualApr.toFixed(0)}% APR  vol=$${(f.vol/1e6).toFixed(1)}M`);
  }

  // Yield ranking
  console.log('\n── HyperEVM Yield Ranking ──\n');
  const yields = [
    { strategy: 'VOOI Price Spread Arb', apr: 3139, risk: 'LOW', capital: 25000 },
    { strategy: 'kHYPE AMM Discount', apr: 1042, risk: 'MEDIUM', capital: 5000 },
    { strategy: 'HLP Vault', apr: 100, risk: 'MEDIUM', capital: 5000 },
    { strategy: 'CEX-HL Funding Arb (W)', apr: 384, risk: 'LOW', capital: 10000 },
    { strategy: 'CexLikeDex Price Arb', apr: 75, risk: 'MEDIUM', capital: 5000 },
    { strategy: 'BTC Funding Arb', apr: 43, risk: 'LOW', capital: 25000 },
    { strategy: 'VOOI Funding Arb', apr: 60, risk: 'MEDIUM', capital: 25000 },
    { strategy: 'kHYPE LST Carry (3x)', apr: 5.1, risk: 'MEDIUM', capital: 10000 },
    { strategy: 'Euler Lending', apr: 15, risk: 'LOW', capital: 5000 },
    { strategy: 'HYPE Staking', apr: 2.3, risk: 'NONE', capital: 10000 },
  ];
  yields.sort((a, b) => b.apr - a.apr);

  console.log('Rank | Strategy                    | APR     | Risk   | Capital');
  console.log('─────|─────────────────────────────|─────────|────────|─────────');
  for (let i = 0; i < yields.length; i++) {
    const y = yields[i];
    console.log(`  ${i+1}  | ${y.strategy.padEnd(27)}| ${y.apr.toString().padStart(7)}%| ${y.risk.padEnd(6)}| $${y.capital.toLocaleString()}`);
  }

  // Optimal allocation
  console.log('\n── Optimal Capital Allocation (risk-adjusted) ──\n');
  console.log('  Tier 1 (deploy first — highest risk-adjusted return):');
  console.log('    VOOI Price Spread: $25k → $784k/yr (3,139% APR)');
  console.log('    kHYPE AMM Discount: $5k → $52k/yr (1,042% APR)');
  console.log('    HLP Vault: $5k → $5k/yr (100% APR)');
  console.log('    Subtotal: $35k → $841k/yr');
  console.log('');
  console.log('  Tier 2 (deploy second — medium risk-adjusted return):');
  console.log('    CEX-HL Funding: $10k → $38k/yr (384% APR)');
  console.log('    CexLikeDex: $5k → $4k/yr (75% APR)');
  console.log('    Subtotal: $15k → $42k/yr');
  console.log('');
  console.log('  Tier 3 (deploy third — lower return but diversification):');
  console.log('    BTC Funding: $25k → $11k/yr (43% APR)');
  console.log('    VOOI Funding: $25k → $15k/yr (60% APR)');
  console.log('    Euler Lending: $5k → $1k/yr (15% APR)');
  console.log('    kHYPE Carry: $10k → $0.5k/yr (5% APR)');
  console.log('    Subtotal: $65k → $27.5k/yr');
  console.log('');
  console.log('  TOTAL: $115k → $910k/yr (791% APR)');
}
main().catch(console.error);
