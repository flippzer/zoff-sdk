/**
 * DevNet end-to-end smoke test — Toiki's 2026-04-20 final pre-flight.
 *
 * ## Architectural shape (confirmed Signal 2026-04-20)
 *
 *   dApp (this harness) ──POST /api/dev/trigger-swap──▶ Helvetswap
 *                                                          │
 *                            ┌─────────────────────────────┘
 *                            ▼
 *               (server builds self-referential TI,
 *                SwapPoller + SwapTiProcessor fire,
 *                AMM reserves update)
 *                            │
 *                            ▼
 *   dApp (this harness) ◀──GET /api/swap/inspect + /api/pools
 *
 * The trigger endpoint is `permitAll` on the devnet profile — no auth
 * header needed. DevNet's real authed endpoints use Ed25519 HMAC, not
 * Keycloak OAuth2, so a bearer token would be rejected anyway. The
 * JwtMinter in `src/auth.ts` stays in the SDK surface for Phase 3
 * (gRPC against ledger-API :5001, where JWT IS the right auth shape).
 *
 * ## Why this harness no longer tails logs
 *
 * The DevNet SSH key Hugo has is restricted — no-pty, no-agent-
 * forwarding, permit-open on :5001 + :8082 only. Can't reach :8888
 * for canton-console, can't open a shell. Toiki tails logs on his side
 * during the first smoke and pastes log lines back. After that, the
 * public `/api/swap/inspect` endpoint confirms terminal state per
 * requestId without any SSH access.
 *
 * ## What this harness does
 *
 *   1. GET /api/pools — record pool state BEFORE the swap.
 *   2. POST /api/dev/trigger-swap — get back a requestId.
 *   3. Poll GET /api/swap/inspect?requestId=<uuid> until the server
 *      reports a terminal state, or timeout.
 *   4. GET /api/pools — record pool state AFTER the swap. Diff the
 *      reserves for a sanity-check that the AMM actually moved.
 *
 * ## Prerequisites
 *
 * - Toiki's endpoint deployed on api.helvetswap.app. He'll confirm on
 *   Signal.
 * - `.env.local` populated: HELVETSWAP_POOL_ID (default
 *   `cc-cbtc-showcase`), HELVETSWAP_BACKEND_URL (default
 *   `https://api.helvetswap.app`). Nothing else is strictly needed.
 *
 * ## Run
 *
 *     npm run smoke
 */
import { setTimeout as delay } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Config — read from process.env with explicit failures.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env.local ` +
        `and fill in any values delivered via Signal.`
    );
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

interface SmokeConfig {
  readonly backendUrl: string;
  readonly poolId: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amountIn: string;
  readonly minOut: string;
  readonly inspectTimeoutMs: number;
}

function loadConfig(): SmokeConfig {
  const direction = (optionalEnv('HELVETSWAP_DIRECTION') ?? 'AtoB') as
    | 'AtoB'
    | 'BtoA';
  if (direction !== 'AtoB' && direction !== 'BtoA') {
    throw new Error(
      `HELVETSWAP_DIRECTION must be exactly 'AtoB' or 'BtoA' ` +
        `(case-sensitive per SwapTiProcessorService.java:1203). Got '${direction}'.`
    );
  }

  return {
    backendUrl: requireEnv('HELVETSWAP_BACKEND_URL'),
    poolId: requireEnv('HELVETSWAP_POOL_ID'),
    direction,
    amountIn: optionalEnv('HELVETSWAP_AMOUNT_IN') ?? '0.1',
    minOut: optionalEnv('HELVETSWAP_MIN_OUT') ?? '0.0001',
    inspectTimeoutMs:
      Number(optionalEnv('HELVETSWAP_INSPECT_TIMEOUT_SECONDS') ?? '60') * 1000,
  };
}

// ---------------------------------------------------------------------------
// API types — shapes confirmed on Signal 2026-04-20.
// ---------------------------------------------------------------------------

interface TriggerSwapRequest {
  readonly poolId: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amountIn: string;
  readonly minOut: string;
}

interface TriggerSwapResponse {
  readonly requestId: string;
  readonly transferInstructionCid: string;
  readonly submittedAt: string;
  readonly estimatedPickupBy?: string;
}

interface PoolSummary {
  readonly poolId: string;
  readonly reserveA: string;
  readonly reserveB: string;
  readonly fee?: string;
  readonly totalLP?: string;
}

/**
 * Response shape for `/api/swap/inspect`. The exact state vocabulary
 * isn't pinned in Toiki's message yet; we treat any of a small set of
 * string constants as terminal. Unknown states are kept as "pending"
 * so a future state addition on his side doesn't spuriously fail the
 * smoke.
 */
interface SwapInspectResponse {
  readonly requestId: string;
  readonly state?: string;
  readonly status?: string;
  readonly amountOut?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `[smoke] GET ${url} → ${response.status} ${response.statusText}: ${text}`
    );
  }
  return JSON.parse(text) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `[smoke] POST ${url} → ${response.status} ${response.statusText}: ${text}`
    );
  }
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// High-level steps.
// ---------------------------------------------------------------------------

async function readPool(
  backendUrl: string,
  poolId: string
): Promise<PoolSummary | null> {
  const all = await getJson<PoolSummary[]>(joinUrl(backendUrl, '/api/pools'));
  return all.find((p) => p.poolId === poolId) ?? null;
}

async function triggerSwap(
  cfg: SmokeConfig
): Promise<TriggerSwapResponse> {
  const url = joinUrl(cfg.backendUrl, '/api/dev/trigger-swap');
  const body: TriggerSwapRequest = {
    poolId: cfg.poolId,
    direction: cfg.direction,
    amountIn: cfg.amountIn,
    minOut: cfg.minOut,
  };
  return postJson<TriggerSwapResponse>(url, body);
}

/**
 * State labels we treat as terminal. Any response with one of these
 * in `state` or `status` ends the polling loop. Everything else is
 * "still in flight".
 */
const TERMINAL_SUCCESS = new Set([
  'COMPLETED',
  'EXECUTED',
  'CONFIRMED',
  'SUCCESS',
]);
const TERMINAL_FAILURE = new Set([
  'FAILED',
  'REJECTED',
  'EXPIRED',
  'TIMEOUT',
  'ERROR',
]);

function classifyState(r: SwapInspectResponse): 'success' | 'failure' | 'pending' {
  const label = (r.state ?? r.status ?? '').toUpperCase();
  if (TERMINAL_SUCCESS.has(label)) return 'success';
  if (TERMINAL_FAILURE.has(label)) return 'failure';
  return 'pending';
}

async function pollInspect(
  backendUrl: string,
  requestId: string,
  timeoutMs: number
): Promise<SwapInspectResponse> {
  const url = joinUrl(
    backendUrl,
    `/api/swap/inspect?requestId=${encodeURIComponent(requestId)}`
  );
  const deadline = Date.now() + timeoutMs;
  let last: SwapInspectResponse | null = null;

  while (Date.now() < deadline) {
    try {
      last = await getJson<SwapInspectResponse>(url);
    } catch (err) {
      // Endpoint may 404 briefly after submission before the record
      // is indexed. Retry rather than bail.
      last = { requestId, state: 'UNKNOWN_FETCH_ERROR', error: String(err) };
    }
    const verdict = classifyState(last);
    if (verdict !== 'pending') return last;
    await delay(2000);
  }

  return (
    last ?? { requestId, state: 'POLL_TIMEOUT', error: 'no response collected' }
  );
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log(
    `[smoke] config: backend=${cfg.backendUrl} pool=${cfg.poolId} dir=${cfg.direction} in=${cfg.amountIn} minOut=${cfg.minOut}`
  );

  console.log('[smoke] 1/4 — read pool reserves BEFORE swap');
  const before = await readPool(cfg.backendUrl, cfg.poolId);
  if (before === null) {
    throw new Error(
      `[smoke] FAIL — pool ${cfg.poolId} not found at ${cfg.backendUrl}/api/pools. ` +
        `Toiki may have re-seeded; ping Signal for the new pool id.`
    );
  }
  console.log(
    `[smoke]        before: reserveA=${before.reserveA} reserveB=${before.reserveB}`
  );

  console.log('[smoke] 2/4 — POST /api/dev/trigger-swap');
  const triggered = await triggerSwap(cfg);
  console.log(
    `[smoke]        requestId=${triggered.requestId} tiCid=${triggered.transferInstructionCid} submittedAt=${triggered.submittedAt}`
  );

  console.log(
    `[smoke] 3/4 — poll /api/swap/inspect (timeout ${cfg.inspectTimeoutMs / 1000}s)`
  );
  const inspect = await pollInspect(
    cfg.backendUrl,
    triggered.requestId,
    cfg.inspectTimeoutMs
  );
  const verdict = classifyState(inspect);
  console.log(
    `[smoke]        verdict=${verdict} payload=${JSON.stringify(inspect)}`
  );

  console.log('[smoke] 4/4 — read pool reserves AFTER swap');
  const after = await readPool(cfg.backendUrl, cfg.poolId);
  if (after !== null) {
    console.log(
      `[smoke]        after:  reserveA=${after.reserveA} reserveB=${after.reserveB}`
    );
    const deltaA = Number(after.reserveA) - Number(before.reserveA);
    const deltaB = Number(after.reserveB) - Number(before.reserveB);
    console.log(
      `[smoke]        delta:  reserveA=${deltaA.toFixed(10)} reserveB=${deltaB.toFixed(10)}`
    );
    if (verdict === 'success' && deltaA === 0 && deltaB === 0) {
      throw new Error(
        '[smoke] FAIL — inspect reports success but reserves did not move. ' +
          'AMM state is inconsistent with the submit; ping Toiki.'
      );
    }
  }

  if (verdict === 'failure') {
    throw new Error(
      `[smoke] FAIL — swap terminal-failed. requestId=${triggered.requestId} payload=${JSON.stringify(inspect)}`
    );
  }
  if (verdict === 'pending') {
    throw new Error(
      `[smoke] FAIL — poll timed out without a terminal state. ` +
        `requestId=${triggered.requestId} last=${JSON.stringify(inspect)}`
    );
  }

  console.log(
    `[smoke] PASS — full pipeline fired: trigger → poller → processor — requestId=${triggered.requestId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
