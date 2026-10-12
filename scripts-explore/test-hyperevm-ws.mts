/**
 * Test HyperEVM WebSocket for pending transactions
 * 
 * If HyperEVM has a public mempool via WebSocket:
 *   - We can do sandwich attacks
 *   - We can do JIT liquidity
 *   - We can front-run large trades
 * 
 * WebSocket: wss://rpc.hyperliquid.xyz/evm
 * Subscribe: eth_subscribe, newPendingTransactions
 */

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperEVM WebSocket Mempool Test (30s)');
  console.log('═══════════════════════════════════════════════════\n');

  let eventCount = 0;
  let pendingTxCount = 0;
  let newBlockCount = 0;

  const ws = new WebSocket('wss://rpc.hyperliquid.xyz/evm');

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => { console.log('✅ Connected to HyperEVM WebSocket'); resolve(); };
    ws.onerror = (err) => { console.log('❌ WS error:', err); reject(new Error('WS error')); };
  });

  // Subscribe to pending transactions
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_subscribe',
    params: ['newPendingTransactions'],
  }));
  console.log('✅ Subscribed to newPendingTransactions');

  // Also subscribe to new blocks
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_subscribe',
    params: ['newHeads'],
  }));
  console.log('✅ Subscribed to newHeads');

  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);

      const msg = JSON.parse(dataStr);
      eventCount++;

      if (msg.id === 1) {
        console.log('  Pending tx subscription:', msg.result || 'confirmed');
      } else if (msg.id === 2) {
        console.log('  New heads subscription:', msg.result || 'confirmed');
      } else if (msg.method === 'eth_subscription') {
        if (msg.params?.subscription) {
          if (msg.params?.result?.hash) {
            pendingTxCount++;
            if (pendingTxCount <= 5) {
              console.log(`  📨 PENDING TX: ${msg.params.result.hash?.substring(0, 20)}...`);
            }
          } else if (msg.params?.result?.number) {
            newBlockCount++;
            console.log(`  📦 NEW BLOCK: ${parseInt(msg.params.result.number, 16)}`);
          }
        }
      }

      if (eventCount % 10 === 0) {
        console.log(`  [${eventCount} events] pending=${pendingTxCount} blocks=${newBlockCount}`);
      }
    } catch {}
  };

  console.log('\n── Listening for 30 seconds ──\n');
  await new Promise(r => setTimeout(r, 30_000));
  ws.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  WebSocket Mempool Test Complete');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`  Total events: ${eventCount}`);
  console.log(`  Pending transactions: ${pendingTxCount}`);
  console.log(`  New blocks: ${newBlockCount}`);
  console.log('');

  if (pendingTxCount > 0) {
    console.log('  ✅ MEMPOOL ACCESS CONFIRMED!');
    console.log('  → Sandwich attacks POSSIBLE');
    console.log('  → JIT liquidity POSSIBLE');
    console.log('  → Front-running POSSIBLE');
    console.log('');
    console.log('  Next: Build mempool monitor for MEV extraction');
  } else {
    console.log('  ⚠️  No pending transactions received');
    console.log('  → HyperEVM may not have public mempool');
    console.log('  → Only post-trade arbitrage possible');
    console.log('  → Back-running via newHeads still possible');
  }
}

main().catch(console.error);
