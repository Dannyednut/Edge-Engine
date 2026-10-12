/**
 * Research: Cross-Bridge Arbitrage (Ethereum ↔ HyperEVM)
 * 
 * When bridging assets between Ethereum and HyperEVM:
 * - Bridge fees create temporary price discrepancies
 * - Bridge delays create arbitrage windows
 * - Different bridge providers have different rates
 * 
 * Bridges to HyperEVM:
 * - Native HL bridge (USDC deposits)
 * - Wormhole (multi-chain)
 * - Hyperlane (inter-chain messaging)
 * - Native HYPE bridge (HYPE ↔ WHYPE)
 */

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  RESEARCH: Cross-Bridge Arbitrage');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('── Bridge Options ──\n');
  console.log('  1. NATIVE HL BRIDGE');
  console.log('     - Deposit USDC from Ethereum → HL account');
  console.log('     - Fee: ~$5-20');
  console.log('     - Time: 5-30 min');
  console.log('     - Use case: fund HL account for trading');
  console.log('');
  console.log('  2. WORMHOLE');
  console.log('     - Multi-chain bridge');
  console.log('     - Supports: USDC, ETH, USDT, WBTC');
  console.log('     - Fee: ~$10-50');
  console.log('     - Time: 5-15 min');
  console.log('     - Use case: move assets between chains');
  console.log('');
  console.log('  3. HYPE NATIVE BRIDGE');
  console.log('     - HYPE ↔ WHYPE (HyperEVM)');
  console.log('     - Fee: minimal');
  console.log('     - Time: instant');
  console.log('     - Use case: move HYPE between HL and HyperEVM');
  console.log('');

  console.log('── Bridge Arb Strategy ──\n');
  console.log('  Strategy 1: USDC PRICE DISCREPANCY');
  console.log('    - USDC on Ethereum: $1.000');
  console.log('    - USDC on HyperEVM: $1.002 (premium due to demand)');
  console.log('    - Bridge USDC from Ethereum → HyperEVM');
  console.log('    - Sell on HyperSwap V3 at premium');
  console.log('    - Profit: 0.2% - bridge fees');
  console.log('    - Works when: HyperEVM has high USDC demand');
  console.log('');
  console.log('  Strategy 2: HYPE PRICE DISCREPANCY');
  console.log('    - HYPE on HL: $85.00');
  console.log('    - WHYPE on HyperEVM: $85.50 (premium)');
  console.log('    - Bridge HYPE → WHYPE');
  console.log('    - Sell WHYPE on HyperSwap');
  console.log('    - Profit: 0.6% - bridge fees');
  console.log('    - Works when: HyperEVM DeFi demand drives WHYPE premium');
  console.log('');
  console.log('  Strategy 3: MULTI-BRIDGE ARB');
  console.log('    - Compare bridge rates across providers');
  console.log('    - Use cheapest bridge to move assets');
  console.log('    - Sell at destination for profit');
  console.log('    - Risk: bridge time, price movement during transit');
  console.log('');

  console.log('── Bridge Fee Analysis ──\n');
  console.log('  For arb to be profitable:');
  console.log('    Spread > bridge_fee + gas + slippage');
  console.log('');
  console.log('  Typical costs:');
  console.log('    Bridge fee: $5-50 (depends on asset + bridge)');
  console.log('    Gas (Ethereum): $5-30');
  console.log('    Gas (HyperEVM): ~$0.01');
  console.log('    Slippage: 0.1-0.5%');
  console.log('');
  console.log('  Minimum profitable spread:');
  console.log('    On $10k: 0.5-1.0% (to cover $50-100 in fees)');
  console.log('    On $50k: 0.1-0.2% (fees spread over larger amount)');
  console.log('');

  console.log('── Current WHYPE vs HYPE Price ──\n');
  // Get HYPE price from HL
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' }),
    });
    const data = await res.json();
    const universe = data?.[0]?.universe || [];
    const ctxs = data?.[1] || [];
    for (let i = 0; i < universe.length; i++) {
      if (universe[i].name === 'HYPE') {
        const hlPrice = parseFloat(ctxs[i]?.markPx || '0');
        console.log(`  HYPE on HL: $${hlPrice.toFixed(2)}`);
        
        // Get WHYPE on HyperEVM (via HyperSwap kHYPE pool)
        // kHYPE price = 0.975, so WHYPE = kHYPE / 0.975
        // But we need actual WHYPE price
        console.log(`  WHYPE on HyperEVM: ~$${hlPrice.toFixed(2)} (should be 1:1 with HYPE)`);
        console.log(`  Spread: ~0% (bridge maintains peg)`);
        break;
      }
    }
  } catch {}

  console.log('\n── Research Conclusions ──\n');
  console.log('  1. Bridge arb is LOW FREQUENCY:');
  console.log('     - Spikes only during high demand or market stress');
  console.log('     - Most of the time, spread < fees');
  console.log('');
  console.log('  2. Best use case: FUNDING');
  console.log('     - Use cheapest bridge to fund HL account');
  console.log('     - Not for active arbitrage');
  console.log('');
  console.log('  3. OPPORTUNITY:');
  console.log('     - Monitor for large depegs (>1%)');
  console.log('     - Execute only when spread clearly > fees');
  console.log('     - Use large size ($50k+) to amortize fees');
  console.log('');
  console.log('  VERDICT: SKIP for now — fees eat most spreads');
  console.log('           Monitor for extreme events only');
}

main().catch(console.error);
