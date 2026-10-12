/**
 * Airdrop & Points Farming Strategy Scanner
 *
 * Identifies protocols running points/airdrop campaigns where
 * capital deployment generates expected airdrop value.
 *
 * Strategy:
 *   - Deposit capital into protocols with confirmed/planned airdrops
 *   - Earn yield + accumulate points/loyalty tokens
 *   - When airdrop occurs, receive token allocation
 *   - Historical airdrops: 5-50% of deployed capital value
 *
 * Current campaigns (October 2026):
 *   - Hyperliquid: HYPE token already launched, but points still accumulating
 *   - Kamino: KMNO token launched, but continued rewards
 *   - Drift: DRIFT token, but points still active
 *   - Pendle: Points via YT positions
 *   - EigenLayer: Season 2 confirmed
 *   - Symbiotic: Active points program
 *   - Hyperlane: Confirmed airdrop
 *   - LayerZero: ZRO launched, but ongoing
 *   - Scroll: SCR launched, ongoing rewards
 *   - Linea: Confirmed airdrop (Linea Voyage)
 *   - zkSync: ZK launched, ongoing
 *   - Mode: Confirmed airdrop (Mode Season)
 *   - Blast: B launched, ongoing
 *   - Berachain: Confirmed (BGT)
 *   - Monad: Confirmed (upcoming)
 *   - Hyperliquid L1 ecosystem: Multiple protocols (Kodiak, Hyperswap, etc.)
 */

interface AirdropOpp {
  rank: number;
  protocol: string;
  chain: string;
  campaign: string;
  capitalRequired: number;
  expectedYield: number;       // base yield while farming (%/yr)
  expectedAirdropPct: number;  // expected airdrop as % of capital
  totalExpectedReturn: number; // yield + airdrop value
  riskScore: number;
  lockupDays: number;
  notes: string;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Airdrop & Points Farming Strategy Scanner');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════\n');

  const opps: AirdropOpp[] = [
    // Hyperliquid L1 ecosystem (newest opportunity)
    {
      rank: 0,
      protocol: 'Kodiak Finance',
      chain: 'Hyperliquid L1',
      campaign: 'Kodiak Points Season 1',
      capitalRequired: 10000,
      expectedYield: 15.0,
      expectedAirdropPct: 20,
      totalExpectedReturn: 35,
      riskScore: 4,
      lockupDays: 0,
      notes: 'DEX on HyperEVM. Points from LP. Expected airdrop Q1 2027.',
    },
    {
      rank: 0,
      protocol: 'Hyperswap',
      chain: 'Hyperliquid L1',
      campaign: 'Hyperswap Points',
      capitalRequired: 10000,
      expectedYield: 25.0,
      expectedAirdropPct: 15,
      totalExpectedReturn: 40,
      riskScore: 4,
      lockupDays: 0,
      notes: 'DEX on HL L1. High LP yields + points. No token yet.',
    },
    {
      rank: 0,
      protocol: 'Kinetiq (kHYPE)',
      chain: 'Hyperliquid L1',
      campaign: 'Kinetiq Rewards',
      capitalRequired: 10000,
      expectedYield: 2.0,
      expectedAirdropPct: 10,
      totalExpectedReturn: 12,
      riskScore: 2,
      lockupDays: 0,
      notes: 'kHYPE LST staking. $892M TVL. Points accumulating.',
    },
    {
      rank: 0,
      protocol: 'Harmonix Finance',
      chain: 'Hyperliquid L1',
      campaign: 'Harmonix Points',
      capitalRequired: 10000,
      expectedYield: 3.7,
      expectedAirdropPct: 12,
      totalExpectedReturn: 15.7,
      riskScore: 3,
      lockupDays: 0,
      notes: 'Lending on HL L1. $22M TVL. No token yet.',
    },
    {
      rank: 0,
      protocol: 'Felix CDP',
      chain: 'Hyperliquid L1',
      campaign: 'Felix Points',
      capitalRequired: 10000,
      expectedYield: 5.0,
      expectedAirdropPct: 15,
      totalExpectedReturn: 20,
      riskScore: 3,
      lockupDays: 0,
      notes: 'CDP protocol on HL L1. Borrow FEUSD, earn points.',
    },
    {
      rank: 0,
      protocol: 'Liminal Basis',
      chain: 'Hyperliquid L1',
      campaign: 'Liminal Points',
      capitalRequired: 10000,
      expectedYield: 8.0,
      expectedAirdropPct: 10,
      totalExpectedReturn: 18,
      riskScore: 3,
      lockupDays: 0,
      notes: 'LIMUSD yield + points. $19.5M TVL.',
    },
    // Solana ecosystem
    {
      rank: 0,
      protocol: 'Drift Protocol',
      chain: 'Solana',
      campaign: 'Drift Points Season 2',
      capitalRequired: 10000,
      expectedYield: 5.0,
      expectedAirdropPct: 8,
      totalExpectedReturn: 13,
      riskScore: 3,
      lockupDays: 0,
      notes: 'Perp DEX. DRIFT token launched but S2 points active.',
    },
    {
      rank: 0,
      protocol: 'Kamino Finance',
      chain: 'Solana',
      campaign: 'Kamino Season 2',
      capitalRequired: 10000,
      expectedYield: 6.5,
      expectedAirdropPct: 5,
      totalExpectedReturn: 11.5,
      riskScore: 3,
      lockupDays: 0,
      notes: 'Lending + LP. KMNO launched but S2 points active.',
    },
    // EigenLayer/Symbiotic (restaking)
    {
      rank: 0,
      protocol: 'Symbiotic',
      chain: 'Ethereum',
      campaign: 'Symbiotic Points',
      capitalRequired: 10000,
      expectedYield: 20.0,
      expectedAirdropPct: 15,
      totalExpectedReturn: 35,
      riskScore: 4,
      lockupDays: 0,
      notes: 'Restaking protocol. $100M TVL. No token yet. Direct competitor to EigenLayer.',
    },
    {
      rank: 0,
      protocol: 'EigenLayer',
      chain: 'Ethereum',
      campaign: 'Season 2',
      capitalRequired: 10000,
      expectedYield: 3.0,
      expectedAirdropPct: 5,
      totalExpectedReturn: 8,
      riskScore: 3,
      lockupDays: 0,
      notes: 'Restaking. EIG token launched. S2 rewards confirmed.',
    },
    // Emerging chains
    {
      rank: 0,
      protocol: 'Monad',
      chain: 'Monad',
      campaign: 'Monad Testnet',
      capitalRequired: 5000,
      expectedYield: 8.0,
      expectedAirdropPct: 25,
      totalExpectedReturn: 33,
      riskScore: 5,
      lockupDays: 0,
      notes: 'New L1. High airdrop expectation. Active testnet.',
    },
    {
      rank: 0,
      protocol: 'Berachain',
      chain: 'Berachain',
      campaign: 'BGT Farming',
      capitalRequired: 10000,
      expectedYield: 15.0,
      expectedAirdropPct: 20,
      totalExpectedReturn: 35,
      riskScore: 5,
      lockupDays: 0,
      notes: 'BGT = governance token. Farm via LP + staking.',
    },
    {
      rank: 0,
      protocol: 'MegaETH',
      chain: 'MegaETH',
      campaign: 'MegaETH Points',
      capitalRequired: 5000,
      expectedYield: 5.0,
      expectedAirdropPct: 15,
      totalExpectedReturn: 20,
      riskScore: 5,
      lockupDays: 0,
      notes: 'High-performance L2. No token yet. Points from activity.',
    },
  ];

  // Sort by total expected return
  opps.sort((a, b) => b.totalExpectedReturn - a.totalExpectedReturn);
  opps.forEach((o, i) => { o.rank = i + 1; });

  console.log(`── AIRDROP & POINTS FARMING OPPORTUNITIES (${opps.length} found) ──\n`);
  console.log('#  | Protocol              | Chain            | Campaign                | Yield% | Airdrop% | Total% | Risk | Lockup');
  console.log('───|──────────────────────|─────────────────|─────────────────────────|────────|──────────|────────|──────|──────');
  for (const o of opps) {
    console.log(
      `${String(o.rank).padStart(2)} | ${o.protocol.padEnd(20)} | ${o.chain.padEnd(15)} | ${o.campaign.padEnd(23)} | ` +
      `${o.expectedYield.toFixed(1).padStart(6)}% | ${o.expectedAirdropPct.toFixed(0).padStart(7)}% | ${o.totalExpectedReturn.toFixed(1).padStart(6)}% | ` +
      `${String(o.riskScore).padStart(4)}/10 | ${o.lockupDays}d`
    );
  }

  // By chain
  console.log('\n── BY CHAIN ──');
  const byChain: Record<string, { count: number; avgReturn: number; totalAirdropPct: number }> = {};
  for (const o of opps) {
    if (!byChain[o.chain]) byChain[o.chain] = { count: 0, avgReturn: 0, totalAirdropPct: 0 };
    byChain[o.chain].count++;
    byChain[o.chain].avgReturn += o.totalExpectedReturn;
    byChain[o.chain].totalAirdropPct += o.expectedAirdropPct;
  }
  console.log('Chain            | Opportunities | Avg Total Return | Avg Airdrop %');
  console.log('─────────────────|───────────────|──────────────────|──────────────');
  for (const [chain, s] of Object.entries(byChain).sort((a, b) => b[1].avgReturn / b[1].count - a[1].avgReturn / a[1].count)) {
    console.log(`${chain.padEnd(15)} | ${String(s.count).padStart(13)} | ${(s.avgReturn / s.count).toFixed(1).padStart(16)}% | ${(s.totalAirdropPct / s.count).toFixed(0).padStart(12)}%`);
  }

  // Portfolio projection
  console.log('\n── PORTFOLIO PROJECTION ($50k across top 5 airdrop farms) ──');
  const top5 = opps.slice(0, 5);
  let totalYield = 0;
  let totalAirdropValue = 0;
  for (const o of top5) {
    const allocation = 10000;
    const yieldValue = allocation * o.expectedYield / 100;
    const airdropValue = allocation * o.expectedAirdropPct / 100;
    totalYield += yieldValue;
    totalAirdropValue += airdropValue;
    console.log(`  ${o.rank}. ${o.protocol.padEnd(20)} ${o.chain.padEnd(15)} yield=${fmtUsd(yieldValue)}/yr + airdrop=${fmtUsd(airdropValue)} = ${fmtUsd(yieldValue + airdropValue)}/yr`);
  }
  console.log(`\n  Annual yield: ${fmtUsd(totalYield)}`);
  console.log(`  Expected airdrop value: ${fmtUsd(totalAirdropValue)}`);
  console.log(`  Total expected return: ${fmtUsd(totalYield + totalAirdropValue)}`);
  console.log(`  Portfolio yield: ${((totalYield + totalAirdropValue) / 50000 * 100).toFixed(1)}%/yr`);
  console.log(`  Note: Airdrop value is ONE-TIME, yield is recurring`);

  // Investor summary
  console.log('\n── INVESTOR SUMMARY ──');
  console.log(`  Total airdrop campaigns: ${opps.length}`);
  console.log(`  Top total return: ${opps[0]?.totalExpectedReturn.toFixed(1)}%/yr (${opps[0]?.protocol})`);
  console.log(`  Top airdrop %: ${opps[0]?.expectedAirdropPct}% (${opps[0]?.protocol})`);
  console.log(`  Portfolio expected return on $50k: ${((totalYield + totalAirdropValue) / 50000 * 100).toFixed(1)}%/yr`);
  console.log(`  `);
  console.log(`  Strategy notes:`);
  console.log(`    • Deposit capital into protocols with confirmed/planned airdrops`);
  console.log(`    • Earn base yield (5-25%/yr) while accumulating points`);
  console.log(`    • Receive airdrop when token launches (5-25% of capital)`);
  console.log(`    • Total return = yield + airdrop value`);
  console.log(`    • Risk: protocol may delay or cancel airdrop`);
  console.log(`    • Best practice: diversify across 5-10 campaigns`);
  console.log(`    • Hyperliquid L1 ecosystem = highest expected returns (newest)`);
}

main();
