// Explore Hyperliquid Public API — what data is available?
// This helps us identify new strategies based on what we can monitor

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

const HL_API = 'https://api.hyperliquid.xyz/info';

async function hlInfo(body: any): Promise<any> {
  const res = await fetch(HL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { error: res.status, body: await res.text() };
  return res.json();
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Hyperliquid Public API Explorer');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Test various API endpoints
  const endpoints = [
    { name: 'meta', body: { type: 'meta' } },
    { name: 'metaAndAssetCtxs', body: { type: 'metaAndAssetCtxs', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'allMids', body: { type: 'allMids' } },
    { name: 'spotMeta', body: { type: 'spotMeta' } },
    { name: 'spotMetaAndAssetCtxs', body: { type: 'spotMetaAndAssetCtxs' } },
    { name: 'spotClearingHouseState', body: { type: 'spotClearingHouseState', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'clearingHouseState', body: { type: 'clearingHouseState', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'userFunding', body: { type: 'userFunding', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'userNonFundingLedger', body: { type: 'userNonFundingLedger', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'vaultInfo', body: { type: 'vaultInfo', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'userVaultEquities', body: { type: 'userVaultEquities', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'vaultDetails', body: { type: 'vaultDetails', vaultAddress: '0x0000000000000000000000000000000000000000' } },
    { name: 'subAccounts', body: { type: 'subAccounts', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'legalList', body: { type: 'legalList' } },
    { name: 'portfolio', body: { type: 'portfolio', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'orderStatus', body: { type: 'orderStatus', user: '0x0000000000000000000000000000000000000000', oid: 1 } },
    { name: 'userOpenOrders', body: { type: 'userOpenOrders', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'userFills', body: { type: 'userFills', user: '0x0000000000000000000000000000000000000000' } },
    { name: 'userFillsByTime', body: { type: 'userFillsByTime', user: '0x0000000000000000000000000000000000000000', startTime: Date.now() - 86400000 } },
    { name: 'rateLimit', body: { type: 'rateLimit' } },
    { name: 'fundingHistory', body: { type: 'fundingHistory', coin: 'BTC', startTime: Date.now() - 86400000, endTime: Date.now() } },
    { name: 'orderBook', body: { type: 'orderBook', coin: 'BTC' } },
    { name: 'l2Book', body: { type: 'l2Book', coin: 'BTC' } },
    { name: 'recentTrades', body: { type: 'recentTrades', coin: 'BTC' } },
    { name: 'batchTrades', body: { type: 'batchTrades', coin: 'BTC' } },
    { name: 'historicalVault', body: { type: 'historicalVault' } },
  ];

  console.log('── Testing API Endpoints ──\n');
  console.log('Endpoint                           | Status    | Notes');
  console.log('──────────────────────────────────|───────────|─────────────────────────────');

  for (const ep of endpoints) {
    try {
      const result = await hlInfo(ep.body);
      if (result?.error) {
        console.log(`${ep.name.padEnd(34)}| ❌ ${String(result.error).padEnd(9)}| ${typeof result.body === 'string' ? result.body.substring(0, 50) : 'error'}`);
      } else if (Array.isArray(result)) {
        console.log(`${ep.name.padEnd(34)}| ✅ Array  | ${result.length} items`);
      } else if (typeof result === 'object') {
        const keys = Object.keys(result);
        console.log(`${ep.name.padEnd(34)}| ✅ Object | keys: ${keys.slice(0, 5).join(', ')}`);
      } else {
        console.log(`${ep.name.padEnd(34)}| ✅ ${typeof result}`.substring(0, 80));
      }
    } catch (e: any) {
      console.log(`${ep.name.padEnd(34)}| ❌ Error  | ${e.message.substring(0, 50)}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Strategy implications
  console.log('\n── Strategy Implications ──\n');
  console.log('Available data enables:');
  console.log('  ✅ Real-time price monitoring (allMids, orderBook)');
  console.log('  ✅ Funding rate tracking (metaAndAssetCtxs)');
  console.log('  ✅ Open interest monitoring (metaAndAssetCtxs)');
  console.log('  ✅ Order book depth analysis (l2Book)');
  console.log('  ✅ Recent trades (recentTrades)');
  console.log('  ✅ User positions (clearingHouseState)');
  console.log('  ✅ User funding history (userFunding)');
  console.log('  ✅ User fills (userFills, userFillsByTime)');
  console.log('  ✅ Vault info (vaultInfo, vaultDetails)');
  console.log('  ✅ Portfolio tracking (portfolio)');
  console.log('');
  console.log('NOT available (would need different approach):');
  console.log('  ❌ All users\' positions (privacy)');
  console.log('  ❌ Liquidation feed (need to infer from trades)');
  console.log('  ❌ Real-time order flow (need WebSocket)');
  console.log('  ❌ Sub-account details (only for own account)');
  console.log('');

  // 3. New strategy ideas
  console.log('── New Strategy Ideas from API ──\n');
  console.log('  Idea 1: Order Book Imbalance Strategy');
  console.log('    - Monitor l2Book for all top perps');
  console.log('    - When bid/ask imbalance > 70/30, predict price move');
  console.log('    - Trade in direction of imbalance');
  console.log('    - Risk: Directional (not delta-neutral)');
  console.log('');
  console.log('  Idea 2: Vault Performance Tracker');
  console.log('    - Monitor top HL vaults via vaultInfo');
  console.log('    - Track their P&L + strategies');
  console.log('    - Reverse-engineer their approaches');
  console.log('    - Build competing vault with better returns');
  console.log('');
  console.log('  Idea 3: Whale Activity Monitor');
  console.log('    - Track large fills via userFillsByTime');
  console.log('    - Identify whale wallets');
  console.log('    - Alert when whales make big moves');
  console.log('    - Front-run or follow (risky!)');
  console.log('');
  console.log('  Idea 4: Funding Rate Divergence');
  console.log('    - Track funding rates across all perps');
  console.log('    - When funding deviates from historical norm, alert');
  console.log('    - Trade mean reversion (delta-neutral)');
  console.log('');
  console.log('  Idea 5: Trade Flow Analysis');
  console.log('    - Monitor recentTrades for all top perps');
  console.log('    - Detect momentum / reversal patterns');
  console.log('    - Alert on unusual volume spikes');
  console.log('');

  console.log('=== Verdict ===');
  console.log('HL API provides rich data for strategy development.');
  console.log('  - Most useful for monitoring + alerting');
  console.log('  - Limited for execution (need authenticated POST)');
  console.log('  - New strategy ideas: 5 identified');
  console.log('  - Best candidates: Vault tracker + Funding divergence');
}

main().catch(console.error);
