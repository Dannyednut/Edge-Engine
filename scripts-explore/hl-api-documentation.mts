/**
 * HL API Documentation
 * 
 * Complete documentation of all verified HL API endpoints
 * Based on testing with hl-api-explorer and hl-api-explorer-v2
 */

async function main() {
  console.log('── HL API Complete Documentation ──\n');
  
  console.log('═══ INFO ENDPOINTS (POST /info) ═══\n');
  
  const endpoints = [
    { name: 'meta', params: '{ type: "meta" }', returns: 'universe, marginTables, collateralToken', status: '✅' },
    { name: 'metaAndAssetCtxs', params: '{ type: "metaAndAssetCtxs", user: "0x..." }', returns: 'universe + asset contexts (price, funding, OI, volume)', status: '✅' },
    { name: 'allMids', params: '{ type: "allMids" }', returns: 'all mid prices (perps + spot)', status: '✅' },
    { name: 'spotMeta', params: '{ type: "spotMeta" }', returns: 'spot universe + tokens', status: '✅' },
    { name: 'spotMetaAndAssetCtxs', params: '{ type: "spotMetaAndAssetCtxs" }', returns: 'spot universe + contexts', status: '✅' },
    { name: 'portfolio', params: '{ type: "portfolio", user: "0x..." }', returns: 'account value history (day/week/month/allTime)', status: '✅' },
    { name: 'userFees', params: '{ type: "userFees", user: "0x..." }', returns: 'daily volume, fee schedule, rates', status: '✅' },
    { name: 'userFunding', params: '{ type: "userFunding", user: "0x...", startTime }', returns: 'funding payment history', status: '✅' },
    { name: 'userFills', params: '{ type: "userFills", user: "0x..." }', returns: 'trade fills (last 2000)', status: '✅' },
    { name: 'userFillsByTime', params: '{ type: "userFillsByTime", user: "0x...", startTime }', returns: 'trade fills by time range', status: '✅' },
    { name: 'userVaultEquities', params: '{ type: "userVaultEquities", user: "0x..." }', returns: 'vault deposit balances', status: '✅' },
    { name: 'subAccounts', params: '{ type: "subAccounts", user: "0x..." }', returns: 'sub-account list', status: '✅' },
    { name: 'orderStatus', params: '{ type: "orderStatus", user, oid }', returns: 'order status', status: '✅' },
    { name: 'recentTrades', params: '{ type: "recentTrades", coin: "BTC" }', returns: '10 recent trades', status: '✅' },
    { name: 'l2Book', params: '{ type: "l2Book", coin: "BTC" }', returns: 'order book levels', status: '✅' },
    { name: 'fundingHistory', params: '{ type: "fundingHistory", coin, startTime, endTime }', returns: 'funding rate history', status: '✅' },
    { name: 'vaultDetails', params: '{ type: "vaultDetails", vaultAddress }', returns: 'vault configuration', status: '✅' },
    { name: 'userNonFundingLedger', params: '{ type: "userNonFundingLedger", user }', returns: 'non-funding ledger', status: '❌' },
    { name: 'userOpenOrders', params: '{ type: "userOpenOrders", user }', returns: 'open orders', status: '❌' },
    { name: 'leaderboard', params: '{ type: "leaderboard" }', returns: 'leaderboard', status: '❌' },
    { name: 'candleSnapshot', params: '{ type: "candleSnapshot", coin, interval, startTime }', returns: 'OHLCV candles', status: '❌' },
  ];
  
  console.log('Endpoint                    | Status | Returns');
  console.log('────────────────────────────|────────|──────────────────────────────────────');
  for (const ep of endpoints) {
    console.log(`${ep.name.padEnd(28)}| ${ep.status}    | ${ep.returns}`);
  }
  
  console.log('\n═══ EXCHANGE ENDPOINTS (POST /exchange) ═══\n');
  console.log('  Requires: signed action with viem wallet');
  console.log('  SDK: @nbtKas/hyperliquid ExchangeClient\n');
  
  const exchangeActions = [
    { name: 'order', desc: 'Place/cancel perp orders', status: '✅ verified' },
    { name: 'usdSend', desc: 'Transfer USDC between wallets', status: '✅ verified' },
    { name: 'approveBuilderFee', desc: 'Register builder code', status: '✅ verified' },
    { name: 'createUserVault', desc: 'Create HL vault', status: '✅ verified (needs function name)' },
    { name: 'updateVaultEquityAndFee', desc: 'Set vault fees', status: '✅ verified' },
    { name: 'usdClassTransfer', desc: 'Move USDC between perp/spot', status: '✅ verified' },
    { name: 'spotSend', desc: 'Transfer spot tokens', status: '✅ verified' },
    { name: 'cancelByCloid', desc: 'Cancel by client order ID', status: '✅ verified' },
    { name: 'borrowLend', desc: 'Borrow/lend operation', status: '✅ verified' },
  ];
  
  for (const a of exchangeActions) {
    console.log(`  ${a.name.padEnd(28)} ${a.status.padEnd(15)} ${a.desc}`);
  }
  
  console.log('\n═══ WEBSOCKET (wss://api.hyperliquid.xyz/ws) ═══\n');
  
  const wsChannels = [
    { name: 'allMids', desc: 'All mid prices (real-time)', status: '✅' },
    { name: 'l2Book', desc: 'Order book updates', status: '✅' },
    { name: 'trades', desc: 'Trade feed', status: '✅' },
    { name: 'candle', desc: 'OHLCV candle updates', status: '✅' },
    { name: 'userFills', desc: 'User fill notifications', status: '✅' },
    { name: 'userEvents', desc: 'All user events', status: '✅' },
  ];
  
  for (const c of wsChannels) {
    console.log(`  ${c.name.padEnd(20)} ${c.status} ${c.desc}`);
  }
  
  console.log('\n═══ HYPEREVM RPC (https://rpc.hyperliquid.xyz/evm) ═══\n');
  console.log('  Standard eth_* methods: ✅');
  console.log('  Block time: ~1s');
  console.log('  Gas: 0.10 Gwei ($0.004/tx)');
  console.log('  Chain ID: 999');
  console.log('');
  console.log('  Precompiles:');
  console.log('    0x...0807: HL perp oracle price reader ✅');
  console.log('    0x3333...: CoreWriter (place HL orders from EVM) ✅');
  console.log('');
  console.log('  Contracts:');
  console.log('    USDC: 0xb883...630f (6 decimals, 6.7B supply)');
  console.log('    WHYPE: 0x5555...5555 (18 decimals, 3.2M supply)');
  console.log('    USDT0: 0xb8ce...5ebb (6 decimals, 68M supply)');
  console.log('    kHYPE: 0xfd73...296d (18 decimals, 10.1M supply)');
  console.log('    UBTC: 0x9fdb...9463 (8 decimals, 21M supply)');
  console.log('    UETH: 0xbe67...7907 (18 decimals, 100M supply)');
  console.log('    hyperRAM: 0x5555...5555 (18 decimals, 69M supply)');
  console.log('    xRAM: 0xae6d...deb9 (18 decimals, 325M supply)');
}
main();
