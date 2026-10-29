import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { EXECUTION_SCOPES } from '@edge/risk';

// ─── EM-STRAT-012 submission-sink census — Phase-0.5 expansion ─────────
//
// Offline CI test that scans the EXECUTABLE source tree for every submission
// sink and verifies each is either (a) guarded with the expected execution
// scope, (b) explicitly recorded as a safety-positive (risk-reducing)
// operation with its rationale marker, or (c) explicitly recorded as
// not-a-sink / dormant-signer with a rationale marker.
//
// Phase-0.5 (work order E) expansions:
//   - Scan boundary now covers packages/**/src/** AND scripts-explore/
//     (.ts/.mts/.tsx/.js/.mjs). Files mechanically archived under the
//     non-executable `*.quarantined` extension are NOT scanned (they cannot
//     run by ordinary invocation) — a dedicated test proves the extension is
//     skipped and that all 16 quarantined files are present.
//   - New sink/action coverage: direct Hyperliquid SDK submission methods
//     (.order / usdSend / usdClassTransfer / approveBuilderFee /
//     createUserVault / spotSend), raw POST /exchange submission calls,
//     Hyperliquid/EVM signer construction (new ExchangeClient,
//     createWalletClient, privateKeyToAccount), exposed signer-capable
//     properties (walletClient declarations NOT preceded by `#`), raw
//     transaction broadcast (eth_sendRawTransaction), and low-level
//     transport-helper definitions (async request/post).
//   - Every live-capable path maps to a guard at its actual sink or a
//     mechanically enforced quarantine. The scripts-explore disposition
//     manifest is enforced below (quarantined files must NOT exist under
//     their executable name).
//   - Reusable synthetic-sink tests exercise the SAME scan function CI runs
//     and prove detection of new sinks in both known and previously unknown
//     files, including ExchangeClient.order, raw POST /exchange, unguarded
//     walletClient.sendTransaction, and direct low-level request/post
//     attempts.
//
// EM-STRAT-012-R2 (work order A) expansions:
//   - Scan boundary now ALSO covers contracts/scripts/** (the executable
//     TypeScript of the contracts workspace). contracts/scripts/deploy.ts —
//     a live deployment path found by the EI adversarial review — is now a
//     guarded, inventoried entrypoint ('entrypoint:contracts-deploy').
//   - New sink pattern: deployContract (bare form catches both
//     client.deployContract(...) call sites and bare definitions), so a new
//     or unguarded deployment sink — including one in a previously unknown
//     file — fails CI (synthetic fixture below).
//   - VOOI venue reduce-only semantics remain UNPROVEN (EI finding
//     preserved per work order E4): no live probe or venue experiment is
//     authorized. The Phase-0.5 scoped-close design does not depend on
//     venue semantics: closing requires an explicit scope AND a
//     body-validated both-legs reduceOnly request, and the Backpack
//     reduce-only exemption was removed entirely (work order C).
//
// Deliberate exclusions (documented per EM-STRAT-012-R2 work order E):
//   - contracts/src/** and contracts/lib/** — Solidity sources and vendored
//     libraries; different language, no TypeScript submission surface, and
//     compiled artifacts rather than executable JS/TS. The EXECUTABLE
//     TypeScript deployment surface of the contracts workspace
//     (contracts/scripts/**) IS scanned as of EM-STRAT-012-R2 (work order
//     A): deploy.ts is a guarded, census-inventoried entrypoint, and a new
//     unguarded deployment sink anywhere under contracts/scripts/** fails
//     CI. The Solidity SOURCE STRINGS embedded in scripts-explore design
//     docs are inventoried as not-a-sink entries below
//     (ICoreWriter.placeOrder / IERC20.transfer inside template literals).
//   - contracts/build/** — compiled bytecode artifacts (JSON), not source.
//   - evidence/ — Python funding-carry harness; different language, own
//     offline-guard test suite (test_offline_guard.py).
//   - *.quarantined — mechanically archived source (cannot execute by
//     ordinary invocation; no launcher references them). The manifest test
//     below enforces that every archived file is present and that no
//     executable sibling exists.
//   - *.sh — shell supervisors/utilities. The only launcher
//     (scripts-explore/daemon-supervisor.sh) is separately asserted to
//     launch NO submission-capable script (see the DAEMONS check).
//   - test/ directories and __tests__/ — test sources (offline-guarded).
//   - dist/, node_modules/, *.d.ts — build output, dependencies, types.
//
// Method: narrowly scoped static scan. Comments (// lines and JSDoc
// continuation lines) are stripped before counting so documentation mentions
// of sink names do not produce false positives.
//
// KNOWN LIMITATIONS — accident-prevention scope only (EM-STRAT-012-R2 work
// order E2). This census is a regex-based tripwire that makes ACCIDENTAL
// unguarded sinks fail CI; it is NOT a proof that all possible runtime paths
// are mathematically covered. A regex scan cannot see through:
//   - dynamic dispatch (sink names resolved at runtime, e.g. obj[name]()),
//   - aliased/re-exported imports (sink reached under a different name),
//   - multiline construction (call arguments split so the name and paren
//     are on different lines — patterns match name+paren on one line),
//   - destructured signer extraction (const { deployContract } = wallet
//     then bare deployContract(...) — the bare form is patterned only for
//     deployContract, not for every SDK method).
// Deliberate human action can route around this scan; that is out of scope
// for an accident-prevention control (see the execution-guard design note:
// this is not proof of identity or authority). String literals that merely
// MENTION sink names are inventoried explicitly as not-a-sink entries
// rather than broadly allow-listed.

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PACKAGES_DIR = resolve(REPO_ROOT, 'packages');
const SCRIPTS_EXPLORE_DIR = resolve(REPO_ROOT, 'scripts-explore');
const CONTRACTS_SCRIPTS_DIR = resolve(REPO_ROOT, 'contracts', 'scripts');

// ─── Sink patterns ──────────────────────────────────────────────────────

interface SinkPattern {
  name: string;
  /** Regex for per-file inventory counts. */
  inventoryRegex: RegExp;
  /** Regex for the global uninventoried call-site scan. */
  globalRegex: RegExp;
}

function dotPattern(name: string): RegExp {
  return new RegExp(`\\.${name}\\(`, 'g');
}
function barePattern(name: string): RegExp {
  return new RegExp(`${name}\\(`, 'g');
}

function p(name: string, style: 'bare' | 'dot' = 'bare'): SinkPattern {
  return { name, inventoryRegex: barePattern(name), globalRegex: style === 'dot' ? dotPattern(name) : barePattern(name) };
}

// Non-call-shape patterns (substring / declaration shapes).
function rawPattern(name: string, regex: RegExp): SinkPattern {
  return { name, inventoryRegex: regex, globalRegex: regex };
}

const SINK_PATTERNS: SinkPattern[] = [
  // Unique-name submission sinks (bare).
  p('sendTransaction'),
  p('placeArbitrageOrder'),
  p('createBot'),
  p('startBot'),
  p('stopBot'),
  p('cancelArbitrageOrder'),
  p('deleteBot'),
  p('placeOrder'),
  p('atomicTwoLegArb'),
  p('jitoBundle'),
  p('claimCashback'),
  p('wrapSol'),
  p('migrate'),
  // Generic-name sinks — dot-prefixed in the global scan to avoid matching
  // unrelated occurrences in non-PumpApi files.
  p('buy', 'dot'),
  p('sell', 'dot'),
  p('actions', 'dot'),
  p('burn', 'dot'),
  p('transfer', 'dot'),
  // Hyperliquid SDK submission methods (Phase-0.5). All direct-SDK call
  // paths in scripts-explore were quarantined; these patterns catch any
  // resurrection or new adoption.
  p('usdSend'),
  p('usdClassTransfer'),
  p('approveBuilderFee'),
  p('createUserVault'),
  p('spotSend'),
  rawPattern('hlOrder', /\.order\(/g), // .order( — dot form only; bare 'order(' is too generic
  // Raw /exchange submission + raw broadcast (Phase-0.5).
  rawPattern('rawHlExchangePost', /api\.hyperliquid\.xyz\/exchange/g),
  rawPattern('eth_sendRawTransaction', /eth_sendRawTransaction/g),
  // Signer construction / signer-capable properties (Phase-0.5, work order A/E).
  rawPattern('newExchangeClient', /new ExchangeClient\(/g),
  p('createWalletClient'),
  p('privateKeyToAccount'),
  // EVM contract deployment broadcast (EM-STRAT-012-R2 work order A7):
  // walletClient.deployContract(...) — and any bare deployContract(
  // definition — is a real signed broadcast. Bare form so a deployment sink
  // in a previously unknown file fails the census.
  p('deployContract'),
  rawPattern('walletClientProperty', /(?<!#)\bwalletClient\b\s*[:=]/g),
  // Low-level transport-helper definitions (Phase-0.5, work order C):
  // flags `async request<...>(` / `async post<...>(` method definitions.
  // Hard-private `#request` / `#post` do NOT match (deliberately — the
  // inventoried helpers are hard-private; a re-introduced TS-private or
  // public transport method in an unknown file is flagged).
  rawPattern('transportDef', /async (?:request|post)\b[<(]/g),
  // CCXT submission sinks (EM-STRAT-014-B1): CexExecutor routes orders,
  // withdrawals and cancellations through a hard-private CCXT Exchange
  // instance. createOrder uses the bare form (catches the two guarded
  // wrapper call sites); withdraw/cancelOrder are dot-only — bare
  // 'withdraw(' would match ABI selector strings and Solidity template
  // docs (known false-positive classes), while the actual CCXT sink is
  // always reached as `exchange.withdraw(...)`. exposedExchangeProperty
  // flags any re-exposed (non-#) `exchange: Exchange`-typed property —
  // the direct bypass vector EM-STRAT-014-B1 removed.
  p('createOrder'),
  rawPattern('withdraw', /\.withdraw\(/g),
  rawPattern('cancelOrder', /\.cancelOrder\(/g),
  rawPattern('exposedExchangeProperty', /(?<!#)\bexchange\s*:\s*Exchange\b/g),
];

function getSinkPattern(name: string): SinkPattern {
  const p = SINK_PATTERNS.find(p => p.name === name);
  if (!p) throw new Error(`unknown sink pattern: ${name}`);
  return p;
}

// ─── Comment stripping ─────────────────────────────────────────────────

function stripComments(source: string): string {
  return source.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
    const idx = line.indexOf('//');
    if (idx > 0 && line[idx - 1] !== ':' && line[idx - 1] !== "'") {
      return line.slice(0, idx);
    }
    return line;
  }).join('\n');
}

function countOccurrences(content: string, regex: RegExp): number {
  const local = new RegExp(regex.source, regex.flags);
  let n = 0;
  while (local.exec(content) !== null) n++;
  return n;
}

// ─── Scan boundary ──────────────────────────────────────────────────────

const EXECUTABLE_EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs'];

function isExecutableSource(filename: string): boolean {
  return EXECUTABLE_EXTENSIONS.some(ext => filename.endsWith(ext)) && !filename.endsWith('.d.ts');
}

/** All executable source files under packages/**\/src/, scripts-explore/, and contracts/scripts/. */
function walkExecutableSources(): string[] {
  const acc: string[] = [];
  // packages/**/src/**
  if (existsSync(PACKAGES_DIR)) {
    for (const pkg of readdirSync(PACKAGES_DIR)) {
      const pkgSrc = join(PACKAGES_DIR, pkg, 'src');
      if (!existsSync(pkgSrc)) continue;
      walkDir(pkgSrc, acc);
    }
  }
  // scripts-explore/** (flat + archive/ subdirectory)
  if (existsSync(SCRIPTS_EXPLORE_DIR)) {
    walkDir(SCRIPTS_EXPLORE_DIR, acc);
  }
  // contracts/scripts/** (EM-STRAT-012-R2 work order A6) — the executable
  // TypeScript of the contracts workspace. NOT a blanket allowance for all
  // of contracts/: Solidity source (contracts/src/**, contracts/lib/**) and
  // compiled artifacts (contracts/build/**) remain excluded with the
  // language-specific rationale documented in the header.
  if (existsSync(CONTRACTS_SCRIPTS_DIR)) {
    walkDir(CONTRACTS_SCRIPTS_DIR, acc);
  }
  return acc;
}

function walkDir(dir: string, acc: string[]): void {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git' || e === '__tests__') continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (e === 'test') continue;
      walkDir(full, acc);
    } else if (isExecutableSource(e)) {
      acc.push(full);
    }
    // NOTE: files whose extension is not in EXECUTABLE_EXTENSIONS — in
    // particular `*.mts.quarantined` — are deliberately NOT collected.
  }
}

function toRepoRel(absolute: string): string {
  return relative(REPO_ROOT, absolute).replace(/\\/g, '/');
}

// ─── Canonical inventory ────────────────────────────────────────────────
//
// guardMode:
//   'direct'          — this file contains assertExecutionAuthorized('<scope>')
//   'indirect'        — the sink call routes through a client whose
//                       definition (another inventoried file) carries the guard
//   'safety-positive' — risk-reducing, deliberately ungated; the file carries
//                       a SAFETY-POSITIVE marker
//   'not-a-sink'      — regex false positive; the file carries a NOT-A-SINK
//                       marker explaining why the match is not a submission
//   'dormant-signer'  — constructs a raw signer/client but performs NO
//                       submission through it; census-enforced (any new sink
//                       call in the file fails the census)

interface CanonicalSink {
  file: string;
  sink: string;
  expectedCount: number;
  guardScope: string | null;
  guardMode: 'direct' | 'indirect' | 'safety-positive' | 'not-a-sink' | 'dormant-signer';
  rationale?: string;
}

const CANONICAL_SINKS: CanonicalSink[] = [
  // ── VooiClient — shared HTTP choke point (definitions; guards live here) ─
  // Phase-0.5 (work order C/D): the transport helper is now hard-private
  // (#request) with its own (method, path) classifier; the R1 ungated
  // close-intent exemption was REMOVED and replaced by the narrow
  // 'vooi:close-arbitrage-order' scope (body-validated both-legs reduceOnly).
  { file: 'packages/vooi-client/src/index.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'direct', rationale: 'open orders require the open scope; intent:"close" requires the distinct vooi:close-arbitrage-order scope AND both legs reduceOnly:true — no ungated exemption remains (Phase-0.5 work order D)' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'direct' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'stopBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: emergency stop must remain available without execution authorization' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'cancelArbitrageOrder', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE (EM-STRAT-012-R2 work order E3): cancellation reduces exposure and emergency unwind must remain available without execution authorization. ACCEPTED TRADEOFF: cancelling a partially-filled order can leave RESIDUAL DIRECTIONAL EXPOSURE (the filled portion stays open) — the operator must still flatten manually; the tradeoff is deliberately accepted so exits are never blocked by the execution guard' },
  { file: 'packages/vooi-client/src/index.ts', sink: 'deleteBot', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: cleanup of a stopped bot cannot open/increase exposure' },

  // ── VooiExecutor (strategy class) — executor-layer defense-in-depth ─────
  { file: 'packages/scanner/src/strategies/vooi-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 2, guardScope: 'vooi-executor:execute-arb', guardMode: 'direct', rationale: 'call 1 (open) asserts the executor scope locally then the client sink re-checks vooi:place-arbitrage-order; call 2 (closeArb) passes intent:"close" — the CLIENT sink now requires vooi:close-arbitrage-order with both legs reduceOnly:true (Phase-0.5 work order D; no ungated close)' },

  // ── VooiPriceSpreadExecutor (runner class) — direct local guard ─────────
  { file: 'packages/scanner/src/runners/vooi-price-spread-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi-price-spread-executor:execute-opp', guardMode: 'direct', rationale: 'local executor-scope guard; the client sink additionally re-checks vooi:place-arbitrage-order' },

  // ── EvmExecutor — hard-private signer; ONE consolidated sendTransaction site ──
  // PR #2 reconciliation: the three former direct sendTransaction call sites
  // (execute / balancerFlashLoanArb / aaveFlashLoanArb) were consolidated into
  // the private submitAndWait() helper, which itself re-asserts
  // 'evm-executor:send-transaction' (defense-in-depth at the sink) and each
  // public entry point still asserts the scope before calling it. Net effect:
  // FEWER direct sink call sites, same scope, strictly guarded.
  { file: 'packages/executor/src/index.ts', sink: 'sendTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct', rationale: 'single sendTransaction site inside #private submitAndWait(); the sink re-asserts the scope (defense-in-depth) and all public entry points assert it before calling' },
  // submitViaFlashbotsProtect broadcasts a real signed tx (eth_sendRawTransaction)
  // — guarded with the send-transaction scope since Phase-0.5 (work order A/E).
  { file: 'packages/executor/src/index.ts', sink: 'eth_sendRawTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct', rationale: 'submitViaFlashbotsProtect — raw broadcast sink; assertExecutionAuthorized added Phase-0.5' },
  { file: 'packages/executor/src/index.ts', sink: 'createWalletClient', expectedCount: 1, guardScope: 'evm-executor:construct-signer', guardMode: 'direct', rationale: 'signer construction behind the construct-signer guard; the raw client lives in #walletClient (hard-private, Phase-0.5 work order A)' },
  { file: 'packages/executor/src/index.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: 'evm-executor:construct-signer', guardMode: 'direct', rationale: 'key-derived account lives in #account (hard-private, Phase-0.5 work order A)' },

  // ── CexExecutor — CCXT order/cancel/withdrawal sinks (EM-STRAT-014-B1 + R1) ──
  // The raw CCXT Exchange lives in hard-private #exchange; marketOrder and
  // limitOrder each assert 'cex-executor:place-order' immediately before
  // their createOrder call; cancelOrder asserts the SEPARATE
  // 'cex-executor:cancel-order' scope (EM-STRAT-014-B1-R1 — a generic cancel
  // is NOT universally safety-positive: it can cancel a protective stop,
  // reduce-only exit, or hedge leg); withdraw requires the SEPARATE withdraw
  // scope. The three CEX scopes are INDEPENDENT — no one authorizes another.
  // The class has zero in-repo callers and is deliberately NOT re-exported
  // from the package index — contained at the sinks because the direct-file
  // import path remains open.
  { file: 'packages/executor/src/cex-executor.ts', sink: 'createOrder', expectedCount: 2, guardScope: 'cex-executor:place-order', guardMode: 'direct', rationale: 'marketOrder + limitOrder — each asserts the place-order scope per call, immediately before the CCXT submission; the Exchange instance is hard-private #exchange (EM-STRAT-014-B1)' },
  { file: 'packages/executor/src/cex-executor.ts', sink: 'cancelOrder', expectedCount: 1, guardScope: 'cex-executor:cancel-order', guardMode: 'direct', rationale: 'EM-STRAT-014-B1-R1: generic cancel is NOT universally safety-positive — it can cancel a protective stop, reduce-only exit, hedge leg, or other risk-reducing order. Without inspecting the order role, cancellation is gated like any submission sink. The cex-executor:cancel-order scope is INDEPENDENT from place-order and withdraw; per-call re-check.' },
  { file: 'packages/executor/src/cex-executor.ts', sink: 'withdraw', expectedCount: 1, guardScope: 'cex-executor:withdraw', guardMode: 'direct', rationale: 'withdrawal requires the SEPARATE cex-executor:withdraw scope — cex-executor:place-order never authorizes it and vice versa (per-call re-check, EM-STRAT-014-B1)' },

  // ── EVM runner scripts — raw sendTransaction sinks, hard-private clients ─
  { file: 'packages/scanner/src/runners/khype-carry-executor.ts', sink: 'sendTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct', rationale: 'single live call inside sendTx; guard re-checks per call; walletClient is #walletClient (hard-private, Phase-0.5)' },
  { file: 'packages/scanner/src/runners/khype-carry-executor.ts', sink: 'createWalletClient', expectedCount: 1, guardScope: 'entrypoint:khype-carry-executor', guardMode: 'direct', rationale: 'signer construction requires the entrypoint scope; client stored in #walletClient (hard-private)' },
  { file: 'packages/scanner/src/runners/khype-carry-executor.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: 'entrypoint:khype-carry-executor', guardMode: 'direct' },
  { file: 'packages/scanner/src/runners/euler-lending-executor.ts', sink: 'sendTransaction', expectedCount: 1, guardScope: 'evm-executor:send-transaction', guardMode: 'direct' },
  { file: 'packages/scanner/src/runners/euler-lending-executor.ts', sink: 'createWalletClient', expectedCount: 1, guardScope: 'entrypoint:euler-lending-executor', guardMode: 'direct', rationale: 'signer construction requires the entrypoint scope; client stored in #walletClient (hard-private)' },
  { file: 'packages/scanner/src/runners/euler-lending-executor.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: 'entrypoint:euler-lending-executor', guardMode: 'direct' },

  // ── Runner call sites through the guarded VooiClient (indirect) ─────────
  { file: 'packages/scanner/src/runners/go-live.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.createBot; entrypoint:go-live asserted locally in main()' },
  { file: 'packages/scanner/src/runners/go-live.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-create-bot.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.createBot; entrypoint:vooi-create-bot asserted locally' },
  { file: 'packages/scanner/src/runners/vooi-create-bot.ts', sink: 'startBot', expectedCount: 1, guardScope: 'vooi:start-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'indirect', rationale: 'client sink guard fires inside VooiClient.placeArbitrageOrder (open intent); entrypoint:vooi-arb-executor asserted locally on --live' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'startBot', expectedCount: 2, guardScope: 'vooi:start-bot', guardMode: 'indirect', rationale: 'wrapper definition + client call; client sink guard fires inside VooiClient.startBot' },
  { file: 'packages/scanner/src/runners/vooi-arb-executor.ts', sink: 'stopBot', expectedCount: 2, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: stopBot wrapper definition + client call — the ungated client stopBot keeps emergency stop available' },

  // ── BackpackClient (dormant sink; guarded at the definition) ────────────
  // EM-STRAT-012-R2 (work order C): the previous reduceOnly:true exemption
  // relied on venue reduce-only semantics with NO authoritative evidence in
  // this repository. It is REMOVED: EVERY order — including reduceOnly ones
  // — now requires 'backpack-client:place-order' (conservative VOOI
  // standard). The exemption must not be described as safety-positive
  // without evidence; a Principal-approved, evidenced exemption may be
  // reintroduced later.
  { file: 'packages/backpack-client/src/index.ts', sink: 'placeOrder', expectedCount: 1, guardScope: 'backpack-client:place-order', guardMode: 'direct', rationale: 'R2 work order C: EVERY order requires the scope — the unevidenced reduceOnly:true exemption was removed (venue reduce-only semantics unproven, aligned with the conservative VOOI standard); guard fires before any transport attempt' },

  // ── PumpApiClient — every transaction-producing action method ───────────
  // Phase-0.5: #post is hard-private with body-shape classification;
  // generatePumpWallet is credential-gated (pumpapi-client:generate-wallet).
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'buy', expectedCount: 1, guardScope: 'pumpapi-client:buy', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'sell', expectedCount: 1, guardScope: 'pumpapi-client:sell', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'actions', expectedCount: 1, guardScope: 'pumpapi-client:actions', guardMode: 'direct', rationale: 'arbitrary action array — no reduce-only variant, whole method gated' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'jitoBundle', expectedCount: 1, guardScope: 'pumpapi-client:jito-bundle', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'migrate', expectedCount: 1, guardScope: 'pumpapi-client:migrate', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'burn', expectedCount: 1, guardScope: 'pumpapi-client:burn', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'wrapSol', expectedCount: 1, guardScope: 'pumpapi-client:wrap-sol', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'transfer', expectedCount: 1, guardScope: 'pumpapi-client:transfer', guardMode: 'direct' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'claimCashback', expectedCount: 1, guardScope: null, guardMode: 'safety-positive', rationale: 'SAFETY-POSITIVE: recovers owed cashback into the wallet; cannot open or increase exposure (see JSDoc rationale). R2 work order B: the request body still carries Lightning credentials BY PROTOCOL DESIGN — see the credential-transmission rationale in packages/pumpapi-client/src/index.ts. Read-only (getBalances, getTokenInfo) and cashback actions are classified not capital-increasing: the server broadcasts no position-changing transaction for them' },
  { file: 'packages/pumpapi-client/src/index.ts', sink: 'atomicTwoLegArb', expectedCount: 1, guardScope: 'pumpapi-client:atomic-two-leg-arb', guardMode: 'direct', rationale: 'calls #post() directly (NOT actions()) so the actions() guard is not bypassed and atomicTwoLegArb\'s own guard is sufficient' },

  // ── False-positive regex matches (NOT-A-SINK) ───────────────────────
  { file: 'packages/pnl/src/index.ts', sink: 'migrate', expectedCount: 2, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: PnlDb.migrate() is a SQLite schema migration (CREATE TABLE / CREATE INDEX DDL), not a trading action. Count=2: the constructor call site (this.migrate()) + the private method definition.' },
  { file: 'packages/orchestrator/src/agents/operations-agent.ts', sink: 'deployContract', expectedCount: 2, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: OperationsAgent.deployContract is an offline stub (console.log + returns "deployed (stub)"); no signer construction, no broadcast, no network. Count=2: the task-dispatch call site + the private method definition. If ever wired to the real deployment utility, that path is guarded by entrypoint:contracts-deploy inside contracts/scripts/deploy.ts (R2 work order A)' },

  // ── data-sources — vestigial signer construction (hard-private) ─────────
  { file: 'packages/data-sources/src/index.ts', sink: 'createWalletClient', expectedCount: 1, guardScope: null, guardMode: 'dormant-signer', rationale: 'dormant-signer: EvmAdapter constructs a wallet client only when a caller passes signerPrivateKey (no in-repo caller does); the raw client lives in #walletClient (hard-private, Phase-0.5 work order A) and the class exposes only read-only RPC helpers' },
  { file: 'packages/data-sources/src/index.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: null, guardMode: 'dormant-signer', rationale: 'dormant-signer: key-derived account stored in hard-private #walletClient closure; signerAddress (plain address) is the only public derivative' },
  { file: 'packages/data-sources/src/gen-agent-wallets.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: local key-GENERATION utility (creates new agent wallets and appends them to .env); performs no network submission. Inventoried for key-material provenance; must never be run against funded environments without Principal approval' },

  // ── contracts/scripts/deploy.ts — guarded deployment entrypoint (R2 work order A) ──
  // The EI adversarial review (EM-STRAT-012-R2) found this live deployment
  // path outside the census. It is now contained: main() asserts
  // 'entrypoint:contracts-deploy' as its FIRST action (before .env load,
  // bytecode read, signer construction, or any network request), .env
  // loading uses the shared helper that excludes EDGE_EXECUTION_AUTH, and
  // importing the module performs no side effects (import.meta.url
  // direct-entrypoint check).
  { file: 'contracts/scripts/deploy.ts', sink: 'deployContract', expectedCount: 1, guardScope: 'entrypoint:contracts-deploy', guardMode: 'direct', rationale: 'the deployContract call is a real signed broadcast; the entrypoint guard fires as the FIRST action of main() — before .env load, bytecode read, signer construction, or any network request (R2 work order A3)' },
  { file: 'contracts/scripts/deploy.ts', sink: 'createWalletClient', expectedCount: 1, guardScope: 'entrypoint:contracts-deploy', guardMode: 'direct', rationale: 'signer construction behind the same first-action entrypoint guard (R2 work order A)' },
  { file: 'contracts/scripts/deploy.ts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: 'entrypoint:contracts-deploy', guardMode: 'direct', rationale: 'key-derived account construction behind the same first-action entrypoint guard (R2 work order A)' },

  // ── sharpe-client — read-only transport definition ──────────────────────
  { file: 'packages/sharpe-client/src/index.ts', sink: 'transportDef', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: private async request<T>() is the transport of a read-only market-data client (GET endpoints only); no order/transfer paths exist in this client' },

  // ── scripts-explore — executable files with guarded transit sinks ───────
  // (The 16 unguarded live paths were mechanically quarantined to
  // *.mts.quarantined — see QUARANTINED_SCRIPTS and its enforcement test.)
  { file: 'scripts-explore/pump-arb-executor.mts', sink: 'atomicTwoLegArb', expectedCount: 1, guardScope: 'pumpapi-client:atomic-two-leg-arb', guardMode: 'indirect', rationale: 'legacy script; submission routes through the guarded PumpApiClient sink (fails closed without EDGE_EXECUTION_AUTH); .env loader excludes EDGE_EXECUTION_AUTH (Phase-0.5)' },
  { file: 'scripts-explore/vooi-bot-creator.mts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'legacy script; submission routes through the guarded VooiClient sink; .env loader excludes EDGE_EXECUTION_AUTH' },
  { file: 'scripts-explore/vooi-create-bot-fixed.mts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'legacy script; guarded VooiClient sink; .env loader excludes EDGE_EXECUTION_AUTH' },
  { file: 'scripts-explore/vooi-bot-hl.mts', sink: 'createBot', expectedCount: 1, guardScope: 'vooi:create-bot', guardMode: 'indirect', rationale: 'legacy script; guarded VooiClient sink; .env loader excludes EDGE_EXECUTION_AUTH' },
  { file: 'scripts-explore/vooi-live-executor.mts', sink: 'placeArbitrageOrder', expectedCount: 1, guardScope: 'vooi:place-arbitrage-order', guardMode: 'indirect', rationale: 'legacy script; guarded VooiClient sink; .env loader excludes EDGE_EXECUTION_AUTH' },
  { file: 'scripts-explore/vooi-live-executor.mts', sink: 'newExchangeClient', expectedCount: 1, guardScope: null, guardMode: 'dormant-signer', rationale: 'dormant-signer: constructs a raw HL ExchangeClient but performs NO submission through it (no exchClient.* sink calls — census-enforced: any new HL sink in this file fails the census); scheduled for migration to a guarded facade or quarantine in a follow-up' },
  { file: 'scripts-explore/vooi-live-executor.mts', sink: 'privateKeyToAccount', expectedCount: 1, guardScope: null, guardMode: 'dormant-signer', rationale: 'dormant-signer: key material used to construct the never-invoked ExchangeClient above' },
  { file: 'scripts-explore/run-pumpfun-arb.mts', sink: 'atomicTwoLegArb', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: the name appears only inside a console.log instruction string ("Use PumpApi atomicTwoLegArb() directly"); there is no call expression' },
  { file: 'scripts-explore/builder-register.mts', sink: 'rawHlExchangePost', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: the /exchange URL appears only inside a console.log instruction string; the script performs no fetch' },
  { file: 'scripts-explore/hl-transfer-tool.mts', sink: 'rawHlExchangePost', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: the /exchange URL appears only inside a console.log instruction string; the script performs no fetch' },

  // ── scripts-explore — Solidity source strings inside design docs ────────
  { file: 'scripts-explore/atomic-arb-contract.mts', sink: 'transfer', expectedCount: 3, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: IERC20.transfer occurrences are Solidity code inside a template-string contract design doc; no JavaScript submission' },
  { file: 'scripts-explore/atomic-arb-contract.mts', sink: 'placeOrder', expectedCount: 1, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: Solidity interface declaration inside a template string' },
  { file: 'scripts-explore/flashloan-arb-contract.mts', sink: 'transfer', expectedCount: 4, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: IERC20.transfer occurrences are Solidity code inside a template-string contract design doc' },
  { file: 'scripts-explore/flashloan-arb-contract.mts', sink: 'placeOrder', expectedCount: 3, guardScope: null, guardMode: 'not-a-sink', rationale: 'NOT-A-SINK: Solidity interface declaration + ICoreWriter.placeOrder calls inside a template string' },
];

// ─── Quarantine manifest (Phase-0.5, work order B) ──────────────────────
//
// Every runnable mainnet submission path found by the EI adversarial review
// was mechanically archived under the non-executable `*.mts.quarantined`
// extension (no launcher references them; they cannot run by ordinary
// invocation). This manifest is ENFORCED below: each entry must exist under
// its quarantined name and must NOT exist under its executable name.

const QUARANTINED_SCRIPTS: string[] = [
  'hl-action-hash.mts',        // hand-rolled signed POST /exchange (approveBuilderFee, usdSend)
  'hl-exchange-client.mts',    // hand-rolled signed POST /exchange (approveBuilderFee)
  'test-hl-format.mts',        // direct POST /exchange with dummy signatures ×5
  'hl-order-signing.mts',      // hand-rolled signing harness (fetches commented but one uncomment from live)
  'hl-place-order.mts',        // ExchangeClient.order ($50k BTC) + approveBuilderFee
  'hl-execute-order.mts',      // ExchangeClient.order (runtime-computed basis order)
  'hl-order-btc.mts',          // ExchangeClient.order + usdSend
  'hl-maker-order.mts',        // ExchangeClient.order (maker)
  'hl-sdk-exchange.mts',       // ExchangeClient.order + usdSend + approveBuilderFee
  'hl-sdk-exchange2.mts',      // same triple-sink (fixed-format retry)
  'hl-order-test.mts',         // ExchangeClient.order + usdSend + createUserVault
  'hl-sdk-viem.mts',           // approveBuilderFee + usdSend + noop
  'hl-sdk-wallet.mts',         // approveBuilderFee ×3 (wallet-format probing)
  'go-live-v2.mts',            // UNGUARDED approveBuilderFee leg (+ guarded VOOI leg)
  'live-trading-executor.mts', // UNGUARDED approveBuilderFee leg
  'vault-deploy.mts',          // createUserVault footgun (fetch commented, one uncomment from live)
];

// ─── Reusable scan logic (production census + synthetic-sink tests) ─────

export interface SinkViolation {
  file: string;
  sinkName: string;
  count: number;
  reason: 'uninventoried-file' | 'uninventoried-sink-in-known-file';
}

export function scanForUninventoriedSinks(
  fileContents: Map<string, string>,
  inventory: CanonicalSink[] = CANONICAL_SINKS,
): SinkViolation[] {
  const known = new Map<string, Set<string>>();
  for (const entry of inventory) {
    if (!known.has(entry.file)) known.set(entry.file, new Set());
    known.get(entry.file)!.add(entry.sink);
  }

  const violations: SinkViolation[] = [];
  for (const [relPath, strippedContent] of fileContents) {
    const inventoriedSinks = known.get(relPath);
    for (const pattern of SINK_PATTERNS) {
      const count = countOccurrences(strippedContent, pattern.globalRegex);
      if (count === 0) continue;
      if (!inventoriedSinks) {
        violations.push({ file: relPath, sinkName: pattern.name, count, reason: 'uninventoried-file' });
      } else if (!inventoriedSinks.has(pattern.name)) {
        violations.push({ file: relPath, sinkName: pattern.name, count, reason: 'uninventoried-sink-in-known-file' });
      }
    }
  }
  return violations;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('EM-STRAT-012 submission-sink census — Phase-0.5 + R2 perimeter', () => {

  // ── Scope-count reconciliation ──────────────────────────────────────────
  // Pre-R1 taxonomy: 16 scopes. R1 added 8 PumpApi action scopes (24).
  // Phase-0.5 adds vooi:close-arbitrage-order (work order D) and
  // pumpapi-client:generate-wallet (work order C) → 26.
  // EM-STRAT-012-R2 adds entrypoint:contracts-deploy (work order A) → 27.
  // EM-STRAT-014-B1 adds cex-executor:place-order + cex-executor:withdraw
  // (CCXT order/withdrawal containment) → 29.
  // EM-STRAT-014-B1-R1 adds cex-executor:cancel-order (generic cancel is
  // NOT universally safety-positive — can cancel a protective stop / hedge
  // leg / reduce-only exit; gated like any submission sink) → 30.

  it('EXECUTION_SCOPES length matches the documented EM-STRAT-014-B1-R1 count (30)', () => {
    expect(EXECUTION_SCOPES.length).toBe(30);
  });

  it('EXECUTION_SCOPES contains the Phase-0.5, R2, EM-STRAT-014-B1 and R1 additions', () => {
    expect(EXECUTION_SCOPES).toContain('vooi:close-arbitrage-order');
    expect(EXECUTION_SCOPES).toContain('pumpapi-client:generate-wallet');
    expect(EXECUTION_SCOPES).toContain('entrypoint:contracts-deploy');
    expect(EXECUTION_SCOPES).toContain('cex-executor:place-order');
    expect(EXECUTION_SCOPES).toContain('cex-executor:cancel-order');
    expect(EXECUTION_SCOPES).toContain('cex-executor:withdraw');
  });

  // ── contracts/scripts perimeter (EM-STRAT-012-R2 work order A6) ─────

  it('R2: the executable-source walk includes contracts/scripts/** and still excludes Solidity/artifacts', () => {
    const files = walkExecutableSources().map(toRepoRel);
    expect(files).toContain('contracts/scripts/deploy.ts');
    expect(files).toContain('contracts/scripts/compile.ts');
    expect(files).toContain('contracts/scripts/preflight.ts');
    // NOT a blanket allowance for all of contracts/:
    expect(files.some(f => f.startsWith('contracts/src/'))).toBe(false);
    expect(files.some(f => f.startsWith('contracts/lib/'))).toBe(false);
    expect(files.some(f => f.startsWith('contracts/build/'))).toBe(false);
  });

  // ── Quarantine manifest enforcement (work order B) ──────────────────────

  it('every quarantined live path exists under *.mts.quarantined and NOT under its executable name', () => {
    expect(QUARANTINED_SCRIPTS.length).toBe(16);
    const problems: string[] = [];
    for (const name of QUARANTINED_SCRIPTS) {
      const qPath = resolve(SCRIPTS_EXPLORE_DIR, `${name}.quarantined`);
      const xPath = resolve(SCRIPTS_EXPLORE_DIR, name);
      if (!existsSync(qPath)) {
        problems.push(`${name}.quarantined MISSING — the quarantine was reverted or the file was renamed; restore the archive or re-classify the path`);
      }
      if (existsSync(xPath)) {
        problems.push(`${name} EXISTS as an executable file — a quarantined live-submission path was restored without a guard. Re-quarantine or guard it at its sink.`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('no *.mts.quarantined content is collected by the executable-source walk', () => {
    const files = walkExecutableSources();
    const quarantinedCollected = files.filter(f => f.endsWith('.quarantined'));
    expect(quarantinedCollected).toEqual([]);
    // And the walk does find executable sources (sanity).
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.includes('scripts-explore'))).toBe(true);
  });

  it('the daemon supervisor launches no submission-capable script', () => {
    // scripts-explore/daemon-supervisor.sh is the only shell launcher in the
    // scanned perimeter. Its DAEMONS list must contain only read-only
    // alert/monitor daemons — never a quarantined path or an executor.
    const src = readFileSync(resolve(SCRIPTS_EXPLORE_DIR, 'daemon-supervisor.sh'), 'utf8');
    const forbidden = [
      ...QUARANTINED_SCRIPTS.map(q => q.replace('.mts', '')),
      'executor', 'go-live', 'live-trading', 'hl-place-order', 'hl-order',
    ];
    const daemonsSection = src.slice(src.indexOf('DAEMONS=('), src.indexOf(')', src.indexOf('DAEMONS=(')));
    for (const f of forbidden) {
      expect(daemonsSection).not.toContain(f);
    }
    // Every launched entry must be an alert/monitor script.
    for (const known of ['telegram-listener', 'command-handler', 'realtime-opp-alerts', 'opp-db', 'hl-funding-alerts', 'paper-trader', 'risk-dashboard', 'wallet-funding-alert', 'realtime-spread-monitor', 'khype-timeseries', 'khype-cadence-sampler', 'limusd-monitor']) {
      expect(daemonsSection).toContain(known);
    }
  });

  // ── Per-file inventory: exact occurrence counts ─────────────────────────

  it('every canonical sink appears in its file with the exact expected occurrence count (comments stripped)', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      const path = resolve(REPO_ROOT, entry.file);
      if (!existsSync(path)) {
        problems.push(`${entry.file}: FILE MISSING (moved or deleted without inventory update)`);
        continue;
      }
      const content = stripComments(readFileSync(path, 'utf8'));
      const pattern = getSinkPattern(entry.sink);
      const count = countOccurrences(content, pattern.inventoryRegex);
      if (count !== entry.expectedCount) {
        problems.push(
          `${entry.file}: sink "${entry.sink}" occurrence count ${count} != expected ${entry.expectedCount}` +
          ` — a new call site was added or an old one removed without updating the inventory`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Direct-guard verification ───────────────────────────────────────────

  it('every direct-guard sink file contains its assertExecutionAuthorized call', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'direct') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      const literalGuard = content.includes(`assertExecutionAuthorized('${entry.guardScope}')`);
      // Entrypoint-style guards assert the exported ENTRYPOINT_SCOPE constant
      // rather than a literal — accept that form when the file pins the
      // constant to the expected scope.
      const constantPinned = new RegExp(
        `ENTRYPOINT_SCOPE\\s*:?\\s*ExecutionScope\\s*=\\s*'${entry.guardScope}'`,
      ).test(content);
      const constantGuard = content.includes('assertExecutionAuthorized(ENTRYPOINT_SCOPE)');
      if (!literalGuard && !(constantPinned && constantGuard)) {
        problems.push(`${entry.file}: expected guard assertExecutionAuthorized('${entry.guardScope}') not found — sink lost its guard`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Indirect-guard chain verification ───────────────────────────────────

  it('every indirect sink routes to a sink definition that is direct-guarded in its own file', () => {
    const directDefs = new Map<string, Set<string>>();
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'direct') continue;
      if (!directDefs.has(entry.sink)) directDefs.set(entry.sink, new Set());
      directDefs.get(entry.sink)!.add(entry.file);
    }
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'indirect') continue;
      const defFiles = directDefs.get(entry.sink);
      if (!defFiles || defFiles.size === 0) {
        problems.push(`${entry.file}: indirect sink "${entry.sink}" has NO direct-guarded definition file in the inventory — the guard chain is broken`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Marker verification (safety-positive / not-a-sink) ──────────────────

  it('every safety-positive sink file contains its documented rationale marker', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'safety-positive') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      if (!content.includes('SAFETY-POSITIVE')) {
        problems.push(`${entry.file}: safety-positive sink "${entry.sink}" lost its SAFETY-POSITIVE rationale marker`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every not-a-sink entry file contains its NOT-A-SINK rationale marker (or is a bare-string inventoried mention)', () => {
    const problems: string[] = [];
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardMode !== 'not-a-sink') continue;
      const content = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      // gen-agent-wallets is inventoried as not-a-sink without an inline
      // marker (it is a key-generation utility documented in the inventory);
      // every other not-a-sink file must carry the inline marker.
      if (entry.file === 'packages/data-sources/src/gen-agent-wallets.ts') continue;
      if (!content.includes('NOT-A-SINK')) {
        problems.push(`${entry.file}: not-a-sink entry for "${entry.sink}" lost its NOT-A-SINK rationale marker`);
      }
    }
    expect(problems).toEqual([]);
  });

  // ── Hard-private signer assertion (work order A) ────────────────────────

  it('no executable source declares a signer-capable walletClient property outside a # private field', () => {
    // The walletClientProperty pattern uses a lookbehind that excludes
    // occurrences preceded by '#'. Any hit means a class re-exposed a raw
    // viem WalletClient as a TS-private/public runtime property.
    const files = walkExecutableSources();
    const hits: string[] = [];
    for (const f of files) {
      const rel = toRepoRel(f);
      const content = stripComments(readFileSync(f, 'utf8'));
      const n = countOccurrences(content, getSinkPattern('walletClientProperty').inventoryRegex);
      if (n > 0) hits.push(`${rel}: ${n} unhidden walletClient property declaration(s)`);
    }
    expect(hits).toEqual([]);
  });

  it('guarded executor classes keep their signers in # hard-private fields (focused static assertion)', () => {
    const executorSrc = readFileSync(resolve(REPO_ROOT, 'packages/executor/src/index.ts'), 'utf8');
    expect(executorSrc).toContain('#walletClient');
    expect(executorSrc).toContain('#account');
    const khypeSrc = readFileSync(resolve(REPO_ROOT, 'packages/scanner/src/runners/khype-carry-executor.ts'), 'utf8');
    expect(khypeSrc).toContain('#walletClient');
    const eulerSrc = readFileSync(resolve(REPO_ROOT, 'packages/scanner/src/runners/euler-lending-executor.ts'), 'utf8');
    expect(eulerSrc).toContain('#walletClient');
    const adapterSrc = readFileSync(resolve(REPO_ROOT, 'packages/data-sources/src/index.ts'), 'utf8');
    expect(adapterSrc).toContain('#walletClient');
    // EM-STRAT-014-B1 + R1: the CCXT exchange instance is hard-private, and
    // all three narrow CexExecutor scopes (place-order, cancel-order,
    // withdraw) are asserted at their sinks. cancelOrder is NO LONGER
    // safety-positive (R1: a generic cancel can cancel a protective stop /
    // hedge leg / reduce-only exit), so the file must NOT carry a
    // SAFETY-POSITIVE marker.
    const cexSrc = readFileSync(resolve(REPO_ROOT, 'packages/executor/src/cex-executor.ts'), 'utf8');
    expect(cexSrc).toContain('#exchange');
    // The dangerous form is a re-exposed DECLARATION (`readonly exchange: …`);
    // prose mentions of the old design must not trip this assertion.
    expect(cexSrc).not.toMatch(/readonly exchange\s*:/);
    expect(cexSrc).toContain("assertExecutionAuthorized('cex-executor:place-order')");
    expect(cexSrc).toContain("assertExecutionAuthorized('cex-executor:cancel-order')");
    expect(cexSrc).toContain("assertExecutionAuthorized('cex-executor:withdraw')");
    expect(cexSrc).not.toContain('SAFETY-POSITIVE');
    // The transport helpers are hard-private (work order C).
    const vooiSrc = readFileSync(resolve(REPO_ROOT, 'packages/vooi-client/src/index.ts'), 'utf8');
    expect(vooiSrc).toContain('async #request');
    expect(vooiSrc).not.toMatch(/async request\b[<(]/);
    const pumpSrc = readFileSync(resolve(REPO_ROOT, 'packages/pumpapi-client/src/index.ts'), 'utf8');
    expect(pumpSrc).toContain('async #post');
    expect(pumpSrc).not.toMatch(/async post\b[<(]/);
  });

  // ── Global uninventoried-sink scan ──────────────────────────────────────

  it('no sink pattern appears as a CALL SITE in any executable file outside the canonical inventory', () => {
    const allFiles = walkExecutableSources();
    expect(allFiles.length).toBeGreaterThan(0);

    const fileContents = new Map<string, string>();
    for (const f of allFiles) {
      const rel = toRepoRel(f);
      fileContents.set(rel, stripComments(readFileSync(f, 'utf8')));
    }

    const violations = scanForUninventoriedSinks(fileContents);
    if (violations.length > 0) {
      const msg = violations.map(v =>
        `${v.file}: ${v.reason} — sink "${v.sinkName}" × ${v.count} (add to CANONICAL_SINKS with a guard, safety-positive/not-a-sink marker, or quarantine after review)`,
      ).join('\n');
      throw new Error(`Uninventoried sink call sites found:\n${msg}`);
    }
    expect(violations).toEqual([]);
  });

  // ── Guard-scope taxonomy verification ───────────────────────────────────

  it('all guard scopes referenced by the inventory exist in the EXECUTION_SCOPES taxonomy', () => {
    for (const entry of CANONICAL_SINKS) {
      if (entry.guardScope === null) continue;
      expect(EXECUTION_SCOPES).toContain(entry.guardScope as any);
    }
  });

  // ── Synthetic-sink self-tests (exercise the ACTUAL scan logic) ──────────

  it('scanForUninventoriedSinks catches an injected synthetic unknown sink (self-test)', () => {
    const fileContents = new Map<string, string>();
    fileContents.set('packages/synthetic/src/synthetic-sink.ts', stripComments(
      'export async function evil() {\n' +
      '  await client.placeArbitrageOrder(req);\n' +
      '  await pumpApi.buy(req);\n' +
      '  await pumpApi.transfer(mint, to, amt);\n' +
      '}\n',
    ));
    const violations = scanForUninventoriedSinks(fileContents);
    const flagged = new Set(violations.map(v => v.sinkName));
    expect(flagged.has('placeArbitrageOrder')).toBe(true);
    expect(flagged.has('buy')).toBe(true);
    expect(flagged.has('transfer')).toBe(true);
    for (const v of violations) {
      expect(v.reason).toBe('uninventoried-file');
      expect(v.count).toBeGreaterThan(0);
    }
  });

  it('synthetic fixtures: Phase-0.5 sink classes are detected in unknown files (HL SDK order, raw /exchange POST, exposed walletClient, transport helper)', () => {
    // Source fixtures ONLY (no execution) — each simulates a class of
    // unguarded sink the Phase-0.5 perimeter must catch.
    const fileContents = new Map<string, string>();

    // 1. Hyperliquid SDK submission method.
    fileContents.set('scripts-explore/synthetic-hl.ts', stripComments(
      'import { ExchangeClient } from "@nktkas/hyperliquid";\n' +
      'export async function place SyntheticOrder(c: ExchangeClient) {\n' +
      '  return c.order({ coin: "BTC", isBuy: true, sz: 0.001 });\n' +
      '}\n',
    ));
    // 2. Raw signed POST /exchange.
    fileContents.set('scripts-explore/synthetic-raw-exchange.ts', stripComments(
      'export async function rawSubmit(payload: unknown) {\n' +
      '  return fetch("https://api.hyperliquid.xyz/exchange", { method: "POST", body: JSON.stringify(payload) });\n' +
      '}\n',
    ));
    // 3. Exposed signer-capable property on a guarded executor class.
    fileContents.set('packages/synthetic/src/exposed-signer.ts', stripComments(
      'export class BadExecutor {\n' +
      '  walletClient: WalletClient;\n' +
      '}\n',
    ));
    // 4. Low-level transport helper definition in an unknown file.
    fileContents.set('packages/synthetic/src/rogue-transport.ts', stripComments(
      'export class RogueClient {\n' +
      '  private async request<T>(method: string, path: string): Promise<T> { return null as any; }\n' +
      '}\n',
    ));

    const violations = scanForUninventoriedSinks(fileContents);
    const byFile = new Map<string, Set<string>>();
    for (const v of violations) {
      if (!byFile.has(v.file)) byFile.set(v.file, new Set());
      byFile.get(v.file)!.add(v.sinkName);
    }
    // 1. HL SDK .order( must be caught.
    expect(byFile.get('scripts-explore/synthetic-hl.ts')?.has('hlOrder')).toBe(true);
    // 2. Raw /exchange POST must be caught.
    expect(byFile.get('scripts-explore/synthetic-raw-exchange.ts')?.has('rawHlExchangePost')).toBe(true);
    // 3. Exposed walletClient property must be caught.
    expect(byFile.get('packages/synthetic/src/exposed-signer.ts')?.has('walletClientProperty')).toBe(true);
    // 4. TS-private transport definition must be caught.
    expect(byFile.get('packages/synthetic/src/rogue-transport.ts')?.has('transportDef')).toBe(true);
  });

  it('R2 synthetic fixture: an unguarded deployContract sink in a PREVIOUSLY UNKNOWN executable file is detected', () => {
    // EM-STRAT-012-R2 work order A7/verification: the census must detect a
    // deployment sink in a file that has never been inventoried — e.g. a
    // new script dropped into contracts/scripts/ that constructs a signer
    // and broadcasts bytecode. Exercises the SAME scan function CI runs.
    const fileContents = new Map<string, string>();
    fileContents.set('contracts/scripts/synthetic-unknown-deploy.ts', stripComments(
      'import { createWalletClient, http } from "viem";\n' +
      'import { privateKeyToAccount } from "viem/accounts";\n' +
      'export async function deploySomething(pk: `0x${string}`) {\n' +
      '  const account = privateKeyToAccount(pk);\n' +
      '  const client = createWalletClient({ account, transport: http(rpcUrl) });\n' +
      '  return client.deployContract({ abi, bytecode });\n' +
      '}\n',
    ));
    const violations = scanForUninventoriedSinks(fileContents);
    const byFile = new Map(violations.filter(v => v.file === 'contracts/scripts/synthetic-unknown-deploy.ts').map(v => [v.sinkName, v]));
    expect(byFile.has('deployContract')).toBe(true);
    expect(byFile.has('createWalletClient')).toBe(true);
    expect(byFile.has('privateKeyToAccount')).toBe(true);
    for (const v of byFile.values()) {
      expect(v.reason).toBe('uninventoried-file');
      expect(v.count).toBeGreaterThan(0);
    }
  });

  it('EM-STRAT-014-B1: unguarded CCXT order/withdraw/cancel sinks in a PREVIOUSLY UNKNOWN file are detected', () => {
    // A new file that reaches a CCXT sink through a re-exposed exchange
    // property must fail the census on BOTH the submission sinks and the
    // exposed-property pattern (the direct bypass vector B1 removed).
    const fileContents = new Map<string, string>();
    fileContents.set('packages/synthetic/src/rogue-cex.ts', stripComments(
      'export class RogueCex {\n' +
      '  exchange: Exchange;\n' +
      '  async go() {\n' +
      '    await this.exchange.createOrder("BTC/USDT", "market", "buy", 1);\n' +
      '    await this.exchange.withdraw("USDT", 1, "addr");\n' +
      '    await this.exchange.cancelOrder("1", "BTC/USDT");\n' +
      '  }\n' +
      '}\n',
    ));
    const violations = scanForUninventoriedSinks(fileContents);
    const byFile = new Set(
      violations.filter(v => v.file === 'packages/synthetic/src/rogue-cex.ts').map(v => v.sinkName),
    );
    expect(byFile.has('createOrder')).toBe(true);
    expect(byFile.has('withdraw')).toBe(true);
    expect(byFile.has('cancelOrder')).toBe(true);
    expect(byFile.has('exposedExchangeProperty')).toBe(true);
  });

  it('EM-STRAT-014-B1: the contained cex-executor.ts passes the census with zero violations (positive control)', () => {
    // The REAL cex-executor.ts contents, run through the ACTUAL scan
    // function, must produce NO violations: both createOrder call sites,
    // the withdrawal sink and the cancellation sink are inventoried, and
    // the #exchange declaration is invisible to exposedExchangeProperty.
    const realCex = resolve(REPO_ROOT, 'packages', 'executor', 'src', 'cex-executor.ts');
    const fileContents = new Map<string, string>();
    fileContents.set('packages/executor/src/cex-executor.ts', stripComments(readFileSync(realCex, 'utf8')));
    expect(scanForUninventoriedSinks(fileContents)).toEqual([]);
  });

  it('EM-STRAT-014-B1: a hard-private #exchange declaration is NOT flagged by exposedExchangeProperty (positive control)', () => {
    const fileContents = new Map<string, string>();
    fileContents.set('packages/synthetic/src/good-cex.ts', stripComments(
      'export class GoodCex {\n' +
      '  #exchange: Exchange;\n' +
      '  constructor() { this.#exchange = make(); }\n' +
      '}\n',
    ));
    const violations = scanForUninventoriedSinks(fileContents);
    const flagged = violations.filter(v => v.sinkName === 'exposedExchangeProperty');
    expect(flagged).toEqual([]);
  });

  it('R2 synthetic fixture: the guarded contracts/scripts/deploy.ts produces NO scan violations (positive control)', () => {
    // The REAL deploy.ts contents, run through the ACTUAL scan function,
    // must produce NO violations: all three deployment sinks are
    // inventoried under entrypoint:contracts-deploy.
    const realDeploy = resolve(REPO_ROOT, 'contracts', 'scripts', 'deploy.ts');
    const fileContents = new Map<string, string>();
    fileContents.set('contracts/scripts/deploy.ts', stripComments(readFileSync(realDeploy, 'utf8')));
    const violations = scanForUninventoriedSinks(fileContents);
    expect(violations).toEqual([]);
  });

  it('synthetic fixture: a hard-private #walletClient is NOT flagged by the property pattern (positive control)', () => {
    const fileContents = new Map<string, string>();
    fileContents.set('packages/synthetic/src/good-executor.ts', stripComments(
      'export class GoodExecutor {\n' +
      '  #walletClient: WalletClient;\n' +
      '  constructor() { this.#walletClient = makeClient(); }\n' +
      '}\n',
    ));
    const violations = scanForUninventoriedSinks(fileContents);
    const flagged = violations.filter(v => v.sinkName === 'walletClientProperty');
    expect(flagged).toEqual([]);
  });

  it('scanForUninventoriedSinks flags a known file with an uninventoried NEW sink type', () => {
    const fileContents = new Map<string, string>();
    fileContents.set(
      'packages/vooi-client/src/index.ts',
      'export async function evil() { await this.usdSend(req); }\n',
    );
    const violations = scanForUninventoriedSinks(fileContents);
    const v = violations.find(x => x.sinkName === 'usdSend');
    expect(v).toBeDefined();
    expect(v!.reason).toBe('uninventoried-sink-in-known-file');
  });

  it('scanForUninventoriedSinks does NOT flag a definition (no dot prefix) in an uninventoried file', () => {
    const fileContents = new Map<string, string>();
    fileContents.set(
      'packages/synthetic/src/defs-only.ts',
      'export class Foo {\n  async buy(req: unknown): Promise<void> {}\n}\n',
    );
    const violations = scanForUninventoriedSinks(fileContents);
    expect(violations).toEqual([]);
  });
});
