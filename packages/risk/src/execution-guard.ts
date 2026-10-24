/**
 * Execution authorization guard — Phase-0 containment (EM-STRAT-012).
 *
 * A single shared, fail-closed gate that must pass before any risk-increasing
 * submission, signer/client construction that can enable submission, or bot
 * start. Checked at the SINK level (inside the method that submits) so direct
 * imports or direct method calls cannot bypass it; script entrypoints add
 * defense-in-depth checks at their live-transition points.
 *
 * DESIGN — this is an accident-prevention control, NOT proof of identity or
 * authority. A plain environment variable does not cryptographically
 * authenticate the Principal. Actual permission to execute requires a separate,
 * explicit Principal decision; this gate only prevents ACCIDENTAL execution.
 *
 * Configuration: the `EDGE_EXECUTION_AUTH` environment variable holds a
 * JSON-encoded authorization descriptor. The descriptor must be supplied
 * explicitly through the process environment (e.g. `EDGE_EXECUTION_AUTH='...'
 * npx tsx ...`); it MUST NOT be persisted in `.env` or any other tracked
 * configuration file. Every `.env` loader in this repository explicitly
 * excludes `EDGE_EXECUTION_AUTH` (see packages/risk/src/dotenv-safety.ts).
 *
 *   {
 *     "authId":      "<opaque audit identifier, required, non-empty>",
 *     "expiresAtMs": <epoch ms, required, finite, must be in the future AND
 *                     no further than MAX_AUTH_LIFETIME_MS from now>,
 *     "scopes":      ["<scope>", ...]  // required, non-empty; every entry
 *                                      // must be a known ExecutionScope
 *   }
 *
 * Fail-closed rules — the guard DENIES when any of the following hold:
 *   - EDGE_EXECUTION_AUTH is unset or empty
 *   - the value is not valid JSON
 *   - authId is missing, empty, or not a string
 *   - expiresAtMs is missing, not a finite number, <= 0, in the past,
 *     OR further than MAX_AUTH_LIFETIME_MS in the future (relative to the
 *     injectable clock) — i.e. excessively long-lived authorizations are
 *     rejected, not just already-expired ones
 *   - scopes is missing, not an array, empty, or contains an unknown scope
 *   - the requested scope is not included in scopes
 *
 * The environment variable is read at CHECK time (not cached at import), so
 * removing or expiring the variable takes effect immediately. No enabled
 * configuration is ever persisted by this module.
 *
 * Audit logging: every decision logs scope, decision, timestamp, and
 * authorization identifier (or the denial reason). Credentials (private keys,
 * tokens, the raw env value) are never logged.
 *
 * Scopes are deliberately narrow: an authorization for one surface/action does
 * not enable any unrelated script or sink. See EXECUTION_SCOPES for the
 * canonical taxonomy and packages/scanner/test/execution-sink-census.test.ts
 * for the enforced inventory.
 */

// ─── Scope taxonomy ─────────────────────────────────────────────────────
//
// Two families:
//   entrypoint:<script>  — defense-in-depth gate at the script's live
//                          transition point (where the script moves from
//                          safe dry-run/preview mode to live-capable mode).
//   <client>:<action>    — sink-level gate inside the method that actually
//                          submits (the shared HTTP choke point or the
//                          sendTransaction call).

export const EXECUTION_SCOPES = [
  // Seven submission-capable script entrypoints (defense-in-depth layer)
  'entrypoint:khype-carry-executor',
  'entrypoint:euler-lending-executor',
  'entrypoint:funding-combined-runner',
  'entrypoint:vooi-arb-executor',
  'entrypoint:vooi-price-spread-executor',
  'entrypoint:vooi-create-bot',
  'entrypoint:go-live',

  // VOOI client sinks (shared HTTP choke point — risk-increasing mutations).
  // Phase-0.5 (work order D): the ungated close-intent exemption was REMOVED —
  // no authoritative VOOI documentation proves paired-leg reduce-only venue
  // semantics. Closing an arb position now requires the narrow
  // 'vooi:close-arbitrage-order' scope; that scope is validated against the
  // request body (both legs reduceOnly:true) and does NOT authorize opening
  // orders (enforced at both the wrapper and the transport layer).
  'vooi:place-arbitrage-order',
  'vooi:close-arbitrage-order',
  'vooi:create-bot',
  'vooi:start-bot',

  // Executor-level defense-in-depth (checked before the client sink is hit)
  'vooi-executor:execute-arb',
  'vooi-price-spread-executor:execute-opp',

  // EVM executor: eager signer construction + each submission method
  'evm-executor:construct-signer',
  'evm-executor:send-transaction',

  // Dormant client sinks (no current callers; guarded so they cannot be
  // silently adopted without authorization)
  'backpack-client:place-order',

  // PumpApi client sinks — every transaction-producing action method has its
  // own narrow scope (EM-STRAT-012 Phase-0 R1). claimCashback is deliberately
  // ungated (recovers owed cashback into the wallet; cannot open or increase
  // exposure) — see SAFETY-POSITIVE marker in packages/pumpapi-client/src/index.ts.
  // atomicTwoLegArb does NOT delegate through actions(); it calls #post()
  // directly so neither guard bypasses the other.
  'pumpapi-client:buy',
  'pumpapi-client:sell',
  'pumpapi-client:actions',
  'pumpapi-client:jito-bundle',
  'pumpapi-client:migrate',
  'pumpapi-client:burn',
  'pumpapi-client:wrap-sol',
  'pumpapi-client:transfer',
  'pumpapi-client:atomic-two-leg-arb',

  // Phase-0.5 (work order C): generatePumpWallet transmits key material
  // (a new wallet's secret, or an apiKey derived from an existing private
  // key) to the PumpApi wallet endpoint. Transmitting credentials to a
  // third party is a credential-exposure risk and is therefore fail-closed
  // gated like a submission sink, even though it does not move capital.
  'pumpapi-client:generate-wallet',
] as const;

export type ExecutionScope = (typeof EXECUTION_SCOPES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set<string>(EXECUTION_SCOPES);

/** The environment variable that carries the authorization descriptor. */
export const EXECUTION_AUTH_ENV_VAR = 'EDGE_EXECUTION_AUTH';

/**
 * Maximum lifetime of an authorization descriptor, measured from the moment
 * the guard is checked. An authorization whose `expiresAtMs` is further than
 * this many milliseconds in the future is rejected as excessively long-lived,
 * even if it is otherwise well-formed. This caps the blast radius of any
 * leaked or accidentally-set descriptor: even if a stale descriptor lingers
 * in the process environment, it cannot authorize execution for more than
 * one hour after it was issued.
 *
 * Rationale: Phase-0 containment is an accident-prevention control, not a
 * cryptographic identity proof. A 1-hour window is long enough for an
 * operator to perform a deliberate live-trading session, but short enough
 * that a forgotten/leaked descriptor becomes inert quickly. The clock is
 * injectable for deterministic tests.
 */
export const MAX_AUTH_LIFETIME_MS: number = 60 * 60 * 1000; // 1 hour

// ─── Error type ─────────────────────────────────────────────────────────

export class ExecutionNotAuthorizedError extends Error {
  constructor(
    public readonly scope: string,
    public readonly reason: string,
  ) {
    super(
      `Execution not authorized: scope "${scope}" denied (${reason}). ` +
      `This is a fail-closed containment gate — set ${EXECUTION_AUTH_ENV_VAR} ` +
      `with a valid scoped authorization descriptor to enable this action. ` +
      `Actual permission requires a separate, explicit Principal decision.`,
    );
    this.name = 'ExecutionNotAuthorizedError';
  }
}

// ─── Injectable clock (deterministic expiry tests) ──────────────────────

let nowFn: () => number = () => Date.now();

/** Replace the clock. For deterministic offline tests ONLY. */
export function setExecutionClockForTesting(fn: () => number): void {
  nowFn = fn;
}

/** Restore the default wall clock. */
export function resetExecutionClockForTesting(): void {
  nowFn = () => Date.now();
}

// ─── Audit log (no credentials) ─────────────────────────────────────────

let logFn: (msg: string) => void = (msg: string) => console.log(msg);

/** Replace the audit sink. For deterministic tests ONLY. */
export function setExecutionAuditLoggerForTesting(fn: (msg: string) => void): void {
  logFn = fn;
}

/** Restore the default console logger. */
export function resetExecutionAuditLoggerForTesting(): void {
  logFn = (msg: string) => console.log(msg);
}

// ─── Authorization descriptor parsing ───────────────────────────────────

export interface ExecutionAuthorization {
  authId: string;
  expiresAtMs: number;
  scopes: ExecutionScope[];
}

export type ExecutionAuthParseResult =
  | { ok: true; auth: ExecutionAuthorization }
  | { ok: false; reason: string };

/**
 * Non-throwing authorization check (Phase-0.5).
 *
 * Returns true ONLY when the same conditions that make
 * `assertExecutionAuthorized(scope)` pass hold right now: a valid, unexpired,
 * within-max-lifetime descriptor whose scopes include `scope`. Returns false
 * otherwise (and logs the denial, same as the throwing variant).
 *
 * Purpose: transport-layer action classification inside client classes needs
 * to test "is scope A authorized? … else is scope B authorized (with extra
 * body validation)?" without try/catch around a throwing API. It is NOT a
 * softer variant of the guard — callers that only need "allow or throw" must
 * keep using `assertExecutionAuthorized`, which fails closed in one call.
 */
export function isExecutionAuthorized(scope: ExecutionScope): boolean {
  // An unknown scope is a PROGRAMMING ERROR, not a denial: re-check the
  // taxonomy OUTSIDE the try/catch so a typo'd scope throws from this
  // entry point too (silently returning false would hide the bug).
  if (!KNOWN_SCOPES.has(scope)) {
    throw new ExecutionNotAuthorizedError(scope, 'unknown scope (not in EXECUTION_SCOPES taxonomy)');
  }
  try {
    assertExecutionAuthorized(scope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and validate a raw authorization descriptor.
 * Exported for the census/tests; the guard itself calls this internally.
 *
 * `nowMs` is the injectable-clock value used for both the expiry check and
 * the maximum-lifetime check.
 */
export function parseExecutionAuthorization(
  raw: string | undefined | null,
  nowMs: number,
): ExecutionAuthParseResult {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return { ok: false, reason: `${EXECUTION_AUTH_ENV_VAR} is not set` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'authorization descriptor is not valid JSON' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'authorization descriptor must be a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  const authId = obj.authId;
  if (typeof authId !== 'string' || authId.trim() === '') {
    return { ok: false, reason: 'authId is missing, empty, or not a string' };
  }

  const expiresAtMs = obj.expiresAtMs;
  if (
    typeof expiresAtMs !== 'number' ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= 0
  ) {
    return { ok: false, reason: 'expiresAtMs is missing, malformed, or non-positive' };
  }
  if (expiresAtMs <= nowMs) {
    return { ok: false, reason: `authorization expired at ${new Date(expiresAtMs).toISOString()}` };
  }
  // Maximum-lifetime check (EM-STRAT-012 Phase-0 R1): reject excessively
  // long-lived descriptors, not just already-expired ones. This prevents a
  // stale descriptor from authorizing execution far into the future.
  const lifetimeMs = expiresAtMs - nowMs;
  if (lifetimeMs > MAX_AUTH_LIFETIME_MS) {
    return {
      ok: false,
      reason: `authorization lifetime ${lifetimeMs}ms exceeds maximum ${MAX_AUTH_LIFETIME_MS}ms (expires ${new Date(expiresAtMs).toISOString()})`,
    };
  }

  const scopes = obj.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, reason: 'scopes is missing, empty, or not an array' };
  }
  for (const s of scopes) {
    if (typeof s !== 'string' || !KNOWN_SCOPES.has(s)) {
      return { ok: false, reason: `scopes contains an unknown scope: ${JSON.stringify(s)}` };
    }
  }

  return {
    ok: true,
    auth: {
      authId,
      expiresAtMs,
      scopes: scopes as ExecutionScope[],
    },
  };
}

// ─── The guard ──────────────────────────────────────────────────────────

/**
 * Assert that the given execution scope is authorized RIGHT NOW.
 *
 * Throws ExecutionNotAuthorizedError (fail-closed) unless:
 *   - EDGE_EXECUTION_AUTH contains a valid descriptor,
 *   - the descriptor has not expired (per the injectable clock),
 *   - the descriptor's lifetime does not exceed MAX_AUTH_LIFETIME_MS, and
 *   - the requested scope is listed in the descriptor's scopes.
 *
 * Check this immediately before every risk-increasing submission, signer
 * construction that can enable submission, or bot start. Re-checking at each
 * submission (rather than only at construction) ensures an existing instance
 * cannot submit after authorization expires.
 */
export function assertExecutionAuthorized(scope: ExecutionScope): void {
  if (!KNOWN_SCOPES.has(scope)) {
    // Programming error — an unknown scope can never be authorized.
    throw new ExecutionNotAuthorizedError(scope, 'unknown scope (not in EXECUTION_SCOPES taxonomy)');
  }
  // Implementation note (Phase-0.5): isExecutionAuthorized duplicates this
  // known-scope check OUTSIDE its try/catch so that an unknown scope THROWS
  // from both entry points rather than silently returning false (a typo'd
  // scope is a programming error, not a denial).

  const nowMs = nowFn();
  const parsed = parseExecutionAuthorization(process.env[EXECUTION_AUTH_ENV_VAR], nowMs);

  if (!parsed.ok) {
    logFn(
      `[execution-guard] scope="${scope}" decision=DENY ts=${new Date(nowMs).toISOString()} authId=none reason="${parsed.reason}"`,
    );
    throw new ExecutionNotAuthorizedError(scope, parsed.reason);
  }

  const { authId, expiresAtMs, scopes } = parsed.auth;

  if (!scopes.includes(scope)) {
    logFn(
      `[execution-guard] scope="${scope}" decision=DENY ts=${new Date(nowMs).toISOString()} authId="${authId}" reason="scope not in authorized set"`,
    );
    throw new ExecutionNotAuthorizedError(scope, 'scope not in authorized set');
  }

  logFn(
    `[execution-guard] scope="${scope}" decision=ALLOW ts=${new Date(nowMs).toISOString()} authId="${authId}" expires=${new Date(expiresAtMs).toISOString()}`,
  );
  // Allowed — caller proceeds with the risk-increasing action.
}
