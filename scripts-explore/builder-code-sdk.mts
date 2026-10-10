/**
 * Builder Code SDK Framework
 *
 * TypeScript SDK for other developers to route HL trades via our builder code.
 * We earn 0.1% (10 bps) of every trade routed through us.
 *
 * Usage for developers:
 *   import { placeOrder } from '@edge/builder-sdk';
 *   await placeOrder({ coin: 'BTC', isBuy: true, sz: 0.001, limitPx: '50000' });
 *   // Our builder code is automatically included — developer pays nothing extra
 *
 * Revenue model:
 *   - Developer pays same fees as normal (no extra cost)
 *   - HL pays us 0.1% of trade notional as builder rebate
 *   - Pure profit for us, zero cost for developer
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch {}

const BUILDER_ADDRESS = process.env.AGENT_EVM_ADDRESS || '0x7cE80c805d0d1Ed80fEBf779385389b00a81381A';
const BUILDER_FEE_BPS = 10; // 0.1% (max allowed)

/**
 * Get the builder field to include in HL order requests.
 * This is the core of the SDK — developers just include this in their orders.
 */
export function getBuilderField(): { b: string; f: number } {
  return {
    b: BUILDER_ADDRESS,
    f: BUILDER_FEE_BPS,
  };
}

/**
 * Calculate builder fee for a given trade size.
 */
export function calculateBuilderFee(tradeSizeUsd: number): number {
  return tradeSizeUsd * (BUILDER_FEE_BPS / 10000);
}

/**
 * Estimate annual builder fee revenue based on daily volume.
 */
export function estimateAnnualRevenue(dailyVolumeUsd: number): number {
  return dailyVolumeUsd * (BUILDER_FEE_BPS / 10000) * 365;
}

/**
 * Generate the SDK code that developers would use.
 */
function generateSdkCode(): string {
  return `
// @edge/builder-sdk — Route HL trades via Edge-Engine builder code
// Install: npm install @edge/builder-sdk
// No extra cost to developer — HL pays us the rebate

import { getBuilderField } from '@edge/builder-sdk';

// When placing HL orders, include the builder field:
const order = {
  action: {
    type: 'order',
    coin: 'BTC',
    isBuy: true,
    sz: '0.001',
    limitPx: '50000',
    orderType: { limit: { tif: 'Gtc' } },
    reduceOnly: false,
    builder: getBuilderField(),  // ← Just add this line!
    nonce: Date.now(),
  },
};

// That's it! We earn 0.1% rebate, you pay nothing extra.
`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Builder Code SDK Framework');
  console.log('═══════════════════════════════════════════════════\n');

  console.log('── SDK Configuration ──\n');
  console.log(`  Builder address: ${BUILDER_ADDRESS}`);
  console.log(`  Fee rate: ${BUILDER_FEE_BPS} bps (${BUILDER_FEE_BPS / 100}%)`);
  console.log(`  Cost to developer: $0 (HL pays the rebate)`);
  console.log('');

  console.log('── SDK Code (what developers use) ──\n');
  console.log(generateSdkCode());

  console.log('── Revenue Projections ──\n');
  const scenarios = [
    { name: '1 user ($5k/day volume)', dailyVol: 5_000 },
    { name: '10 users ($50k/day)', dailyVol: 50_000 },
    { name: '100 users ($500k/day)', dailyVol: 500_000 },
    { name: '1000 users ($5M/day)', dailyVol: 5_000_000 },
  ];
  for (const s of scenarios) {
    const daily = calculateBuilderFee(s.dailyVol);
    const annual = estimateAnnualRevenue(s.dailyVol);
    console.log(`  ${s.name}: $${daily.toFixed(2)}/day = $${(annual/1000).toFixed(0)}k/yr`);
  }

  console.log('\n── SDK Distribution Plan ──\n');
  console.log('  Phase 1 (1 week): Build npm package');
  console.log('    - TypeScript SDK');
  console.log('    - npm publish');
  console.log('    - GitHub repo with docs');
  console.log('');
  console.log('  Phase 2 (2 weeks): Documentation');
  console.log('    - Quick start guide');
  console.log('    - API reference');
  console.log('    - Code examples');
  console.log('    - Integration tutorials');
  console.log('');
  console.log('  Phase 3 (3 months): Marketing');
  console.log('    - Twitter/X promotion');
  console.log('    - HL Discord community');
  console.log('    - GitHub stars campaign');
  console.log('    - Target: 100 users in 3 months');
  console.log('');
  console.log('  Phase 4 (6 months): Scale');
  console.log('    - Enterprise integrations');
  console.log('    - White-label partnerships');
  console.log('    - Target: 1000 users in 6 months');
  console.log('');

  console.log('=== Verdict ===');
  console.log('Builder Code SDK is the SCALABLE revenue stream:');
  console.log('  - No capital needed (just $100 registration)');
  console.log('  - No risk (HL pays the rebate)');
  console.log('  - Exponential growth (each new user adds revenue)');
  console.log('  - 1000 users = $1.8M/yr');
  console.log('');
  console.log('BLOCKER: Need $100 USDC to register builder code first');
}

main().catch(console.error);
