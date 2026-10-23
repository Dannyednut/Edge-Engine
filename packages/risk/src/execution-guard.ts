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
 * JSON-encoded authorization descriptor:
 *
 *   {
 *     "authId":      "<opaque audit identifier, required, non-empty>",
 *     "expiresAtMs": <epoch ms, required, finite, must be in the future>,
 *     "scopes":      ["<scope>", ...]  // required, non-empty; every entry
 *                                      // must be a known ExecutionScope
 *   }
 *
 * Fail-closed rules — the guard DENIES when any of the following hold:
 *   - EDGE_EXECUTION_AUTH is unset or empty
 *   - the value is not valid JSON
 *   - authId is missing, empty, or not a string
 *   - expiresAtMs is missing, not a finite number, <= 0, or in the past
 *     (relative to the injectable clock)
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

  // VOOI client sinks (shared HTTP choke point — risk-increasing mutations)
  'vooi:place-arbitrage-order',
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
  'pumpapi-client:atomic-two-leg-arb',
] as const;

export type ExecutionScope = (typeof EXECUTION_SCOPES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set<string>(EXECUTION_SCOPES);

/** The environment variable that carries the authorization descriptor. */
export const EXECUTION_AUTH_ENV_VAR = 'EDGE_EXECUTION_AUTH';

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
 * Parse and validate a raw authorization descriptor.
 * Exported for the census/tests; the guard itself calls this internally.
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
 *   - and the requested scope is listed in the descriptor's scopes.
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
