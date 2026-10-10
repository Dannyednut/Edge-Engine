/**
 * HL Order Signing Implementation
 *
 * Critical for live trading — all HL exchange actions must be signed.
 * Uses L1-style signing (not EIP-712) per HL documentation.
 *
 * Signing process:
 *   1. Construct action object
 *   2. Hash action using HL's hashing scheme
 *   3. Sign hash with EVM private key (eth_sign-style)
 *   4. Submit to /exchange endpoint with signature
 *
 * This is the MISSING PIECE for live trading.
 * Once implemented, we can:
 *   - Place orders
 *   - Cancel orders
 *   - Transfer USDC
 *   - Create vaults
 *   - Approve builder fees
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash, createSign } from 'node:crypto';

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

const HL_EXCHANGE = 'https://api.hyperliquid.xyz/exchange';

/**
 * Convert private key from hex to buffer
 */
function privateKeyToBuffer(privateKey: string): Buffer {
  const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  return Buffer.from(hex, 'hex');
}

/**
 * Sign a hash with an EVM private key using secp256k1
 * Returns { r, s, v } signature
 */
function signHash(hash: Buffer, privateKey: Buffer): { r: string; s: string; v: number } {
  // In production, use proper secp256k1 library (noble-secp256k1 or @noble/curves)
  // For now, document the process
  //
  // const signer = createSign('SHA256');
  // signer.update(hash);
  // const signature = signer.sign(privateKey);
  //
  // Parse signature into r, s, v
  // v = 27 + recoveryId (0 or 1)

  console.log('[signing] Hash to sign:', hash.toString('hex'));
  console.log('[signing] ⚠️  Needs proper secp256k1 implementation');
  console.log('[signing] Install: npm install @noble/curves');

  return { r: '0x...', s: '0x...', v: 27 };
}

/**
 * Construct an HL order action
 */
function constructOrderAction(params: {
  coin: string;
  isBuy: boolean;
  sz: string;
  limitPx: string;
  orderType: { limit: { tif: string } } | { trigger: { triggerPx: string; isMarket: boolean; tpsl: string } };
  reduceOnly?: boolean;
  builder?: { b: string; f: number };
}): any {
  return {
    type: 'order',
    coin: params.coin,
    isBuy: params.isBuy,
    sz: params.sz,
    limitPx: params.limitPx,
    orderType: params.orderType,
    reduceOnly: params.reduceOnly ?? false,
    builder: params.builder,
    nonce: Date.now(),
  };
}

/**
 * Submit a signed action to HL exchange
 */
async function submitAction(action: any, signature: { r: string; s: string; v: number }): Promise<any> {
  const body = {
    chain: '1', // Mainnet
    action,
    signature,
  };

  console.log('[submit] POST /exchange');
  console.log('[submit] Body:', JSON.stringify(body).substring(0, 200));

  // In production:
  // const res = await fetch(HL_EXCHANGE, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify(body),
  // });
  // return res.json();

  return { status: 'not_implemented', message: 'Needs proper signing' };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Order Signing Implementation');
  console.log('  THE MISSING PIECE for live trading');
  console.log('═══════════════════════════════════════════════════\n');

  const agentAddress = process.env.AGENT_EVM_ADDRESS;
  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY;

  console.log('── Agent Wallet ──\n');
  console.log(`  Address: ${agentAddress}`);
  console.log(`  Private key: ${agentPrivateKey?.substring(0, 10)}...`);
  console.log('');

  console.log('── Signing Process ─\n');
  console.log('  1. Construct action object');
  console.log('  2. Hash action using HL\'s hashing scheme');
  console.log('     - HL uses a custom hash (not standard EIP-712)');
  console.log('     - Hash = keccak256(action_bytes)');
  console.log('  3. Sign hash with EVM private key');
  console.log('     - Use secp256k1 curve');
  console.log('     - Returns { r, s, v } signature');
  console.log('  4. Submit to /exchange endpoint');
  console.log('     - POST with { chain, action, signature }');
  console.log('');

  console.log('── Example: Place BTC Order ─\n');
  const orderAction = constructOrderAction({
    coin: 'BTC',
    isBuy: true,
    sz: '0.001',
    limitPx: '50000',
    orderType: { limit: { tif: 'Gtc' } },
    builder: { b: agentAddress!, f: 10 },
  });
  console.log('  Action:');
  console.log(JSON.stringify(orderAction, null, 2));
  console.log('');

  console.log('── Implementation Requirements ─\n');
  console.log('  1. Install secp256k1 library');
  console.log('     npm install @noble/curves');
  console.log('     or: npm install ethers (includes signing)');
  console.log('');
  console.log('  2. Implement HL action hashing');
  console.log('     - HL uses a specific byte encoding for actions');
  console.log('     - Need to match HL\'s exact format');
  console.log('     - Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint');
  console.log('');
  console.log('  3. Implement signing');
  console.log('     - Sign hash with private key');
  console.log('     - Return { r, s, v } tuple');
  console.log('');
  console.log('  4. Test with small order');
  console.log('     - Place $10 order first');
  console.log('     - Verify fill');
  console.log('     - Verify builder code rebate');
  console.log('');

  console.log('── Actions That Need Signing ─\n');
  const actions = [
    { type: 'order', desc: 'Place/cancel perp orders', priority: 'P0' },
    { type: 'usdSend', desc: 'Transfer USDC between wallets', priority: 'P0' },
    { type: 'approveBuilderFee', desc: 'Register builder code', priority: 'P0' },
    { type: 'createUserVault', desc: 'Create HL vault', priority: 'P1' },
    { type: 'updateVaultEquityAndFee', desc: 'Set vault fees', priority: 'P1' },
    { type: 'spotSend', desc: 'Transfer spot tokens', priority: 'P2' },
    { type: 'usdClassTransfer', desc: 'Move USDC between perp/spot', priority: 'P1' },
    { type: 'cLOIDOrder', desc: 'Place order with client order ID', priority: 'P2' },
  ];
  console.log('  Action                | Description                        | Priority');
  console.log('───────────────────────|────────────────────────────────────|─────────');
  for (const a of actions) {
    console.log(`  ${a.type.padEnd(21)}| ${a.desc.padEnd(34)}| ${a.priority}`);
  }

  console.log('\n=== Verdict ===');
  console.log('Order signing is THE CRITICAL BLOCKER for live trading.');
  console.log('  Without it: Cannot place orders, transfer funds, or create vaults');
  console.log('  With it: Full live trading capability');
  console.log('');
  console.log('BUILD TIME: 2-3 days (with ethers.js)');
  console.log('  1. Install ethers.js (already in package.json?)');
  console.log('  2. Implement HL action hashing');
  console.log('  3. Implement signing');
  console.log('  4. Test with small order');
  console.log('');
  console.log('This is the #1 priority for live deployment.');
}

main().catch(console.error);
