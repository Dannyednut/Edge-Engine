/**
 * Enterprise Package — implements the enterprise structure
 *
 * Modules:
 *   - operations/operations-manager: Daily cycle + process supervision
 *   - risk/risk-manager: Risk limits + enforcement
 *   - client/client-manager: Client tiers + vault/SaaS/SDK management
 *   - reporting/report-generator: Daily/monthly/vault reports
 */

export { loadState, saveState, ensureProcessesRunning, checkInbox, getProcessStatus } from './operations/operations-manager.js';
export { RISK_LIMITS, canTrade, checkPositionSize, checkTotalExposure, checkConcurrentPositions, recordPosition, closePosition, checkDrawdown, checkKhypeLiquidation, resetDaily, resetWeekly, getRiskStatus } from './risk/risk-manager.js';
export { registerClient, recordDeposit, recordWithdrawal, calculatePerformanceFee, getClientsByTier, getVaultStats, getSaasStats, getSdkStats, generateVaultReport, getClientDashboard } from './client/client-manager.js';
export { generateDailyReport, generateMonthlyReport } from './reporting/report-generator.js';
