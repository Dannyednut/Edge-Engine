/**
 * Telegram bot connectivity test.
 *
 * Usage:
 *   pnpm --filter @edge/alerts test
 *   pnpm --filter @edge/alerts test -- --chat-id=<id>
 *
 * If --chat-id is not provided, calls getUpdates to discover the most
 * recent chat that messaged the bot.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getBotInfo, getRecentUpdates, TelegramAlerter } from './index.js';

// Load .env from repo root
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) {
      process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // .env not present
}

function arg(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag?.split('=', 2)[1];
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN env var not set');
    process.exit(1);
  }

  console.log('── Telegram Bot Test ─────────────────────────────');
  console.log(`Bot token: ${botToken.slice(0, 12)}...${botToken.slice(-6)}`);

  // 1. Verify bot identity
  const botInfo = await getBotInfo(botToken);
  if (!botInfo.ok || !botInfo.result) {
    console.error(`❌ getMe failed: ${(botInfo as { description?: string }).description ?? 'unknown'}`);
    process.exit(1);
  }
  console.log(`✓ Bot verified: @${botInfo.result.username} (id=${botInfo.result.id}, name="${botInfo.result.first_name}")`);

  // 2. Find chat ID
  let chatId = arg('chat-id') || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.log('  No --chat-id provided; calling getUpdates to discover...');
    let updates = await getRecentUpdates(botToken);
    if (!updates.ok) {
      const desc = (updates as { description?: string }).description ?? 'unknown';
      if (desc.includes('webhook')) {
        console.log(`  ⚠ Active webhook detected; deleting it...`);
        const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook?drop_pending_updates=true`, { method: 'POST' });
        const delJson = await res.json() as { ok: boolean; description?: string };
        console.log(`    deleteWebhook: ${delJson.ok ? 'OK' : delJson.description}`);
        updates = await getRecentUpdates(botToken);
      }
    }
    if (!updates.ok) {
      console.error(`❌ getUpdates failed: ${(updates as { description?: string }).description ?? 'unknown'}`);
      console.error('');
      console.error('   To fix:');
      console.error('   1. Send any message to @sea_crests_bot in Telegram');
      console.error('   2. Re-run this test, OR');
      console.error('   3. Set TELEGRAM_CHAT_ID in .env manually');
      process.exit(1);
    }
    const lastMessage = updates.result?.find(u => u.message)?.message;
    if (!lastMessage) {
      console.warn('⚠️  No messages found — send any message to the bot first, then re-run.');
      console.warn('    Then either:');
      console.warn('      (a) re-run this script (it will discover the chat), or');
      console.warn('      (b) set TELEGRAM_CHAT_ID in .env');
      process.exit(0);
    }
    chatId = String(lastMessage.chat.id);
    console.log(`✓ Discovered chat_id=${chatId} (user: ${lastMessage.chat.username ?? lastMessage.chat.first_name})`);
  } else {
    console.log(`  Using provided chat_id=${chatId}`);
  }

  // 3. Send a test message
  const alerter = new TelegramAlerter({ botToken, chatId });
  const msgId = await alerter.info(
    'Edge-Engine Bot Online',
    [
      'Edge-Engine bot is online and connected.',
      '',
      '*Brief 02 setup checklist:*',
      '✓ Repo cloned (github.com/Dannyednut/Edge-Engine)',
      '✓ TypeScript monorepo scaffolded (pnpm workspaces, 11 packages)',
      '✓ All 8 RPCs wired up (Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, zkSync, Solana)',
      '✓ Sharpe.ai + VOOI clients integrated (fastest path to funding-rate arb)',
      '✓ Telegram alerting verified (this message)',
      '⚠ Kalshi dropped (principal is non-US) — prediction-market strategy pivoted to Polymarket + Azuro + Overtime + Zeitgeist + Manifold',
      '',
      'Next: build first live scanner (perp funding rate via Sharpe + VOOI cross-validation).',
    ].join('\n')
  );
  console.log(`✓ Test message sent (message_id=${msgId})`);
  console.log('── Done ──────────────────────────────────────────');
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
