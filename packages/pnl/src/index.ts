/**
 * @edge/pnl — SQLite-backed PnL ledger + position tracker.
 *
 * Uses node:sqlite (built-in to Node 22+) — no native build deps required.
 *
 * Schema:
 *   - pnl_entries         : every fill / revert / close
 *   - open_positions      : current open positions (one row per opportunity)
 *   - risk_state          : single-row table with daily_loss, cooldown_until, etc.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PnlEntry, RiskEnvelope } from '@edge/types';

export interface PnlDbOptions {
  path: string;             // path to sqlite file
  risk: RiskEnvelope;
}

export class PnlDb {
  private readonly db: DatabaseSync;
  private readonly risk: RiskEnvelope;

  constructor(opts: PnlDbOptions) {
    mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.risk = opts.risk;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pnl_entries (
        id              TEXT PRIMARY KEY,
        ts              INTEGER NOT NULL,
        strategy_id     TEXT NOT NULL,
        opportunity_id  TEXT NOT NULL,
        legs_json       TEXT NOT NULL,
        realized_usd    REAL NOT NULL,
        gas_usd         REAL NOT NULL DEFAULT 0,
        fees_usd        REAL NOT NULL DEFAULT 0,
        status          TEXT NOT NULL,
        tx_hashes_json  TEXT,
        notes           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pnl_ts        ON pnl_entries(ts);
      CREATE INDEX IF NOT EXISTS idx_pnl_strategy  ON pnl_entries(strategy_id);
      CREATE INDEX IF NOT EXISTS idx_pnl_status    ON pnl_entries(status);

      CREATE TABLE IF NOT EXISTS open_positions (
        opportunity_id  TEXT PRIMARY KEY,
        strategy_id     TEXT NOT NULL,
        opened_ts       INTEGER NOT NULL,
        legs_json       TEXT NOT NULL,
        cost_basis_usd  REAL NOT NULL,
        current_value_usd REAL,
        unrealized_usd  REAL,
        last_update_ts  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_state (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        daily_loss_usd      REAL NOT NULL DEFAULT 0,
        daily_loss_reset_ts INTEGER NOT NULL,
        cooldown_until_ts   INTEGER NOT NULL DEFAULT 0,
        kill_switch_active  INTEGER NOT NULL DEFAULT 0,
        kill_switch_reason  TEXT
      );
      INSERT OR IGNORE INTO risk_state (id, daily_loss_usd, daily_loss_reset_ts) VALUES (1, 0, strftime('%s','now') * 1000);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ─── PnL entries ───────────────────────────────────────────────────

  record(entry: PnlEntry): void {
    this.db.prepare(`
      INSERT INTO pnl_entries (id, ts, strategy_id, opportunity_id, legs_json, realized_usd, gas_usd, fees_usd, status, tx_hashes_json, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.ts, entry.strategyId, entry.opportunityId,
      JSON.stringify(entry.legs), entry.realizedUsd, entry.gasUsd, entry.feesUsd,
      entry.status,
      entry.txHashes ? JSON.stringify(entry.txHashes) : null,
      entry.notes ?? null,
    );

    // If this is a loss (realized < 0), update daily_loss
    if (entry.realizedUsd < 0) {
      this.bumpDailyLoss(-entry.realizedUsd);
    }
  }

  // ─── Daily PnL ──────────────────────────────────────────────────────

  /** Returns the current daily PnL (negative = loss). */
  getDailyPnl(): number {
    const cutoff = this.getDailyResetTs();
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(realized_usd), 0) AS total
      FROM pnl_entries
      WHERE ts >= ? AND status IN ('filled', 'closed', 'reverted', 'failed')
    `);
    const row = stmt.get(cutoff) as { total: number };
    return row.total;
  }

  getDailyResetTs(): number {
    const row = this.db.prepare(`SELECT daily_loss_reset_ts FROM risk_state WHERE id = 1`).get(0) as { daily_loss_reset_ts: number };
    // Reset daily PnL if 24h have passed
    const now = Date.now();
    if (now - row.daily_loss_reset_ts > 24 * 60 * 60 * 1000) {
      this.db.prepare(`UPDATE risk_state SET daily_loss_usd = 0, daily_loss_reset_ts = ? WHERE id = 1`).run(now);
      return now;
    }
    return row.daily_loss_reset_ts;
  }

  /** Returns the absolute USD loss accumulated in the current 24h window. */
  getDailyLossAbs(): number {
    return Math.abs(Math.min(this.getDailyPnl(), 0));
  }

  /** Returns true if daily loss cap is exceeded. */
  isDailyLossCapHit(): boolean {
    return this.getDailyLossAbs() >= this.risk.maxDailyLossUsd;
  }

  private bumpDailyLoss(lossUsd: number): void {
    this.getDailyResetTs();   // ensures reset if 24h passed
    this.db.prepare(`UPDATE risk_state SET daily_loss_usd = daily_loss_usd + ? WHERE id = 1`).run(lossUsd);
  }

  // ─── Cooldown ───────────────────────────────────────────────────────

  getCooldownUntil(): number {
    const row = this.db.prepare(`SELECT cooldown_until_ts FROM risk_state WHERE id = 1`).get(0) as { cooldown_until_ts: number };
    return row.cooldown_until_ts;
  }

  isCooldownActive(): boolean {
    return Date.now() < this.getCooldownUntil();
  }

  startCooldown(durationMs: number): void {
    const until = Date.now() + durationMs;
    this.db.prepare(`UPDATE risk_state SET cooldown_until_ts = ? WHERE id = 1`).run(until);
  }

  // ─── Kill switch ────────────────────────────────────────────────────

  isKillSwitchActive(): boolean {
    const row = this.db.prepare(`SELECT kill_switch_active FROM risk_state WHERE id = 1`).get(0) as { kill_switch_active: number };
    return row.kill_switch_active === 1;
  }

  getKillSwitchReason(): string | null {
    const row = this.db.prepare(`SELECT kill_switch_reason FROM risk_state WHERE id = 1`).get(0) as { kill_switch_reason: string | null };
    return row.kill_switch_reason;
  }

  activateKillSwitch(reason: string): void {
    this.db.prepare(`UPDATE risk_state SET kill_switch_active = 1, kill_switch_reason = ? WHERE id = 1`).run(reason);
  }

  deactivateKillSwitch(): void {
    this.db.prepare(`UPDATE risk_state SET kill_switch_active = 0, kill_switch_reason = NULL WHERE id = 1`).run();
  }

  // ─── Open positions ─────────────────────────────────────────────────

  openPosition(p: {
    opportunityId: string;
    strategyId: string;
    legs: PnlEntry['legs'];
    costBasisUsd: number;
  }): void {
    this.db.prepare(`
      INSERT INTO open_positions (opportunity_id, strategy_id, opened_ts, legs_json, cost_basis_usd, last_update_ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(opportunity_id) DO UPDATE SET last_update_ts = excluded.last_update_ts
    `).run(p.opportunityId, p.strategyId, Date.now(), JSON.stringify(p.legs), p.costBasisUsd, Date.now());
  }

  closePosition(opportunityId: string): void {
    this.db.prepare(`DELETE FROM open_positions WHERE opportunity_id = ?`).run(opportunityId);
  }

  countOpenPositions(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM open_positions`).get(0) as { n: number };
    return row.n;
  }

  listOpenPositions(): Array<{ opportunityId: string; strategyId: string; openedTs: number; costBasisUsd: number; legs: PnlEntry['legs'] }> {
    const rows = this.db.prepare(`SELECT opportunity_id, strategy_id, opened_ts, cost_basis_usd, legs_json FROM open_positions`).all() as Array<{
      opportunity_id: string; strategy_id: string; opened_ts: number; cost_basis_usd: number; legs_json: string;
    }>;
    return rows.map(r => ({
      opportunityId: r.opportunity_id,
      strategyId: r.strategy_id,
      openedTs: r.opened_ts,
      costBasisUsd: r.cost_basis_usd,
      legs: JSON.parse(r.legs_json),
    }));
  }

  // ─── Reports ────────────────────────────────────────────────────────

  getPnlSince(ts: number): { total: number; byStrategy: Record<string, number> } {
    const totalRow = this.db.prepare(`
      SELECT COALESCE(SUM(realized_usd), 0) AS total
      FROM pnl_entries WHERE ts >= ? AND status IN ('filled', 'closed')
    `).get(ts) as { total: number };
    const stratRows = this.db.prepare(`
      SELECT strategy_id, COALESCE(SUM(realized_usd), 0) AS total
      FROM pnl_entries WHERE ts >= ? AND status IN ('filled', 'closed')
      GROUP BY strategy_id
    `).all(ts) as Array<{ strategy_id: string; total: number }>;
    const byStrategy: Record<string, number> = {};
    for (const r of stratRows) byStrategy[r.strategy_id] = r.total;
    return { total: totalRow.total, byStrategy };
  }

  getRecentEntries(limit = 50): PnlEntry[] {
    const rows = this.db.prepare(`SELECT * FROM pnl_entries ORDER BY ts DESC LIMIT ?`).all(limit) as Array<{
      id: string; ts: number; strategy_id: string; opportunity_id: string;
      legs_json: string; realized_usd: number; gas_usd: number; fees_usd: number;
      status: string; tx_hashes_json: string | null; notes: string | null;
    }>;
    return rows.map(r => ({
      id: r.id, ts: r.ts, strategyId: r.strategy_id, opportunityId: r.opportunity_id,
      legs: JSON.parse(r.legs_json), realizedUsd: r.realized_usd, gasUsd: r.gas_usd,
      feesUsd: r.fees_usd, status: r.status as PnlEntry['status'],
      txHashes: r.tx_hashes_json ? JSON.parse(r.tx_hashes_json) : undefined,
      notes: r.notes ?? undefined,
    }));
  }
}
