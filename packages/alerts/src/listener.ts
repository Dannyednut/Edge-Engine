/**
 * TelegramListener — long-polling listener for incoming Telegram messages.
 *
 * Runs alongside the scanner. Listens for messages from the principal via
 * getUpdates long-polling (no webhook needed). Routes commands and echoes
 * non-command messages back so the principal knows they're heard.
 *
 * Usage:
 *   pnpm --filter @edge/alerts listen
 *
 * Commands (principal can text these to @sea_crests_bot):
 *   /help     — list commands
 *   /status   — current scanner + risk state
 *   /pause    — activate kill switch (pauses all execution)
 *   /resume   — deactivate kill switch
 *   /scan     — trigger an immediate one-shot scan + report
 *   /echo <text> — echo back (test that listener is alive)
 *
 * Non-command messages: echoed back with "heard: " prefix so principal
 * knows the agent is listening.
 *
 * Architecture:
 *   - Long-poll with 60s timeout (Telegram supports up to 50s; we use 30s
 *     to allow graceful shutdown)
 *   - Track update_id offset so we don't reprocess old messages on restart
 *   - Auto-reconnect on network errors with backoff
 *   - Graceful SIGINT/SIGTERM handling
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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

export interface TelegramListenerOptions {
  botToken: string;
  chatId: string;            // only respond to messages from this chat
  /** Command handlers — key is the command (without /), e.g. 'status'. */
  handlers?: Record<string, (args: string, chatId: string) => Promise<string>>;
  /** Called for non-command messages. Default: echo back. */
  onMessage?: (text: string, chatId: string) => Promise<string>;
}

export class TelegramListener {
  private offset = 0;
  private closed = false;
  private reconnectAttempt = 0;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly handlers: Record<string, (args: string, chatId: string) => Promise<string>>;
  private readonly onMessage: (text: string, chatId: string) => Promise<string>;

  constructor(opts: TelegramListenerOptions) {
    if (!opts.botToken) throw new Error('TelegramListener: botToken required');
    if (!opts.chatId)   throw new Error('TelegramListener: chatId required');
    this.botToken = opts.botToken;
    this.chatId   = opts.chatId;
    this.handlers = opts.handlers ?? {};
    this.onMessage = opts.onMessage ?? (async (text) => `heard: ${text}`);
  }

  /** Start the long-poll loop. Blocks until close() is called. */
  async start(): Promise<void> {
    console.log(`[TelegramListener] started — listening for messages from chat ${this.chatId}`);
    console.log(`[TelegramListener] bot: ${this.botToken.slice(0, 12)}...${this.botToken.slice(-6)}`);

    // First, delete any pending updates so we don't replay old messages
    try {
      await this.callApi('getUpdates', { offset: -1, limit: 1, timeout: 0 });
      console.log('[TelegramListener] cleared pending updates');
    } catch (err) {
      console.warn('[TelegramListener] failed to clear pending updates:', err);
    }

    while (!this.closed) {
      try {
        await this.pollOnce();
        this.reconnectAttempt = 0;
      } catch (err) {
        if (this.closed) break;
        const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
        this.reconnectAttempt++;
        console.error(`[TelegramListener] poll failed (${err}), retrying in ${delay}ms (attempt ${this.reconnectAttempt})`);
        await sleep(delay);
      }
    }
    console.log('[TelegramListener] stopped');
  }

  /** Stop the listener. */
  close(): void {
    this.closed = true;
  }

  private async pollOnce(): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/getUpdates`;
    const body = JSON.stringify({
      offset: this.offset,
      limit: 100,
      timeout: LONG_POLL_TIMEOUT_SEC,
      allowed_updates: ['message'],
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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
    const updates = json.result ?? [];
    for (const update of updates) {
      this.offset = update.update_id + 1;
      await this.handleUpdate(update);
    }
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    // Only respond to messages from the principal's chat
    const chatId = String(msg.chat.id);
    if (chatId !== this.chatId) {
      console.log(`[TelegramListener] ignoring message from unauthorized chat ${chatId}`);
      return;
    }

    const text = msg.text.trim();
    const fromUser = msg.from?.username ?? msg.from?.first_name ?? 'unknown';
    console.log(`[TelegramListener] received from ${fromUser}: ${text}`);

    // Check if it's a command
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase().split('@')[0];  // strip @botname suffix
      const args = parts.slice(1).join(' ');
      await this.handleCommand(cmd, args, chatId);
    } else {
      // Non-command message — echo back
      try {
        const reply = await this.onMessage(text, chatId);
        if (reply) await this.sendReply(chatId, reply);
      } catch (err) {
        console.error('[TelegramListener] onMessage handler failed:', err);
      }
    }
  }

  private async handleCommand(cmd: string, args: string, chatId: string): Promise<void> {
    const handler = this.handlers[cmd];
    if (!handler) {
      await this.sendReply(chatId, `Unknown command: /${cmd}\nType /help for available commands.`);
      return;
    }
    try {
      const reply = await handler(args, chatId);
      if (reply) await this.sendReply(chatId, reply);
    } catch (err) {
      console.error(`[TelegramListener] command /${cmd} failed:`, err);
      await this.sendReply(chatId, `Command /${cmd} failed: ${String(err).slice(0, 200)}`);
    }
  }

  private async sendReply(chatId: string, text: string): Promise<void> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[TelegramListener] sendReply ${res.status}: ${errText.slice(0, 200)}`);
    }
  }

  private async callApi(method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${method} ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json();
  }
}

// ─── Types ─────────────────────────────────────────────────────────────

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; title?: string; username?: string; first_name?: string };
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    text?: string;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Default command handlers ──────────────────────────────────────────

export function makeDefaultHandlers(opts: {
  getStatus?: () => Promise<string>;
  onPause?: () => Promise<void>;
  onResume?: () => Promise<void>;
  onScan?: () => Promise<string>;
}): Record<string, (args: string, chatId: string) => Promise<string>> {
  return {
    help: async () => [
      'Available commands:',
      '  /help     — list commands',
      '  /status   — current scanner + risk state',
      '  /pause    — activate kill switch (pauses all execution)',
      '  /resume   — deactivate kill switch',
      '  /scan     — trigger immediate one-shot scan + report',
      '  /echo <text> — echo back (test listener)',
      '',
      'Non-command messages are echoed back so you know I heard you.',
    ].join('\n'),

    status: async () => {
      if (opts.getStatus) return await opts.getStatus();
      return 'Status: listener alive. Scanner state unknown (no getStatus handler wired).';
    },

    pause: async () => {
      if (opts.onPause) await opts.onPause();
      return 'Kill switch activated. All execution paused. Type /resume to restart.';
    },

    resume: async () => {
      if (opts.onResume) await opts.onResume();
      return 'Kill switch deactivated. Execution resumed.';
    },

    scan: async () => {
      if (opts.onScan) return await opts.onScan();
      return 'Scan: no onScan handler wired.';
    },

    echo: async (args) => `echo: ${args || '(empty)'}`,

    start: async () => 'Edge-Engine bot online. Type /help for commands.',
  };
}

// ─── Standalone runner ─────────────────────────────────────────────────

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in .env');
    process.exit(1);
  }

  const listener = new TelegramListener({
    botToken,
    chatId,
    handlers: makeDefaultHandlers({
      getStatus: async () => {
        const now = new Date().toISOString();
        return `Listener alive at ${now}\nBot: @sea_crests_bot\nChat: ${chatId}\nScanner: run separately via 'pnpm --filter @edge/scanner start:all'`;
      },
    }),
    onMessage: async (text) => {
      console.log(`[echo] ${text}`);
      return `heard: ${text}`;
    },
  });

  process.on('SIGINT', () => { listener.close(); });
  process.on('SIGTERM', () => { listener.close(); });

  await listener.start();
}

// Run if invoked directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
