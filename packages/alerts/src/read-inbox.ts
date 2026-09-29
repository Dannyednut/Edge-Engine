/**
 * read-inbox — reads unprocessed messages from /tmp/telegram-inbox.jsonl,
 * marks them processed, and prints them so the orchestrator can respond.
 *
 * Usage: pnpm --filter @edge/alerts read-inbox
 *
 * Output: one JSON object per unprocessed message, then exits.
 * The orchestrator reads this output, composes replies, and sends them
 * via TelegramAlerter.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { InboxEntry } from './listener.ts';

const INBOX_PATH = '/tmp/telegram-inbox.jsonl';

async function main() {
  if (!existsSync(INBOX_PATH)) {
    console.log('[]');
    return;
  }

  const lines = readFileSync(INBOX_PATH, 'utf8').split('\n').filter(Boolean);
  const entries: InboxEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as InboxEntry);
    } catch { /* skip malformed */ }
  }

  const unprocessed = entries.filter(e => !e.processed);
  const processed = entries.map(e => ({ ...e, processed: true }));

  // Mark all as processed
  writeFileSync(INBOX_PATH, processed.map(e => JSON.stringify(e)).join('\n') + '\n');

  // Output unprocessed messages
  console.log(JSON.stringify(unprocessed, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
