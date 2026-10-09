// Explore HYPE staking + delegation + builder codes integration
//
// HYPE token has multiple uses:
//   1. Stake for validation (2.3% APR)
//   2. Stake via LST (kHYPE 1.7%, stHYPE 2.0%, beHYPE 2.1%)
//   3. Use as collateral for perps
//   4. Pay for HIP-1 token deployment
//   5. Builder code staking (NEW — earn from builder fees)
//
// This exploration checks each use case + identifies best yield stacking

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
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HYPE Token Yield Stack Comparison');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Get current HYPE price
  const meta = await hlInfo({ type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' });
  const universe = meta[0].universe || [];
  const ctxs = meta[1] || [];
  let hypePrice = 0;
  for (let i = 0; i < universe.length; i++) {
    if (universe[i].name === 'HYPE') {
      hypePrice = parseFloat(ctxs[i]?.markPx || '0');
      break;
    }
  }
  console.log(`  Current HYPE price: $${hypePrice.toFixed(4)}\n`);

  // 2. Compare all yield options
  console.log('── HYPE Yield Options ──');
  const options = [
    {
      name: 'Direct HYPE staking',
      apr: 0.023, // 2.3%
      lockup: 'None (instant unstake)',
      risk: 'Low (validator slashing risk)',
      minCapital: 'None',
      notes: 'Native staking via HL UI',
    },
    {
      name: 'kHYPE LST (Kinetiq)',
      apr: 0.017, // 1.7%
      lockup: '7-day withdrawal',
      risk: 'Low (LST smart contract risk)',
      minCapital: 'None',
      notes: 'LST — can be used as collateral',
    },
    {
      name: 'stHYPE LST',
      apr: 0.020, // 2.0%
      lockup: '7-day withdrawal',
      risk: 'Low (LST smart contract risk)',
      minCapital: 'None',
      notes: 'LST — can be used as collateral',
    },
    {
      name: 'beHYPE LST',
      apr: 0.021, // 2.1%
      lockup: '7-day withdrawal',
      risk: 'Low (LST smart contract risk)',
      minCapital: 'None',
      notes: 'LST — can be used as collateral',
    },
    {
      name: 'HYPE perp MM (maker)',
      apr: 0.10, // ~10% (variable)
      lockup: 'None',
      risk: 'HIGH (inventory risk)',
      minCapital: '$10k+',
      notes: 'Active MM on HYPE perp — capture maker fees',
    },
    {
      name: 'HYPE-USDCL HyperSwap V3 LP',
      apr: 0.08, // ~8% (variable)
      lockup: 'None',
      risk: 'Medium (impermanent loss)',
      minCapital: '$1k+',
      notes: 'Provide liquidity on HyperSwap V3',
    },
    {
      name: 'HYPE borrow + re-stake (3x lev)',
      apr: 0.051, // 3x * (1.7% - 0%)
      lockup: '7-day withdrawal on LST',
      risk: 'Medium (liquidation if HYPE drops 30%+)',
      minCapital: '$5k+',
      notes: 'Borrow HYPE on HyperLend, stake as kHYPE',
    },
    {
      name: 'HYPE as perp collateral',
      apr: 0, // No direct yield, just collateral
      lockup: 'None',
      risk: 'None (collateral)',
      minCapital: '$1k+',
      notes: 'Use HYPE to back perp trades (no yield but enables leverage)',
    },
    {
      name: 'Builder code (10 bps fee)',
      apr: 0.001 * 365 * 5_000_000_000 / 100_000, // 0.1% * $5B/day * 365 / $100k
      lockup: 'None',
      risk: 'None',
      minCapital: '$100 (registration)',
      notes: 'Earn 0.1% of trade volume routed via our builder code',
    },
  ];

  // Sort by APR descending
  options.sort((a, b) => b.apr - a.apr);

  console.log('Option                                | APR    | Lockup     | Risk     | Notes');
  console.log('──────────────────────────────────────|────────|────────────|──────────|─────────────────────────');
  for (const o of options) {
    console.log(`${o.name.padEnd(38)}| ${(o.apr*100).toFixed(2).padStart(5)}% | ${o.lockup.padEnd(10)} | ${o.risk.substring(0,8).padEnd(8)} | ${o.notes}`);
  }

  // 3. Capital allocation recommendation
  console.log('\n── Capital Allocation Recommendation ──');
  console.log('  For $25k HYPE position:');
  console.log('');
  console.log('  Tier 1 (SAFE - 50% = $12.5k):');
  console.log('    - Direct HYPE staking: $5,000 (2.3% APR = $115/yr)');
  console.log('    - beHYPE LST: $7,500 (2.1% APR = $158/yr)');
  console.log('    Subtotal: $273/yr (2.2% blended)');
  console.log('');
  console.log('  Tier 2 (MEDIUM - 30% = $7.5k):');
  console.log('    - HYPE-USDCL HyperSwap V3 LP: $5,000 (8% APR = $400/yr)');
  console.log('    - HYPE perp MM: $2,500 (10% APR = $250/yr)');
  console.log('    Subtotal: $650/yr (8.7% blended)');
  console.log('');
  console.log('  Tier 3 (HIGH - 20% = $5k):');
  console.log('    - Borrow + re-stake 3x lev: $5,000 (5.1% APR = $255/yr)');
  console.log('    Subtotal: $255/yr (5.1% blended)');
  console.log('');
  console.log('  TOTAL: $1,178/yr on $25k = 4.7% APR (diversified)');
  console.log('  vs. Single strategy (direct staking): $575/yr = 2.3% APR');
  console.log('  Diversification bonus: +$603/yr (+105%)');
  console.log('');

  // 4. Builder code stack (the most unique opportunity)
  console.log('── Builder Code Stack (NEW — most lucrative) ──');
  // If we deploy $100 USDC to register as builder
  // And route 0.1% of HL volume ($5M/day) via our builder code
  // At 10 bps fee = $5k/day revenue
  // Annual: $1.825M/yr on $100 capital = 1.8M% APR
  // But requires user acquisition (SDK, UI, marketing)
  const builderDailyVolume = 5_000_000; // $5M/day
  const builderFeeRate = 0.001; // 10 bps
  const builderDailyRev = builderDailyVolume * builderFeeRate;
  const builderAnnualRev = builderDailyRev * 365;
  console.log(`  Capital required: $100 (registration fee)`);
  console.log(`  Volume routed: $${(builderDailyVolume/1e6).toFixed(1)}M/day (0.1% of HL)`);
  console.log(`  Fee rate: ${builderFeeRate*100}% (${builderFeeRate*10000} bps)`);
  console.log(`  Daily revenue: $${builderDailyRev.toLocaleString()}`);
  console.log(`  Annual revenue: $${(builderAnnualRev/1e6).toFixed(2)}M`);
  console.log(`  APR on $100: ${(builderAnnualRev/100*100).toFixed(0)}%`);
  console.log('');
  console.log('  But: requires user acquisition infrastructure');
  console.log('    - SDK (4 weeks build)');
  console.log('    - Landing page (1 week)');
  console.log('    - Marketing (ongoing)');
  console.log('    - Customer support (ongoing)');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HYPE token yield stack options:');
  console.log('  - Passive: 2-5% APR (staking + LST)');
  console.log('  - Active: 5-10% APR (LP + MM)');
  console.log('  - Builder code: 1,000%+ APR (if we can acquire users)');
  console.log('');
  console.log('Recommendation:');
  console.log('  - For idle HYPE: Direct staking (2.3% APR, instant unstake)');
  console.log('  - For HYPE used as collateral: kHYPE LST (1.7% APR, 7-day delay)');
  console.log('  - For active yield: Builder code (HIGH effort, HIGH reward)');
  console.log('');
  console.log('ACTION: Builder code is the biggest opportunity');
  console.log('  Phase 1: Register builder code ($100, 1 day)');
  console.log('  Phase 2: Build SDK (4 weeks)');
  console.log('  Phase 3: Marketing + user acquisition (ongoing)');
}

main().catch(console.error);
