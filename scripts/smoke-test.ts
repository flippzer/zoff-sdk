/**
 * DevNet end-to-end smoke test — Toiki's 2026-04-20 revised plan (v2).
 *
 * ## Why this doesn't go through `daml script`
 *
 * An earlier plan had us driving the TransferInstructionV2 creation via
 * `daml script` against the ledger-API gRPC port. Toiki walked that back
 * mid-session: Splice Token Standard deliberately does not expose TI
 * constructors to `daml script` (HoldingPoolTest.daml:3), so real TI
 * creation requires a 1-2 day Splice API detour, not a smoke test. He
 * stood up a dev-only backend endpoint instead.
 *
 * ## Why this uses `app-provider`, not `alice`
 *
 * `alice` exists in Keycloak but has no Canton party, no actAs rights,
 * and no Amulet balance. Provisioning her is ~1 week of work for a
 * smoke test. `app-provider` (password `abc123`) exists as a Keycloak
 * user AND a Canton party with actAs + funded Amulet. The endpoint
 * builds a self-referential swap (app-provider → app-provider) —
 * validates SwapPoller + SwapTiProcessor + AMM math without any
 * user-auth complications. User-auth is a Phase 2/3 concern.
 *
 * ## What this harness does
 *
 *   1. Mint a Keycloak JWT for `app-provider` via the SDK's
 *      `JwtMinter` (public client `app-provider-unsafe`, password
 *      grant, no client_secret).
 *   2. POST the swap request body to
 *      `{HELVETSWAP_BACKEND_URL}/api/dev/trigger-swap` with the JWT
 *      as `Authorization: Bearer`. Body takes `poolId`, not
 *      `poolCid` — endpoint resolves CID server-side.
 *   3. (Optional) SSH into the devnet host and tail the backend log
 *      for `DEV-SWAP`, `SwapPoller`, `SwapTiProcessor` markers keyed
 *      on the returned `requestId`.
 *
 * The harness proves the Helvetswap swap *pipeline* works end-to-end.
 * It does NOT exercise `ZoffProvider`'s wire layer — that's Phase 3,
 * gRPC, still owed.
 *
 * ## Prerequisites
 *
 * - SSH tunnel open (only required if the backend URL is tunnel-local
 *   rather than a public domain, and for the Keycloak call):
 *     ssh -N -T -i ~/.ssh/zoff_devnet_helvetswap \
 *       -L 5001:localhost:5001 \
 *       -L 8082:localhost:8082 \
 *       root@5.9.70.48
 * - `.env.local` populated: AUTH_TEST_PASSWORD=abc123, SYNCHRONIZER_ID,
 *   HELVETSWAP_POOL_ID (from Toiki once the dev endpoint ships),
 *   HELVETSWAP_BACKEND_URL (same).
 * - Optional, only for step 3 (log tail): DEVNET_SSH_HOST +
 *   DEVNET_SSH_KEY. Pass `--skip-log-tail` otherwise.
 *
 * ## Run
 *
 *     npm run smoke
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JwtMinter } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Config — read from process.env with explicit failures.
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required env var ${name}. Populate .env.local from the Signal drop.`
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
  readonly auth: {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly username: string;
    readonly password: string;
  };
  readonly direction: 'AtoB' | 'BtoA';
  readonly amountIn: string;
  readonly minOut: string;
  readonly deadlineMinutes: number;
  readonly skipLogTail: boolean;
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
    auth: {
      tokenUrl: requireEnv('AUTH_TOKEN_URL'),
      clientId: requireEnv('AUTH_CLIENT_ID'),
      username: requireEnv('AUTH_TEST_USERNAME'),
      password: requireEnv('AUTH_TEST_PASSWORD'),
    },
    direction,
    amountIn: optionalEnv('HELVETSWAP_AMOUNT_IN') ?? '1.0',
    minOut: optionalEnv('HELVETSWAP_MIN_OUT') ?? '0.0001',
    deadlineMinutes: Number(optionalEnv('HELVETSWAP_DEADLINE_MINUTES') ?? '10'),
    skipLogTail: process.argv.includes('--skip-log-tail'),
  };
}

// ---------------------------------------------------------------------------
// Swap request body.
//
// Field names + casing pinned to Toiki's 2026-04-20 Signal revision:
// `poolId` (not `poolCid` — server resolves), amounts as decimal strings
// (Decimal-backed server-side), direction case-sensitive exactly 'AtoB'
// | 'BtoA' (the tracker's historical 'A2B'/'B2A' values are wrong; see
// the delivery note for the correction).
// ---------------------------------------------------------------------------

interface SwapRequest {
  readonly poolId: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amountIn: string;
  readonly minOut: string;
  readonly deadline: string;
}

interface SwapResponse {
  readonly requestId: string;
  readonly transferInstructionCid: string;
  readonly submittedAt: string;
  readonly estimatedPickupBy?: string;
}

function buildRequest(cfg: SmokeConfig): SwapRequest {
  const deadline = new Date(
    Date.now() + cfg.deadlineMinutes * 60 * 1000
  ).toISOString();
  return {
    poolId: cfg.poolId,
    direction: cfg.direction,
    amountIn: cfg.amountIn,
    minOut: cfg.minOut,
    deadline,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — POST to the dev endpoint.
// ---------------------------------------------------------------------------

async function submitSwap(
  cfg: SmokeConfig,
  accessToken: string,
  body: SwapRequest
): Promise<SwapResponse> {
  const url = `${cfg.backendUrl.replace(/\/$/, '')}/api/dev/trigger-swap`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `[smoke] dev-submit endpoint unreachable at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      `[smoke] dev-submit failed: ${response.status} ${response.statusText}: ${rawText}`
    );
  }

  const parsed = JSON.parse(rawText) as Partial<SwapResponse>;
  if (
    typeof parsed.requestId !== 'string' ||
    typeof parsed.transferInstructionCid !== 'string' ||
    typeof parsed.submittedAt !== 'string'
  ) {
    throw new Error(
      `[smoke] dev-submit returned malformed body: ${rawText}`
    );
  }
  return parsed as SwapResponse;
}

// ---------------------------------------------------------------------------
// Step 3 — tail the Helvetswap backend log over SSH.
// ---------------------------------------------------------------------------

interface LogWatchResult {
  readonly submitted: boolean;
  readonly polled: boolean;
  readonly completed: boolean;
  readonly errored: boolean;
  readonly lastErrorLine: string | null;
}

async function watchBackendLog(
  requestId: string,
  timeoutMs: number
): Promise<LogWatchResult> {
  const sshHost = requireEnv('DEVNET_SSH_HOST');
  const sshKey = optionalEnv('DEVNET_SSH_KEY') ?? '~/.ssh/zoff_devnet_helvetswap';
  const grepCmd =
    "docker compose -p quickstart logs --tail=500 backend-service | " +
    "grep -E 'DEV-SWAP|SwapPoller|SwapTiProcessor' | tail -100";

  const result: {
    submitted: boolean;
    polled: boolean;
    completed: boolean;
    errored: boolean;
    lastErrorLine: string | null;
  } = {
    submitted: false,
    polled: false,
    completed: false,
    errored: false,
    lastErrorLine: null,
  };

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'ssh',
        ['-i', sshKey, '-o', 'BatchMode=yes', sshHost, grepCmd],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.on('error', reject);
      child.on('exit', () => resolve(stdout));
    });

    for (const line of output.split('\n')) {
      if (!line.includes(requestId)) continue;
      if (line.includes('DEV-SWAP')) result.submitted = true;
      if (line.includes('[SwapPoller] Processing')) result.polled = true;
      if (line.includes('[SwapPoller] Swap completed')) result.completed = true;
      if (
        line.includes('[SwapPoller] Swap failed') ||
        /\[SwapTiProcessor\].*error/i.test(line)
      ) {
        result.errored = true;
        result.lastErrorLine = line.trim();
      }
    }

    if (result.completed || result.errored) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log('[smoke] 1/3 — mint Keycloak JWT for app-provider');
  const minter = new JwtMinter(cfg.auth);
  const accessToken = await minter.getToken();
  console.log(`[smoke]        got token (len=${accessToken.length})`);

  const body = buildRequest(cfg);
  console.log(
    `[smoke] 2/3 — POST ${cfg.backendUrl}/api/dev/trigger-swap`,
    JSON.stringify(body)
  );
  const response = await submitSwap(cfg, accessToken, body);
  console.log(
    `[smoke]        submit OK — requestId=${response.requestId}, ` +
      `tiCid=${response.transferInstructionCid}, submittedAt=${response.submittedAt}`
  );
  // Reference so linter doesn't complain the random UUID helper is unused
  // while this file is mid-flight; it's kept for future memo-payload work.
  void randomUUID;

  if (cfg.skipLogTail) {
    console.log('[smoke] 3/3 — SKIPPED backend log tail (--skip-log-tail)');
    console.log('[smoke] done (submit leg only)');
    return;
  }

  console.log(
    '[smoke] 3/3 — tail Helvetswap backend log for DEV-SWAP / SwapPoller / SwapTiProcessor'
  );
  const watched = await watchBackendLog(response.requestId, 60_000);

  if (!watched.submitted) {
    throw new Error(
      '[smoke] FAIL — DEV-SWAP marker never logged. ' +
        'Endpoint may have accepted the request but not fired its submission handler. ' +
        'Ping Toiki with this requestId: ' +
        response.requestId
    );
  }
  if (watched.errored) {
    throw new Error(
      `[smoke] FAIL — backend errored. Last line: ${watched.lastErrorLine}`
    );
  }
  if (!watched.polled) {
    throw new Error(
      '[smoke] FAIL — SwapPoller never picked up the TI despite DEV-SWAP marker. ' +
        'Handover §6 row 1: check receiver party + memo shape.'
    );
  }
  if (!watched.completed) {
    throw new Error(
      '[smoke] FAIL — SwapPoller picked up the TI but swap did not complete in the window.'
    );
  }

  console.log(
    `[smoke] PASS — full pipeline fired: DEV-SWAP → SwapPoller → SwapTiProcessor — requestId=${response.requestId}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
