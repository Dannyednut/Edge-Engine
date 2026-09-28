/**
 * @edge/alerts — Telegram-first alerting for the edge-engine.
 *
 * Severity → channel mapping:
 *   info        → telegram
 *   opportunity → telegram
 *   warning     → telegram
 *   critical    → telegram + email
 *   kill-switch → telegram + email + sms (future)
 */

import type { Alert, AlertSeverity } from '@edge/types';

const TELEGRAM_API = 'https://api.telegram.org';

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info:        'ℹ️',
  opportunity: '💎',
  warning:     '⚠️',
  critical:    '🚨',
  'kill-switch':'🛑',
};

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info:        'INFO',
  opportunity: 'OPPORTUNITY',
  warning:     'WARNING',
  critical:    'CRITICAL',
  'kill-switch':'KILL-SWITCH',
};

export interface TelegramAlerterOptions {
  botToken: string;
  chatId: string;
  /** Disable network calls (for tests). */
  dryRun?: boolean;
}

export class TelegramAlerter {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly dryRun: boolean;

  constructor(opts: TelegramAlerterOptions) {
    if (!opts.botToken) throw new Error('TelegramAlerter: botToken required');
    if (!opts.chatId)   throw new Error('TelegramAlerter: chatId required');
    this.botToken = opts.botToken;
    this.chatId   = opts.chatId;
    this.dryRun   = opts.dryRun ?? false;
  }

  /**
   * Send a plain text message.
   * Returns the Telegram `message_id` (or -1 for dry run).
   */
  async send(text: string): Promise<number> {
    if (this.dryRun) {
      console.log(`[telegram:dry-run] ${text}`);
      return -1;
    }
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;
    // Try Markdown first; if it fails, retry as plain text
    for (const parseMode of ['Markdown', undefined] as const) {
      const body = JSON.stringify({
        chat_id: this.chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        disable_web_page_preview: true,
      });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        const errText = await res.text();
        if (parseMode === 'Markdown' && res.status === 400) {
          // Markdown parse error — retry without parse_mode
          continue;
        }
        throw new Error(`Telegram sendMessage failed ${res.status}: ${errText}`);
      }
      const json = await res.json() as { ok: boolean; result?: { message_id: number }; description?: string };
      if (!json.ok) {
        throw new Error(`Telegram API returned !ok: ${json.description ?? 'unknown'}`);
      }
      return json.result?.message_id ?? -1;
    }
    throw new Error('Telegram sendMessage: exhausted parse mode fallbacks');
  }

  /** Send an Alert object, formatted for Telegram. */
  async sendAlert(alert: Alert): Promise<number> {
    const lines: string[] = [];
    lines.push(`${SEVERITY_EMOJI[alert.severity]} *${SEVERITY_LABEL[alert.severity]}* — ${alert.title}`);
    lines.push('');
    lines.push(alert.body);
    lines.push('');
    lines.push(`_${new Date(alert.ts).toISOString()}_`);
    if (alert.strategyId)    lines.push(`Strategy: \`${alert.strategyId}\``);
    if (alert.opportunityId) lines.push(`Opportunity: \`${alert.opportunityId}\``);
    return this.send(lines.join('\n'));
  }

  /** Quick helper to send a discovery / status message. */
  async info(title: string, body: string): Promise<number> {
    return this.sendAlert({
      id: `info_${Date.now()}`,
      ts: Date.now(),
      severity: 'info',
      title, body,
      channels: ['telegram'],
    });
  }

  async opportunity(title: string, body: string, strategyId?: string): Promise<number> {
    return this.sendAlert({
      id: `opp_${Date.now()}`,
      ts: Date.now(),
      severity: 'opportunity',
      title, body,
      strategyId,
      channels: ['telegram'],
    });
  }

  async killSwitch(reason: string): Promise<number> {
    return this.sendAlert({
      id: `kill_${Date.now()}`,
      ts: Date.now(),
      severity: 'kill-switch',
      title: 'KILL SWITCH ACTIVATED',
      body: reason,
      channels: ['telegram'],
    });
  }
}

// ─── Helpers to discover chat ID ───────────────────────────────────────

export async function getBotInfo(botToken: string): Promise<{ ok: boolean; result?: { id: number; username: string; first_name: string }; description?: string }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`);
  return res.json() as Promise<ReturnType<typeof getBotInfo> extends Promise<infer T> ? T : never>;
}

export async function getRecentUpdates(botToken: string, timeoutSec = 0): Promise<{ ok: boolean; result?: Array<{ update_id: number; message?: { chat: { id: number; first_name?: string; username?: string }; text?: string } }> }> {
  const url = `${TELEGRAM_API}/bot${botToken}/getUpdates${timeoutSec ? `?timeout=${timeoutSec}` : ''}`;
  const res = await fetch(url);
  return res.json() as Promise<ReturnType<typeof getRecentUpdates> extends Promise<infer T> ? T : never>;
}

export async function setWebhook(botToken: string, webhookUrl: string): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  });
  return res.json() as Promise<ReturnType<typeof setWebhook> extends Promise<infer T> ? T : never>;
}
