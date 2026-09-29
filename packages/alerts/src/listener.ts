/**
 * TelegramListener v2 — message queue + immediate ack + persistent inbox.
 *
 * Differences from v1:
 *   - Writes every received message to /tmp/telegram-inbox.jsonl (one JSON per line)
 *     so messages are NEVER lost even if the process dies
 *   - Sends an immediate ack to the principal: "✓ received — agent will respond shortly"
 *   - The orchestrator (me) polls the inbox file between scan cycles and
 *     composes intelligent conversational responses
 *   - No command routing here — ALL messages go to the inbox for the orchestrator
 *     to handle. Commands are just special messages I recognize.
 *
 * Architecture:
 *   listener process → writes to /tmp/telegram-inbox.jsonl
 *   orchestrator (me) → reads inbox, responds via TelegramAlerter, marks processed
 *
 * The inbox file is append-only JSONL. Each line:
 *   {"id":"msg_<update_id>","ts":<epoch_ms>,"from":"<username>","text":"<msg>","processed":false}
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, appendFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..', '..', '..');

// Load .env
try {
  const env = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
} catch { /* .env not present */ }

const TELEGRAM_API = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_SEC = 30;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30_000;
export const INBOX_PATH = '/tmp/telegram-inbox.jsonl';

export interface InboxEntry {
  id: string;
  ts: number;
  from: string;
  text: string;
  processed: boolean;
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in .env');
    process.exit(1);
  }

  let offset = 0;
  let closed = false;
  let reconnectAttempt = 0;

  console.log(`[TelegramListener] started — listening for messages from chat ${chatId}`);
  console.log(`[TelegramListener] inbox: ${INBOX_PATH}`);

  // Clear pending updates so we don't replay old messages
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset: -1, limit: 1, timeout: 0 }),
    });
    const json = await res.json() as { ok: boolean; result?: Array<{ update_id: number }> };
    if (json.ok && json.result && json.result.length > 0) {
      offset = json.result[0].update_id + 1;
    }
    console.log('[TelegramListener] cleared pending updates');
  } catch (err) {
    console.warn('[TelegramListener] failed to clear pending updates:', err);
  }

  while (!closed) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          limit: 100,
          timeout: LONG_POLL_TIMEOUT_SEC,
          allowed_updates: ['message'],
        }),
        signal: AbortSignal.timeout((LONG_POLL_TIMEOUT_SEC + 10) * 1000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`getUpdates ${res.status}: ${errText.slice(0, 200)}`);
      }
      const json = await res.json() as { ok: boolean; result?: Array<TgUpdate>; description?: string };
      if (!json.ok) {
        throw new Error(`getUpdates !ok: ${json.description ?? 'unknown'}`);
      }
      reconnectAttempt = 0;
      const updates = json.result ?? [];
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        const msgChatId = String(msg.chat.id);
        if (msgChatId !== chatId) {
          console.log(`[TelegramListener] ignoring message from unauthorized chat ${msgChatId}`);
          continue;
        }
        const from = msg.from?.username ?? msg.from?.first_name ?? 'unknown';
        const text = msg.text.trim();
        console.log(`[TelegramListener] received from ${from}: ${text}`);

        // Write to inbox file
        const entry: InboxEntry = {
          id: `msg_${update.update_id}`,
          ts: Date.now(),
          from,
          text,
          processed: false,
        };
        appendFileSync(INBOX_PATH, JSON.stringify(entry) + '\n');
        console.log(`[TelegramListener] queued: ${entry.id}`);

        // Send immediate ack so principal knows message was received
        await sendReply(botToken, chatId, `✓ received — I'll respond shortly.`);
      }
    } catch (err) {
      if (closed) break;
      const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
      reconnectAttempt++;
      console.error(`[TelegramListener] poll failed (${err}), retrying in ${delay}ms (attempt ${reconnectAttempt})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  console.log('[TelegramListener] stopped');
}

async function sendReply(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[TelegramListener] sendReply failed:', err);
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; username?: string; first_name?: string };
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    text?: string;
  };
}

// Graceful shutdown
process.on('SIGINT', () => { console.log('[TelegramListener] SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[TelegramListener] SIGTERM'); process.exit(0); });

main().catch(err => { console.error(err); process.exit(1); });
