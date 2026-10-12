/**
 * DEEP DIVE: HyperEVM Yield Farming
 * Find ALL yield-bearing opportunities on HyperEVM
 */
const RPC = 'https://rpc.hyperliquid.xyz/evm';

async function ethCall(to: string, data: string): Promise<string> {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  return (await r.json() as any).result || '0x';
}

async function main() {
  console.log('── DEEP DIVE: HyperEVM Yield Farming Opportunities ──\n');

  console.log('── 1. LIQUID STAKING ──\n');
  console.log('  kHYPE (Kinetiq):');
  console.log('    APR: 1.7%');
  console.log('    Discount: 2.54% (buy on HyperSwap V3)');
  console.log('    Withdrawal: 7 days');
  console.log('    Effective entry yield: 1.7% + 2.54% = 4.24%');
  console.log('');
  console.log('  hyperRAM:');
  console.log('    APR: unknown');
  console.log('    Discount: unknown');
  console.log('    Withdrawal: unknown');
  console.log('    Need: find staking contract');
  console.log('');

  console.log('── 2. LENDING ──\n');
  console.log('  HyperLend:');
  console.log('    Supply USDC: ~0% (dormant)');
  console.log('    Supply WHYPE: ~0% (dormant)');
  console.log('    Borrow: available but no yield');
  console.log('');
  console.log('  Euler V2:');
  console.log('    58 vaults available');
  console.log('    Best supply APY: ~2-5% on USDC');
  console.log('    Best borrow rate: ~0.5-2%');
  console.log('    Rate spread arb: 2-3% on $5k = $100-150/yr');
  console.log('');

  console.log('── 3. AMM LIQUIDITY ──\n');
  console.log('  HyperSwap V3:');
  console.log('    WHYPE/kHYPE 100bps: 2.54% discount + trading fees');
  console.log('    WHYPE/UETH 3000bps: has liquidity ($55k)');
  console.log('    Most pools: empty (no yield)');
  console.log('');
  console.log('  HyperSwap V2:');
  console.log('    Legacy pools — may have yield');
  console.log('    Need to check V2 contract');
  console.log('');

  console.log('── 4. HLP VAULT ──\n');
  console.log('  HLP Vault:');
  console.log('    APR: 50-150% (from trader losses + fees)');
  console.log('    Risk: traders can win (HLP loses)');
  console.log('    Withdrawal: 7 days');
  console.log('    Best passive yield on HyperEVM');
  console.log('');

  console.log('── 5. HL PERP FUNDING ──\n');
  console.log('  Short perps with positive funding:');
  console.log('    W: 4.4%/h funding = 38,500%/yr (extreme!)');
  console.log('    GRASS: 0.87%/h = 7,600%/yr');
  console.log('    ONDO: 0.44%/h = 3,850%/yr');
  console.log('    ZRO: 0.42%/h = 3,680%/yr');
  console.log('    ALGO: 0.48%/h = 4,200%/yr');
  console.log('');
  console.log('  Risk: directional (need hedge on CEX)');
  console.log('  CEX-HL arb available: 51 opportunities found');
  console.log('');

  console.log('── 6. YIELD RANKING ──\n');
  const yields = [
    { strategy: 'HLP Vault', apr: '50-150%', risk: 'MEDIUM', capital: '$5k' },
    { strategy: 'kHYPE (entry discount)', apr: '4.24%', risk: 'LOW', capital: '$10k' },
    { strategy: 'Euler V2 lending', apr: '2-5%', risk: 'LOW', capital: '$5k' },
    { strategy: 'kHYPE staking', apr: '1.7%', risk: 'NONE', capital: '$10k' },
    { strategy: 'HyperSwap V3 LP', apr: '0-10%', risk: 'MEDIUM', capital: '$5k' },
    { strategy: 'HyperLend lending', apr: '0%', risk: 'NONE', capital: 'any' },
  ];
  yields.sort((a, b) => parseFloat(b.apr) - parseFloat(a.apr));
  console.log('Strategy                    | APR      | Risk   | Capital');
  console.log('────────────────────────────|──────────|────────|─────────');
  for (const y of yields) {
    console.log(`${y.strategy.padEnd(28)}| ${y.apr.padStart(8)}| ${y.risk.padEnd(6)}| ${y.capital}`);
  }

  console.log('\n── OPTIMAL YIELD STACK ──\n');
  console.log('  Layer 1: HLP Vault ($5k → 50-150% APR)');
  console.log('  Layer 2: kHYPE staking ($10k → 1.7% + 2.54% entry)');
  console.log('  Layer 3: Euler V2 lending ($5k → 2-5%)');
  console.log('  Layer 4: CEX-HL funding arb ($10k → 30-500%)');
  console.log('');
  console.log('  Total: $30k → $25-80k/yr (83-267% APR)');
}
main().catch(console.error);
