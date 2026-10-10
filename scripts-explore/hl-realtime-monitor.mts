/**
 * HL Real-Time Order Monitor
 *
 * Uses WebSocket to monitor our own orders in real-time.
 * When we have live positions, this tracks:
 *   - Order fills
 *   - Position changes
 *   - Funding payments
 *   - Liquidation alerts
 *
 * WebSocket channel: userEvents (requires user address)
 * WebSocket channel: userFills (requires user address)
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

const HL_WS = 'wss://api.hyperliquid.xyz/ws';

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Real-Time Order Monitor (30s test)');
  console.log('═══════════════════════════════════════════════════\n');

  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  if (!agentAddress) {
    console.log('❌ AGENT_EVM_ADDRESS not set');
    return;
  }

  let eventCount = 0;
  const eventTypes: Record<string, number> = {};

  const ws = new WebSocket(HL_WS);

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WS error'));
  });
  console.log('✅ Connected to HL WebSocket\n');

  // Subscribe to user events
  ws.send(JSON.stringify({
    method: 'subscribe',
    subscription: { type: 'userEvents', user: agentAddress }
  }));
  console.log(`✅ Subscribed to userEvents (${agentAddress})`);

  ws.send(JSON.stringify({
    method: 'subscribe',
    subscription: { type: 'userFills', user: agentAddress }
  }));
  console.log(`✅ Subscribed to userFills (${agentAddress})\n`);

  ws.onmessage = async (ev) => {
    try {
      let dataStr: string;
      if (typeof ev.data === 'string') dataStr = ev.data;
      else if (ev.data instanceof ArrayBuffer) dataStr = new TextDecoder().decode(ev.data);
      else if (typeof Blob !== 'undefined' && ev.data instanceof Blob) dataStr = await ev.data.text();
      else dataStr = String(ev.data);

      const msg = JSON.parse(dataStr);
      eventCount++;
      const channel = msg.channel || 'unknown';
      eventTypes[channel] = (eventTypes[channel] || 0) + 1;

      if (eventCount <= 5 || eventCount % 10 === 0) {
        console.log(`[${eventCount}] ${channel}: ${JSON.stringify(msg).substring(0, 200)}`);
      }
    } catch {}
  };

  console.log('── Listening for 30 seconds ──\n');
  await new Promise(r => setTimeout(r, 30_000));
  ws.close();

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Real-Time Monitor Summary');
  console.log('═══════════════════════════════════════════════════\n');
  console.log(`Total events: ${eventCount}`);
  console.log('\nEvents by channel:');
  for (const [ch, count] of Object.entries(eventTypes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ch.padEnd(20)} ${count}`);
  }

  if (eventCount === 0) {
    console.log('\n  No events — wallet is empty (no trades, no positions).');
    console.log('  When we deploy capital, this monitor will track:');
    console.log('    - Order fills (real-time)');
    console.log('    - Position changes');
    console.log('    - Funding payments');
    console.log('    - Liquidation alerts');
  }

  console.log('\n── Use Cases ──\n');
  console.log('  1. REAL-TIME P&L TRACKING');
  console.log('     - Track every fill as it happens');
  console.log('     - Compute live P&L');
  console.log('     - Alert on significant profit/loss');
  console.log('');
  console.log('  2. POSITION MONITORING');
  console.log('     - Track open positions');
  console.log('     - Alert on margin ratio < 1.5');
  console.log('     - Auto-close on risk threshold');
  console.log('');
  console.log('  3. FUNDING PAYMENT TRACKING');
  console.log('     - Track funding income/expense');
  console.log('     - Alert on large funding payments');
  console.log('     - Report daily funding P&L');
  console.log('');
  console.log('  4. LIQUIDATION ALERTS');
  console.log('     - Get instant notification if position liquidated');
  console.log('     - Auto-close other positions to prevent cascade');
  console.log('     - Alert principal immediately');
}

main().catch(console.error);
