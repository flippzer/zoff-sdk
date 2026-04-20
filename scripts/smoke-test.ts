/**
 * DevNet end-to-end smoke test — Toiki's handover §4, path 1.
 *
 * Architectural note: this script DOES NOT exercise `ZoffProvider`'s
 * wire layer. That's intentional and aligned with Toiki's 2026-04-20
 * Signal response: the smoke test's job is to validate the
 * *Helvetswap swap pipeline contract* (memo schema, TI shape,
 * SwapPoller/SwapTiProcessor fire), not the SDK's gRPC client. The
 * gRPC client lands in Phase 3.
 *
 * So this harness:
 *   1. Mints a Keycloak JWT for `alice` via the SDK's `JwtMinter`.
 *   2. Runs `daml script` as a subprocess, passing the JWT and the
 *      canonical memo JSON through to the public Daml SDK's submit
 *      flow against `localhost:5001` (ledger-API gRPC, SSH-tunneled).
 *   3. Tails the Helvetswap backend log over SSH and asserts the
 *      expected `SwapPoller` / `SwapTiProcessor` lines fire within
 *      the synchronizer commit window (~10s).
 *
 * Prerequisites on the laptop running this:
 *   - SSH tunnel open:
 *       ssh -N -T -i ~/.ssh/zoff_devnet_helvetswap \
 *         -L 5001:localhost:5001 \
 *         -L 8082:localhost:8082 \
 *         root@5.9.70.48
 *   - `.env.local` populated with AUTH_TEST_PASSWORD, SYNCHRONIZER_ID
 *     (both Signal-delivered).
 *   - Daml SDK installed (`curl -sSL https://get.daml.com/ | sh`).
 *   - SSH access to devnet host for the log-tail step, OR pass
 *     `--skip-log-tail` to only drive the submit half.
 *
 * Run:
 *   npm run smoke
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JwtMinter } from '../src/auth.js';

// ---------------------------------------------------------------------------
// Config helpers — read from process.env with explicit failures.
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
  readonly ledgerHost: string;
  readonly ledgerPort: number;
  readonly synchronizerId: string;
  readonly operatorPartyId: string;
  readonly alicePartyId: string;
  readonly auth: {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly username: string;
    readonly password: string;
  };
  readonly damlScriptPath?: string;
  readonly skipLogTail: boolean;
}

function loadConfig(): SmokeConfig {
  return {
    ledgerHost: requireEnv('LEDGER_API_HOST'),
    ledgerPort: Number(requireEnv('LEDGER_API_PORT')),
    synchronizerId: requireEnv('SYNCHRONIZER_ID'),
    operatorPartyId: requireEnv('OPERATOR_PARTY_ID'),
    alicePartyId: requireEnv('ZOFF_TEST_PARTY_ID'),
    auth: {
      tokenUrl: requireEnv('AUTH_TOKEN_URL'),
      clientId: requireEnv('AUTH_CLIENT_ID'),
      username: requireEnv('AUTH_TEST_USERNAME'),
      password: requireEnv('AUTH_TEST_PASSWORD'),
    },
    ...(optionalEnv('DAML_SCRIPT_PATH') !== undefined
      ? { damlScriptPath: optionalEnv('DAML_SCRIPT_PATH') as string }
      : {}),
    skipLogTail: process.argv.includes('--skip-log-tail'),
  };
}

// ---------------------------------------------------------------------------
// Step 1 — canonical memo per handover §5.
// ---------------------------------------------------------------------------

function buildMemo(
  operatorPartyId: string,
  opts: { requestId?: string; poolCid?: string } = {}
): string {
  const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const memo = {
    v: 1,
    requestId: opts.requestId ?? randomUUID(),
    poolCid: opts.poolCid ?? '<set-via-toiki-daml-script-sample>',
    direction: 'A2B',
    minOut: '0',
    receiverParty: operatorPartyId,
    deadline,
  };
  return JSON.stringify(memo);
}

// ---------------------------------------------------------------------------
// Step 2 — run the daml-script subprocess.
// ---------------------------------------------------------------------------
//
// Populated once Toiki shares the canonical script. Expected shape:
//
//   daml script \
//     --dar <path-to-dar-with-TransferInstructionV2> \
//     --script-name Zoff.Smoke:submitTransferTi \
//     --ledger-host localhost --ledger-port 5001 \
//     --access-token-file <tmp-token-file> \
//     --input-file <tmp-args-file> \
//     --output-file <tmp-result-file>
//
// Args passed into the script (JSON):
//   { sender: alice, receiver: operator, memo: <canonical-JSON>, synchronizerId }
//
// The actual `.dar` build + script upload is Toiki-owned; our job here is
// to pass through the values cleanly.

async function runDamlScript(
  cfg: SmokeConfig,
  accessToken: string,
  memo: string
): Promise<{ updateId: string; durationMs: number }> {
  if (cfg.damlScriptPath === undefined) {
    throw new Error(
      'DAML_SCRIPT_PATH is not set — cannot run the smoke submit. ' +
        'Toiki is sending the canonical `.daml` script path via Signal; ' +
        'drop it in .env.local once received.'
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), 'zoff-smoke-'));
  const tokenFile = join(workDir, 'token');
  const argsFile = join(workDir, 'args.json');
  const outputFile = join(workDir, 'result.json');

  try {
    await writeFile(tokenFile, accessToken, 'utf8');
    await writeFile(
      argsFile,
      JSON.stringify({
        sender: cfg.alicePartyId,
        receiver: cfg.operatorPartyId,
        synchronizerId: cfg.synchronizerId,
        memo,
      }),
      'utf8'
    );

    const startedAt = Date.now();
    const damlArgs = [
      'script',
      '--dar',
      cfg.damlScriptPath,
      '--script-name',
      'Zoff.Smoke:submitTransferTi',
      '--ledger-host',
      cfg.ledgerHost,
      '--ledger-port',
      String(cfg.ledgerPort),
      '--access-token-file',
      tokenFile,
      '--input-file',
      argsFile,
      '--output-file',
      outputFile,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('daml', damlArgs, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`daml script exited with code ${code}`));
      });
    });

    const rawResult = await (await import('node:fs/promises')).readFile(outputFile, 'utf8');
    const parsed = JSON.parse(rawResult) as { updateId?: string };
    if (typeof parsed.updateId !== 'string') {
      throw new Error(`daml script output missing updateId: ${rawResult}`);
    }

    return { updateId: parsed.updateId, durationMs: Date.now() - startedAt };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Step 3 — tail the Helvetswap backend log over SSH.
// ---------------------------------------------------------------------------

interface LogWatchResult {
  readonly polled: boolean;
  readonly completed: boolean;
  readonly errored: boolean;
  readonly lastRequestId: string | null;
  readonly lastErrorLine: string | null;
}

async function watchBackendLog(
  timeoutMs: number = 30_000
): Promise<LogWatchResult> {
  const sshHost = requireEnv('DEVNET_SSH_HOST');
  const sshKey = optionalEnv('DEVNET_SSH_KEY') ?? '~/.ssh/zoff_devnet_helvetswap';
  const grepCmd =
    "docker compose -p quickstart logs --tail=200 backend-service | " +
    "grep -E 'SwapPoller|SwapTiProcessor' | tail -50";

  const result: {
    polled: boolean;
    completed: boolean;
    errored: boolean;
    lastRequestId: string | null;
    lastErrorLine: string | null;
  } = {
    polled: false,
    completed: false,
    errored: false,
    lastRequestId: null,
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
      const processingMatch = line.match(/\[SwapPoller\] Processing swap requestId=(\S+)/);
      if (processingMatch !== null) {
        result.polled = true;
        result.lastRequestId = processingMatch[1] ?? null;
      }
      if (/\[SwapPoller\] Swap completed/.test(line)) {
        result.completed = true;
      }
      if (/\[SwapPoller\] Swap failed/.test(line) || /\[SwapTiProcessor\].*error/i.test(line)) {
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
// Main — runs §4 steps 1-6 in order, reports a clear final verdict.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.log('[smoke] 1/4 — mint Keycloak JWT for alice');
  const minter = new JwtMinter(cfg.auth);
  const accessToken = await minter.getToken();
  console.log(`[smoke]        got token (len=${accessToken.length})`);

  console.log('[smoke] 2/4 — build canonical memo (handover §5)');
  const memo = buildMemo(cfg.operatorPartyId);
  console.log(`[smoke]        memo: ${memo}`);

  console.log('[smoke] 3/4 — run daml script to submit the TransferInstructionV2');
  const { updateId, durationMs } = await runDamlScript(cfg, accessToken, memo);
  console.log(`[smoke]        submit OK, updateId=${updateId} (${durationMs}ms)`);

  if (cfg.skipLogTail) {
    console.log('[smoke] 4/4 — SKIPPED backend log tail (--skip-log-tail)');
    console.log('[smoke] done (submit leg only)');
    return;
  }

  console.log('[smoke] 4/4 — tail Helvetswap backend log for swap pipeline events');
  const watched = await watchBackendLog();
  if (!watched.polled) {
    throw new Error(
      '[smoke] FAIL — SwapPoller never picked up the TI. ' +
        'Check receiver party matches OPERATOR_PARTY_ID and memo shape is canonical. ' +
        'Handover §6 row 1.'
    );
  }
  if (watched.errored) {
    throw new Error(
      `[smoke] FAIL — SwapPoller or SwapTiProcessor errored. Last error line: ${watched.lastErrorLine}`
    );
  }
  if (!watched.completed) {
    throw new Error(
      '[smoke] FAIL — SwapPoller picked up the TI but swap did not complete within the window.'
    );
  }

  console.log(
    `[smoke] PASS — SwapPoller processed and completed requestId=${watched.lastRequestId ?? '?'}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
