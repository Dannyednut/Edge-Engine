/**
 * Client Management Framework
 *
 * Implements client tiers from Enterprise_Structure_Manual.md
 *
 * Tier 1: Principal (Owner) — full access
 * Tier 2: Vault Depositors — 10-20% performance fee
 * Tier 3: SaaS Subscribers — free / $50/mo / $5k/mo
 * Tier 4: Builder Code SDK Users — free, earn rebates
 *
 * This module manages:
 *   - Client registration
 *   - Tier-based access control
 *   - Deposit/withdrawal tracking
 *   - Performance fee calculation
 *   - Reporting
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const CLIENT_DB_FILE = '/home/z/my-project/download/client-database.json';

export type ClientTier = 'principal' | 'vault_depositor' | 'saas_free' | 'saas_pro' | 'saas_enterprise' | 'sdk_user';

export interface Client {
  id: string;
  tier: ClientTier;
  name: string;
  email?: string;
  telegramId?: string;
  walletAddress?: string;
  registeredAt: number;
  // Vault depositor fields
  depositUsd?: number;
  depositDate?: number;
  performanceFeePct?: number;
  // SaaS fields
  subscriptionStatus?: 'active' | 'cancelled' | 'past_due';
  subscriptionStart?: number;
  subscriptionEnd?: number;
  monthlyFee?: number;
  // SDK user fields
  builderCodeRevenue?: number;
  // All tiers
  lastReportSent?: number;
  notes?: string;
}

interface ClientDatabase {
  clients: Client[];
  vaultStats: {
    totalAum: number;
    totalDepositors: number;
    totalFeesEarned: number;
    vaultCreatedAt: number | null;
  };
  saasStats: {
    totalSubscribers: number;
    monthlyRecurringRevenue: number;
  };
  sdkStats: {
    totalUsers: number;
    totalBuilderCodeRevenue: number;
  };
}

function loadDb(): ClientDatabase {
  if (existsSync(CLIENT_DB_FILE)) {
    return JSON.parse(readFileSync(CLIENT_DB_FILE, 'utf8'));
  }
  return {
    clients: [],
    vaultStats: { totalAum: 0, totalDepositors: 0, totalFeesEarned: 0, vaultCreatedAt: null },
    saasStats: { totalSubscribers: 0, monthlyRecurringRevenue: 0 },
    sdkStats: { totalUsers: 0, totalBuilderCodeRevenue: 0 },
  };
}

function saveDb(db: ClientDatabase) {
  writeFileSync(CLIENT_DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * Register a new client
 */
export function registerClient(client: Omit<Client, 'id' | 'registeredAt'>): Client {
  const db = loadDb();
  const newClient: Client = {
    ...client,
    id: `client_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    registeredAt: Date.now(),
  };
  db.clients.push(newClient);

  // Update stats
  if (newClient.tier === 'vault_depositor') {
    db.vaultStats.totalDepositors++;
    db.vaultStats.totalAum += newClient.depositUsd || 0;
  } else if (newClient.tier.startsWith('saas_')) {
    db.saasStats.totalSubscribers++;
    db.saasStats.monthlyRecurringRevenue += newClient.monthlyFee || 0;
  } else if (newClient.tier === 'sdk_user') {
    db.sdkStats.totalUsers++;
  }

  saveDb(db);
  return newClient;
}

/**
 * Record a vault deposit
 */
export function recordDeposit(clientId: string, amountUsd: number): Client | null {
  const db = loadDb();
  const client = db.clients.find(c => c.id === clientId);
  if (!client || client.tier !== 'vault_depositor') return null;

  client.depositUsd = (client.depositUsd || 0) + amountUsd;
  client.depositDate = Date.now();
  db.vaultStats.totalAum += amountUsd;
  saveDb(db);
  return client;
}

/**
 * Record a vault withdrawal
 */
export function recordWithdrawal(clientId: string, amountUsd: number): Client | null {
  const db = loadDb();
  const client = db.clients.find(c => c.id === clientId);
  if (!client || client.tier !== 'vault_depositor') return null;

  client.depositUsd = Math.max(0, (client.depositUsd || 0) - amountUsd);
  db.vaultStats.totalAum = Math.max(0, db.vaultStats.totalAum - amountUsd);
  saveDb(db);
  return client;
}

/**
 * Calculate performance fee for a vault depositor
 */
export function calculatePerformanceFee(clientId: string, profitUsd: number): number {
  const db = loadDb();
  const client = db.clients.find(c => c.id === clientId);
  if (!client || client.tier !== 'vault_depositor') return 0;

  const feePct = client.performanceFeePct || 10;
  const fee = profitUsd * (feePct / 100);

  // Update stats
  db.vaultStats.totalFeesEarned += fee;
  saveDb(db);

  return fee;
}

/**
 * Get all clients by tier
 */
export function getClientsByTier(tier: ClientTier): Client[] {
  const db = loadDb();
  return db.clients.filter(c => c.tier === tier);
}

/**
 * Get vault statistics
 */
export function getVaultStats() {
  const db = loadDb();
  return db.vaultStats;
}

/**
 * Get SaaS statistics
 */
export function getSaasStats() {
  const db = loadDb();
  return db.saasStats;
}

/**
 * Get SDK statistics
 */
export function getSdkStats() {
  const db = loadDb();
  return db.sdkStats;
}

/**
 * Generate monthly report for a vault depositor
 */
export function generateVaultReport(clientId: string, monthlyProfit: number): string {
  const db = loadDb();
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return 'Client not found';

  const fee = calculatePerformanceFee(clientId, monthlyProfit);
  const clientShare = monthlyProfit - fee;
  const roi = ((clientShare / (client.depositUsd || 1)) * 100).toFixed(2);

  return [
    `═══ Monthly Vault Report ═══`,
    `Client: ${client.name}`,
    `Tier: Vault Depositor`,
    `Date: ${new Date().toISOString().substring(0, 10)}`,
    '',
    `Deposit: $${(client.depositUsd || 0).toLocaleString()}`,
    `Monthly Profit: $${monthlyProfit.toFixed(2)}`,
    `Performance Fee (${client.performanceFeePct || 10}%): $${fee.toFixed(2)}`,
    `Your Share: $${clientShare.toFixed(2)}`,
    `ROI: ${roi}%`,
    '',
    `Vault Total AUM: $${db.vaultStats.totalAum.toLocaleString()}`,
    `Total Depositors: ${db.vaultStats.totalDepositors}`,
    '',
    `Withdrawal: 7-day queue after request.`,
    `Questions? Contact via Telegram.`,
  ].join('\n');
}

/**
 * Get client dashboard data
 */
export function getClientDashboard(): string {
  const db = loadDb();
  return [
    '═══ Client Management Dashboard ═══',
    '',
    '── Vault Statistics ──',
    `  Total AUM: $${db.vaultStats.totalAum.toLocaleString()}`,
    `  Total Depositors: ${db.vaultStats.totalDepositors}`,
    `  Total Fees Earned: $${db.vaultStats.totalFeesEarned.toFixed(2)}`,
    `  Vault Created: ${db.vaultStats.vaultCreatedAt ? new Date(db.vaultStats.vaultCreatedAt).toISOString() : 'Not yet'}`,
    '',
    '── SaaS Statistics ──',
    `  Total Subscribers: ${db.saasStats.totalSubscribers}`,
    `  Monthly Recurring Revenue: $${db.saasStats.monthlyRecurringRevenue.toLocaleString()}/mo`,
    `  Annual Run Rate: $${(db.saasStats.monthlyRecurringRevenue * 12).toLocaleString()}/yr`,
    '',
    '── SDK Statistics ──',
    `  Total SDK Users: ${db.sdkStats.totalUsers}`,
    `  Total Builder Code Revenue: $${db.sdkStats.totalBuilderCodeRevenue.toFixed(2)}`,
    '',
    '── Client Breakdown ──',
    `  Principal: ${db.clients.filter(c => c.tier === 'principal').length}`,
    `  Vault Depositors: ${db.clients.filter(c => c.tier === 'vault_depositor').length}`,
    `  SaaS Free: ${db.clients.filter(c => c.tier === 'saas_free').length}`,
    `  SaaS Pro: ${db.clients.filter(c => c.tier === 'saas_pro').length}`,
    `  SaaS Enterprise: ${db.clients.filter(c => c.tier === 'saas_enterprise').length}`,
    `  SDK Users: ${db.clients.filter(c => c.tier === 'sdk_user').length}`,
  ].join('\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(getClientDashboard());
}
