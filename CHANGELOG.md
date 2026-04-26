# Changelog

All notable changes to `@zoffwallet/sdk` are documented here.

## [Unreleased] — v0.1.0-rc.1 (target 2026-05-05)

### Architecture pivot from 2026-04-20 scaffold

The 2026-04-20 scaffold targeted a direct gRPC + Keycloak password-grant flow against Helvetswap's DevNet — a Phase-2 contract-validation harness with Toiki. v0.1.0 instead targets the Zoff wallet backend over HTTP with cross-origin popup approval, so any dApp can install `@zoffwallet/sdk` without provisioning a Canton participant of its own.

The class shape (`ZoffProvider implements CantonWalletProvider`), error helpers (`walletError`, `ZoffWalletError`), package metadata, and dual ESM/CJS build all carry over from the 04-20 scaffold. Auth, config, transport, and the smoke harness do not — all replaced.

### Shipped (Day 1 + Day 2)

- `init(InitConfig)` — devnet only in v0.1.x; throws `INVALID_COMMAND` for unsupported networks. Dispatches `canton:announceProvider` on `window` and listens for `canton:requestProvider` to re-announce.
- `disconnect`, `isConnected`, `partyId` (synchronous getter), `getAccount` — implemented end-to-end.
- `prepareTransfer(payload)` — HTTPS to `POST /sdk/build-transfer-commands` on the canton-wallet backend. Returns the canonical `PreparedTransfer { commands, disclosedContracts, synchronizerId, actAs, readAs }` shape with no popup. Backend extracts `buildCommandSet()` from `CcTransferService` / `Cip56TransferService` (no behaviour change to existing `/transfer/prepare` callers). Maps canonical `Amulet` → CC route, all others → CIP-56 route with explicit `instrumentAdmin`.
- `getHoldings()` — HTTPS to `GET /sdk/holdings/:partyId`. Backend combines CC (decay-adjusted via `UpdateStreamService.getAmuletHoldings`) + CIP-56 (via `TokenStandardService.getHoldings`) sources into the canonical `Holding[]` shape with per-contract granularity.
- `HttpClient` transport layer (`src/transport/http.ts`) — Bearer-auth wrapper with status-first canonical `WalletError` mapping (401→`NOT_CONNECTED`, 429→`RATE_LIMITED`, 408/504→`TIMEOUT`, 400→`INVALID_COMMAND`, 5xx→`VALIDATOR_ERROR`). Fetch override supported for tests.
- Submit-method input validation (empty `commands` → `INVALID_COMMAND`).

### Pending

- `connect()` — popup-based approval handshake against `https://devnet.zoff.app/wallet/sdk/connect`. Until shipped, methods that require auth throw `NOT_CONNECTED`.
- `getActiveContracts()` — needs new backend route `POST /sdk/active-contracts`.
- `submitAndWaitForTransaction()`, `submitTransaction()` — popup approval at `https://devnet.zoff.app/wallet/sdk/sign`, then HTTPS against existing `/tx/prepare` + `/tx/execute`.
- `onTransactionUpdate(callback)` — in-memory listener registry that emits `COMMITTED` after `/tx/execute` resolves and `FAILED` on errors.
- `signMessage(message)` — popup approval, signs with the keystore-unlocked Ed25519 key.

Stubbed methods throw `WalletError { code: 'UNKNOWN', details: { method } }` with a message pointing at this plan; they do not violate the canonical contract surface.

### v0.2.0 capability-token migration plan (informational)

v0.1.0 wraps the Zoff wallet's existing 30-min HS-256 JWT (issued by `/auth/verify`) in `ConnectResult.authToken`. v0.2.0 will swap the transport to a short-lived capability token bound to dApp origin + party + chain, sourced from a new wallet endpoint (design output of the 2026-04-29 call). The dApp-facing `ConnectResult.authToken` shape does not change — `authToken` is opaque per the canonical contract — so the v0.2.0 swap is interface-stable. dApps written against v0.1.0 will continue working unchanged on v0.2.0.

## [2026-04-20] — pre-flight smoke harness (superseded)

Initial scaffold. `ZoffProvider` interface-conformant at the type level; methods stubbed pending a gRPC submit path. Smoke harness against Helvetswap's DevNet `/api/dev/trigger-swap` endpoint via SSH tunnel + Keycloak password-grant. Superseded by the v0.1.0 architecture above; the harness sources are removed in this changeset, preserved in git history.
