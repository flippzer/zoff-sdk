# Changelog

All notable changes to `@zoffwallet/sdk` are documented here.

## [0.1.0-rc.2] — 2026-04-26

Adds `ZoffProvider.withTestingTransport({ autoApprove: true })` for headless CI smoke tests against the popup-approval flows.

### Added

- `ZoffProvider.withTestingTransport(config, options?)` — static factory that returns a `ZoffProvider` whose popup transport is stubbed by an in-memory auto-approve fake. `connect()`, `submitTransaction()`, `submitAndWaitForTransaction()`, and `signMessage()` resolve deterministically without opening a real popup or unlocking a keystore. Pairs cleanly with a fixture `CantonWalletProvider` impl on the dApp side: fixture-provider validates wiring shape, testing-transport validates wallet transport. The HTTPS routes (`/sdk/holdings`, `/sdk/build-transfer-commands`, `/sdk/active-contracts`) are NOT mocked — mock those at the `fetch` level for full isolation. Empty-`commands` validation still throws `INVALID_COMMAND` (canonical-contract assertions are not bypassed). 9 vitest cases cover all three popup types + custom-fixture overrides + the full canonical flow against a mocked fetch.
- `TestingTransportConfig` exported from the package root for typing test harnesses.

### Safety

The factory deliberately has a name that's easy to grep for in a publish checklist. Importing `src/transport/testing.ts` on a production code path silently bypasses user consent — name-grep for `withTestingTransport` in your bundle if you're paranoid.

## [0.1.0-rc.1] — 2026-04-26

Released ahead of the 2026-05-05 target. Published to npm under the `next` tag; GA `0.1.0` follows on 2026-05-08 once devnet smoke + Helvetswap-shape smoke pass.

### Verification + polish (this release)

- Vitest test suites for `HttpClient` `WalletError` mapping (every status code + fetch rejection), `CantonWalletProvider` interface conformance, network-bind, popup origin allowlist, and `onTransactionUpdate` listener registry. 40/40 tests passing.
- `examples/devnet-end-to-end.ts` — full discovery → init → connect → getHoldings → prepareTransfer → submitAndWaitForTransaction smoke runnable in any browser dApp shell.
- README backend → canonical `WalletError` mapping table mirroring `src/transport/http.ts` exactly.
- `tsconfig.json` `sourceMap` + `declarationMap` → false. Published tarball: 23 files / 20.1 kB (was 41 / 28.7 kB), zero `.map` entries.



### Architecture pivot from 2026-04-20 scaffold

The 2026-04-20 scaffold targeted a direct gRPC + Keycloak password-grant flow against Helvetswap's DevNet — a Phase-2 contract-validation harness with Toiki. v0.1.0 instead targets the Zoff wallet backend over HTTP with cross-origin popup approval, so any dApp can install `@zoffwallet/sdk` without provisioning a Canton participant of its own.

The class shape (`ZoffProvider implements CantonWalletProvider`), error helpers (`walletError`, `ZoffWalletError`), package metadata, and dual ESM/CJS build all carry over from the 04-20 scaffold. Auth, config, transport, and the smoke harness do not — all replaced.

### Shipped (Day 1 + Day 2 + Day 3 + Day 3-4 submit)

- `init(InitConfig)` — devnet only in v0.1.x; throws `INVALID_COMMAND` for unsupported networks. Dispatches `canton:announceProvider` on `window` and listens for `canton:requestProvider` to re-announce.
- `disconnect`, `isConnected`, `partyId` (synchronous getter), `getAccount` — implemented end-to-end.
- `prepareTransfer(payload)` — HTTPS to `POST /sdk/build-transfer-commands` on the canton-wallet backend. Returns the canonical `PreparedTransfer { commands, disclosedContracts, synchronizerId, actAs, readAs }` shape with no popup. Backend extracts `buildCommandSet()` from `CcTransferService` / `Cip56TransferService` (no behaviour change to existing `/transfer/prepare` callers). Maps canonical `Amulet` → CC route, all others → CIP-56 route with explicit `instrumentAdmin`.
- `getHoldings()` — HTTPS to `GET /sdk/holdings/:partyId`. Backend combines CC (decay-adjusted via `UpdateStreamService.getAmuletHoldings`) + CIP-56 (via `TokenStandardService.getHoldings`) sources into the canonical `Holding[]` shape with per-contract granularity.
- `connect()` — opens cross-origin approval popup at `<walletOrigin>/sdk/connect`, awaits a `zoff:sdk:connect:response` postMessage, network-binds the wallet's response to the SDK's init network, and stores the resulting `{partyId, authToken}` for downstream HTTP calls. Strict origin allowlist on every inbound message; popup close → `USER_REJECTED`, popup blocked → `USER_REJECTED`, timeout → `TIMEOUT`, malformed response → `VALIDATOR_ERROR`.
- `submitAndWaitForTransaction(opts)` — opens the wallet's `/sdk/sign` approval popup with the canonical `SubmitOptions`, awaits the popup's `/tx/prepare` + signature + `/tx/execute` round-trip, returns canonical `SubmitResult { updateId, completionOffset }`. v0.1.0 backend semantics: `/tx/execute` only returns once the participant has prepared + executed, which is effectively committed-on-synchronizer for our purposes — a future version may swap for an explicit poll-for-offset endpoint.
- `submitTransaction(opts)` — same popup flow as `submitAndWait`; returns `{submissionId}` immediately and emits a synthetic `COMMITTED` `TransactionUpdate` to all `onTransactionUpdate` listeners via `queueMicrotask`. v0.2.0 will distinguish validator-accepted vs committed via a real async update channel.
- `onTransactionUpdate(callback)` — in-memory listener registry. Returns an unsubscribe function. Multiple listeners supported; listener errors are isolated.
- `getActiveContracts({interfaceId?, templateId?})` — HTTPS to `POST /sdk/active-contracts`. Backend proxies Canton's `/v2/state/active-contracts` filtered by either interface or template id. At least one filter must be provided (avoids accidental full-ACS dumps); `interfaceId` takes precedence over `templateId` when both are present.
- `signMessage(message)` — opens cross-origin popup at `/sdk/sign-message`, signs the UTF-8 message in-page (no Canton round-trip), returns hex-encoded Ed25519 signature. dApps verify against the `publicKey` delivered by `connect()` or queried via `getAccount()`.
- The bidirectional sign-popup handshake: popup posts `zoff:sdk:sign:ready` to opener once mounted; opener pushes `zoff:sdk:sign:request` carrying the canonical `commands / actAs / readAs / disclosedContracts`; popup posts `zoff:sdk:sign:response` once `/tx/execute` resolves. The `commands` array can be arbitrarily large; URL params would be the wrong fit, hence the inbound postMessage.
- `HttpClient` transport layer (`src/transport/http.ts`) — Bearer-auth wrapper with status-first canonical `WalletError` mapping (401→`NOT_CONNECTED`, 429→`RATE_LIMITED`, 408/504→`TIMEOUT`, 400→`INVALID_COMMAND`, 5xx→`VALIDATOR_ERROR`). Fetch override supported for tests.
- `openConnectPopup` + `openSignPopup` cross-origin popup helpers (`src/transport/popup.ts`) — exported for advanced consumers; `ZoffProvider.connect`, `submitAndWaitForTransaction`, `submitTransaction` use them internally.
- Submit-method input validation (empty `commands` → `INVALID_COMMAND`).

### Pending

All canonical methods of `CantonWalletProvider@0.1.2` are now shipped end-to-end. Remaining v0.1.0-rc.1 work is verification and polish:

- Unit tests against `HttpClient` (mocked fetch), `WalletError` mapping table, network-bind validation.
- `examples/devnet-end-to-end.ts` for the publish dry-run install.
- README error-code table + EIP-6963 example polish.
- `npm pack` hygiene — exclude source maps from the published tarball.

Stubbed methods throw `WalletError { code: 'UNKNOWN', details: { method } }` with a message pointing at this plan; they do not violate the canonical contract surface.

### v0.2.0 capability-token migration plan (informational)

v0.1.0 wraps the Zoff wallet's existing 30-min HS-256 JWT (issued by `/auth/verify`) in `ConnectResult.authToken`. v0.2.0 will swap the transport to a short-lived capability token bound to dApp origin + party + chain, sourced from a new wallet endpoint (design output of the 2026-04-29 call). The dApp-facing `ConnectResult.authToken` shape does not change — `authToken` is opaque per the canonical contract — so the v0.2.0 swap is interface-stable. dApps written against v0.1.0 will continue working unchanged on v0.2.0.

## [2026-04-20] — pre-flight smoke harness (superseded)

Initial scaffold. `ZoffProvider` interface-conformant at the type level; methods stubbed pending a gRPC submit path. Smoke harness against Helvetswap's DevNet `/api/dev/trigger-swap` endpoint via SSH tunnel + Keycloak password-grant. Superseded by the v0.1.0 architecture above; the harness sources are removed in this changeset, preserved in git history.
