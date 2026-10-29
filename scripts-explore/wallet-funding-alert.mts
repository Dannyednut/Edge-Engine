/**
 * Wallet Funding Alert Bot
 *
 * Polls the agent's HL clearing house state every 30s.
 * When USDC is detected (withdrawable > 0):
 *   1. Fires CRITICAL Telegram alert
 *   2. Triggers the live trading pipeline
 *   3. Updates /tmp/wallet-funded flag
 *
 * Also monitors:
 *   - EVM wallet ETH balance (for gas)
 *   - Solana wallet SOL balance (for gas)
 *
 * State: /tmp/wallet-watcher-state.json
 * History: /tmp/wallet-watcher-history.jsonl
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnvIntoProcessEnv } from '../packages/risk/src/dotenv-safety.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

loadDotEnvIntoProcessEnv(resolve(REPO_ROOT, '.env'));

const HL_API = 'https://api.hyperliquid.xyz/info';
const TG_API = 'https://api.telegram.org';
const HYPERLIQUID_RPC = 'https://hyperliquid-testnet.xyz' // not used; mainnet evm rpc below
const HYPEREVM_RPC = 'https://hyperliquid.drpc.org';
const SOLANA_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const POLL_INTERVAL_MS = 30_000;  // 30s
const STATE_PATH = '/tmp/wallet-watcher-state.json';
const HISTORY_PATH = '/tmp/wallet-watcher-history.jsonl';
const WALLET_FUNDED_FLAG = '/tmp/wallet-funded';

interface WatcherState {
  lastUsdcBalance: number;
  lastEthBalance: number;
  lastSolBalance: number;
  walletFundedAlerted: boolean;
  fundedAt: number | null;
  fundedAmount: number | null;
  lastAlertTs: number;
}

function loadState(): WatcherState {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  }
  return {
    lastUsdcBalance: 0,
    lastEthBalance: 0,
    lastSolBalance: 0,
    walletFundedAlerted: false,
    fundedAt: null,
    fundedAmount: null,
    lastAlertTs: 0,
  };
}

function saveState(s: WatcherState) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function appendHistory(entry: any) {
  appendFileSync(HISTORY_PATH, JSON.stringify(entry) + '\n');
}

async function tgSend(text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}

async function getHlBalance(address: string): Promise<{ withdrawable: number; marginUsed: number; totalValue: number }> {
  try {
    const res = await fetch(HL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearingHouseState', user: address }),
    });
    if (!res.ok) return { withdrawable: 0, marginUsed: 0, totalValue: 0 };
    const j = await res.json() as any;
    if (j?.error) return { withdrawable: 0, marginUsed: 0, totalValue: 0 };
    return {
      withdrawable: parseFloat(j?.withdrawable || 0),
      marginUsed: parseFloat(j?.marginUsed || 0),
      totalValue: parseFloat(j?.marginUsed || 0) + parseFloat(j?.withdrawable || 0),
    };
  } catch {
    return { withdrawable: 0, marginUsed: 0, totalValue: 0 };
  }
}

async function getEthBalance(address: string): Promise<number> {
  try {
    const res = await fetch(HYPEREVM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    });
    const j = await res.json() as any;
    return parseInt(j?.result || '0x0', 16) / 1e18;
  } catch {
    return 0;
  }
}

async function getSolBalance(address: string): Promise<number> {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
    });
    const j = await res.json() as any;
    return (j?.result?.value || 0) / 1e9;
  } catch {
    return 0;
  }
}

async function checkWallets(state: WatcherState): Promise<{ fired: number }> {
  let fired = 0;
  const agentEvm = process.env.AGENT_EVM_ADDRESS;
  const agentSol = process.env.AGENT_SOLANA_ADDRESS;

  if (!agentEvm) {
    console.log('[wallet-watcher] no AGENT_EVM_ADDRESS configured');
    return { fired: 0 };
  }

  // HL balance
  const hl = await getHlBalance(agentEvm);
  console.log(`[wallet-watcher] HL: withdrawable=${fmtUsd(hl.withdrawable)} marginUsed=${fmtUsd(hl.marginUsed)} total=${fmtUsd(hl.totalValue)}`);

  // Fire funded alert if balance goes from 0 to >0
  if (hl.withdrawable > 0 && !state.walletFundedAlerted) {
    state.walletFundedAlerted = true;
    state.fundedAt = Date.now();
    state.fundedAmount = hl.withdrawable;
    writeFileSync(WALLET_FUNDED_FLAG, JSON.stringify({
      fundedAt: Date.now(),
      amount: hl.withdrawable,
      address: agentEvm,
    }, null, 2));

    const msg = [
      '🎉 *WALLET FUNDED — READY FOR LIVE TRADING*',
      '',
      `*Address:* \`${agentEvm}\``,
      `*USDC balance:* ${fmtUsd(hl.withdrawable)}`,
      `*Margin used:* ${fmtUsd(hl.marginUsed)}`,
      `*Total value:* ${fmtUsd(hl.totalValue)}`,
      '',
      '_Live trading pipeline activated._',
      '_Opportunities will be executed automatically._',
    ].join('\n');
    await tgSend(msg);
    appendHistory({ ts: Date.now(), type: 'FUNDED', address: agentEvm, amount: hl.withdrawable });
    fired++;
    console.log(`[wallet-watcher] 🔥 WALLET FUNDED! ${fmtUsd(hl.withdrawable)} USDC`);
  } else if (hl.withdrawable === 0 && state.walletFundedAlerted) {
    // Wallet drained
    state.walletFundedAlerted = false;
    if (existsSync(WALLET_FUNDED_FLAG)) {
      try { require('fs').unlinkSync(WALLET_FUNDED_FLAG); } catch {}
    }
    const msg = `⚠️ Wallet balance returned to 0. Live trading paused.`;
    await tgSend(msg);
    appendHistory({ ts: Date.now(), type: 'DRAINED', address: agentEvm });
    fired++;
    console.log(`[wallet-watcher] wallet drained`);
  }

  // Balance change alert (significant deposit/withdrawal)
  const diff = hl.withdrawable - state.lastUsdcBalance;
  if (Math.abs(diff) > 50 && state.lastUsdcBalance > 0) {
    // Skip first scan
    if (diff > 0) {
      console.log(`[wallet-watcher] +${fmtUsd(diff)} deposit detected`);
    } else {
      console.log(`[wallet-watcher] ${fmtUsd(diff)} withdrawal detected`);
    }
  }
  state.lastUsdcBalance = hl.withdrawable;

  // EVM balance
  if (agentEvm) {
    const eth = await getEthBalance(agentEvm);
    console.log(`[wallet-watcher] HyperEVM ETH: ${eth.toFixed(4)}`);
    if (eth < 0.001 && state.lastEthBalance > 0.001) {
      await tgSend(`⚠️ *Low ETH balance on HyperEVM*\nAddress: \`${agentEvm}\`\nBalance: ${eth.toFixed(4)} ETH\n_Need ETH for gas to execute trades._`);
      appendHistory({ ts: Date.now(), type: 'LOW_ETH', address: agentEvm, balance: eth });
      fired++;
    }
    state.lastEthBalance = eth;
  }

  // Solana balance
  if (agentSol) {
    const sol = await getSolBalance(agentSol);
    console.log(`[wallet-watcher] Solana SOL: ${sol.toFixed(4)}`);
    if (sol < 0.01 && state.lastSolBalance > 0.01) {
      await tgSend(`⚠️ *Low SOL balance*\nAddress: \`${agentSol}\`\nBalance: ${sol.toFixed(4)} SOL\n_Need SOL for Solana transactions._`);
      appendHistory({ ts: Date.now(), type: 'LOW_SOL', address: agentSol, balance: sol });
      fired++;
    }
    state.lastSolBalance = sol;
  }

  return { fired };
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Wallet Funding Alert Bot');
  console.log(`  Poll: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`  Agent EVM: ${process.env.AGENT_EVM_ADDRESS || '(not set)'}`);
  console.log(`  Agent SOL: ${process.env.AGENT_SOLANA_ADDRESS || '(not set)'}`);
  console.log('═══════════════════════════════════════════════════\n');

  let state = loadState();
  saveState(state);

  await tgSend('🟢 *Wallet Funding Alert Bot started*\n\n_Watching for USDC deposits on HL..._');

  let loop = 0;
  while (true) {
    loop++;
    try {
      const { fired } = await checkWallets(state);
      saveState(state);
      if (fired > 0) {
        console.log(`[loop ${loop}] ${new Date().toISOString()} fired ${fired} alerts`);
      }
    } catch (e) {
      console.error(`[loop ${loop}] error:`, e);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
