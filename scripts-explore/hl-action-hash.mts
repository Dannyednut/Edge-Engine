/**
 * HL Action Hash Implementation
 *
 * HL uses a specific action hash format for signing.
 * Based on HL documentation and SDK:
 *
 * Hash = keccak256(action_hash)
 * where action_hash = constructActionHash(action)
 *
 * The action hash includes:
 * - Agent address (padded to 32 bytes)
 * - Action type (as string, hashed)
 * - Action parameters (specific to each action type)
 * - Nonce (as uint256)
 *
 * This is NOT EIP-712. It's HL's custom L1-style signing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { secp256k1 } from '/home/z/my-project/edge-engine/node_modules/.pnpm/@noble+curves@2.2.0/node_modules/@noble/curves/secp256k1.js';
import { keccak_256 } from '/home/z/my-project/edge-engine/node_modules/.pnpm/@noble+hashes@2.2.0/node_modules/@noble/hashes/sha3.js';

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
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Sign a hash with private key
 */
function signHash(hash: Uint8Array, privateKey: string): { r: string; s: string; v: number } {
  const privBytes = hexToBytes(privateKey);
  const sigBytes = secp256k1.sign(hash, privBytes) as Uint8Array;
  const sigBuf = Buffer.from(sigBytes);
  const r = '0x' + sigBuf.subarray(0, 32).toString('hex');
  const s = '0x' + sigBuf.subarray(32, 64).toString('hex');
  const v = 27; // recovery bit (try 0 first)
  return { r, s, v };
}

/**
 * Construct the HL action hash.
 * 
 * HL uses a specific format:
 * 1. The action is converted to a specific byte representation
 * 2. Hash = keccak256(bytes)
 * 
 * Based on HL's Python SDK (hyperliquid-python-sdk):
 * The hash is constructed as:
 *   hash = keccak256(action_bytes)
 * where action_bytes = json.dumps(action, separators=(',', ':'))
 * 
 * Then the signature is:
 *   sig = sign(hash, private_key)
 *   { r, s, v } where v = 27 + recovery
 * 
 * BUT: HL actually uses L1-style hashing where the action
 * is first converted to their internal L1 representation.
 * 
 * The actual method (from HL's info API):
 * POST /exchange with:
 * {
 *   "chain": "1",
 *   "action": { ...action with nonce... },
 *   "signature": { "r": "0x...", "s": "0x...", "v": 27 }
 * }
 * 
 * The hash to sign is:
 *   keccak256(json.dumps(action))
 * where the JSON uses no spaces (compact format)
 */

function constructActionHash(action: any): Uint8Array {
  // Serialize action to compact JSON (no spaces)
  const actionStr = JSON.stringify(action);
  // Hash with keccak256
  const hash = keccak_256(new TextEncoder().encode(actionStr));
  return hash;
}

/**
 * Submit a signed action to HL exchange
 */
async function submitAction(action: any, privateKey: string): Promise<any> {
  const nonce = Date.now();
  const fullAction = { ...action, nonce };
  
  // Construct hash
  const hash = constructActionHash(fullAction);
  console.log('[hash] Action hash: 0x' + Buffer.from(hash).toString('hex').substring(0, 32) + '...');
  
  // Sign
  const signature = signHash(hash, privateKey);
  console.log('[sign] r: ' + signature.r.substring(0, 20) + '...');
  console.log('[sign] s: ' + signature.s.substring(0, 20) + '...');
  console.log('[sign] v: ' + signature.v);
  
  // Submit
  const body = {
    chain: '1',
    action: fullAction,
    signature,
  };
  
  console.log('[submit] POST /exchange');
  console.log('[submit] Body:', JSON.stringify(body).substring(0, 300));
  
  try {
    const res = await fetch(HL_EXCHANGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log('[submit] Status:', res.status);
    console.log('[submit] Response:', text.substring(0, 300));
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (e: any) {
    console.log('[submit] Error:', e.message);
    return { error: e.message };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HL Action Hash Implementation');
  console.log('═══════════════════════════════════════════════════\n');

  const agentPrivateKey = process.env.AGENT_EVM_PRIVATE_KEY;
  const agentAddress = process.env.AGENT_EVM_ADDRESS;

  if (!agentPrivateKey || !agentAddress) {
    console.log('❌ Agent wallet not configured');
    return;
  }

  // Test 1: approveBuilderFee
  console.log('── Test 1: approveBuilderFee ──\n');
  const approveAction = {
    type: 'approveBuilderFee',
    maxFeeRate: '10',
    builder: agentAddress,
  };
  
  console.log('Action:', JSON.stringify(approveAction, null, 2));
  const result1 = await submitAction(approveAction, agentPrivateKey);
  console.log('\nResult:', JSON.stringify(result1).substring(0, 300));
  
  // If v=27 doesn't work, try v=28
  if (result1?.response?.type === 'err' || result1?.raw?.includes('Failed')) {
    console.log('\n── Trying v=28 (recovery bit 1) ──\n');
    // Resubmit with v=28
    const nonce = Date.now();
    const fullAction = { ...approveAction, nonce };
    const hash = constructActionHash(fullAction);
    const sigBytes = secp256k1.sign(hash, hexToBytes(agentPrivateKey)) as Uint8Array;
    const sigBuf = Buffer.from(sigBytes);
    
    const body = {
      chain: '1',
      action: fullAction,
      signature: {
        r: '0x' + sigBuf.subarray(0, 32).toString('hex'),
        s: '0x' + sigBuf.subarray(32, 64).toString('hex'),
        v: 28, // try recovery bit 1
      },
    };
    
    console.log('Submitting with v=28...');
    try {
      const res = await fetch(HL_EXCHANGE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log('Status:', res.status);
      console.log('Response:', text.substring(0, 300));
    } catch (e: any) {
      console.log('Error:', e.message);
    }
  }

  // Test 2: usdSend (if wallet has funds)
  console.log('\n── Test 2: usdSend (test with $0.01) ──\n');
  const sendAction = {
    type: 'usdSend',
    to: agentAddress, // send to self for testing
    amount: '0.01',
  };
  
  console.log('Action:', JSON.stringify(sendAction, null, 2));
  const result2 = await submitAction(sendAction, agentPrivateKey);
  console.log('\nResult:', JSON.stringify(result2).substring(0, 300));

  console.log('\n=== Analysis ===');
  console.log('If errors say "Invalid signature":');
  console.log('  → Hash format is wrong (need HL-specific format)');
  console.log('  → Try: rlp encoding, or EIP-712, or custom HL format');
  console.log('');
  console.log('If errors say "Insufficient balance":');
  console.log('  → Signing is CORRECT!');
  console.log('  → Just need to fund the wallet');
  console.log('');
  console.log('If errors say "Invalid request":');
  console.log('  → Action format may be wrong');
  console.log('  → Check action type and parameters');
}

main().catch(console.error);
