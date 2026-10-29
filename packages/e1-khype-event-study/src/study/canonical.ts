/**
 * EM-STRAT-014-E1 — canonical JSON serialization.
 *
 * Canonical form rules (all deterministic, no hidden state):
 *   - Object keys sorted lexicographically (unicode code-point order).
 *   - Arrays keep their (already deterministic) order.
 *   - Strings JSON-escaped via JSON.stringify semantics.
 *   - Numbers must be safe integers (Anything else must be pre-serialized
 *     as a string — the study never emits floats, and BigInts are
 *     stringified by the builders, not here; this function THROWS on
 *     BigInt/float to enforce that discipline at the boundary).
 *   - No whitespace, no trailing newline inside this function (the CLI
 *     appends exactly one '\n').
 */

export function canonicalJsonString(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value === true ? 'true' : 'false';
  if (t === 'number') {
    const n = value as number;
    if (!Number.isSafeInteger(n)) {
      throw new Error(`canonicalJson:non-safe-integer-number:${String(n)} — serialize as string`);
    }
    return String(n);
  }
  if (t === 'bigint') {
    throw new Error('canonicalJson:bigint-not-allowed — stringify before canonicalization');
  }
  if (t === 'string') return JSON.stringify(value as string);
  if (Array.isArray(value)) {
    return '[' + value.map(v => serialize(v)).join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // undefined fields are omitted, deterministically
      parts.push(`${JSON.stringify(k)}:${serialize(v)}`);
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJson:unsupported-type:${t}`);
}
