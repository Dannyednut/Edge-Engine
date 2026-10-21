import { describe, it, expect } from 'vitest';
import { RwaTreasuryScanner } from '../src/strategies/rwa-treasury-scanner.js';
// EM-STRAT-006 §2: register offline mocks so scan() does NOT call live API.
import "./_setup/offline-mocks.js";

describe('RwaTreasuryScanner', () => {
  it('implements Strategy interface', () => {
    const scanner = new RwaTreasuryScanner({ minTvlUsd: 1_000_000, includeInstitutionalCredit: true });
    expect(scanner.id).toBe('rwa_treasury');
    expect(scanner.landscape).toBe('F_perps_funding');
  });

  it('riskParams returns valid params', () => {
    const scanner = new RwaTreasuryScanner({ minTvlUsd: 1_000_000, includeInstitutionalCredit: true });
    const params = scanner.riskParams();
    expect(params.maxSizeUsd).toBe(1_000_000);
    expect(params.maxConcurrent).toBe(5);
  });

  it('scan returns array', async () => {
    const scanner = new RwaTreasuryScanner({ minTvlUsd: 10_000_000, includeInstitutionalCredit: true });
    const results = await scanner.scan();
    expect(Array.isArray(results)).toBe(true);
  }, 15000);
});
