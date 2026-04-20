# Changelog

All notable changes to `@zoffwallet/provider-interface` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package follows [semver](https://semver.org/).

## 0.1.2 — 2026-04-20 — Package rename to `@zoffwallet/provider-interface`

Renamed the npm package from `@canton-wallet/provider-interface` to `@zoffwallet/provider-interface`. No behavioral or type-surface change — consumers update imports, nothing else.

### Changed

- `package.json` `name`: `@canton-wallet/provider-interface` → `@zoffwallet/provider-interface`.
- README + this CHANGELOG: all references updated.

### Migration

```ts
// before (0.1.0 / 0.1.1)
import type { CantonWalletProvider } from '@canton-wallet/provider-interface';

// after (0.1.2)
import type { CantonWalletProvider } from '@zoffwallet/provider-interface';
```

The `CantonWalletProvider` interface name and all exported types are unchanged — only the package name under which they are shipped. `0.1.1` was never published to NPM, so no production consumer is affected. The GitHub repo keeps its neutral-descriptive name (`flippzer/canton-wallet-provider-interface`) to signal the interface is implementable by any wallet — only the npm scope reflects the primary maintainer.

## 0.1.1 — 2026-04-20 — Post-review polish

Documentation tightening and one small type addition, all from Toiki's PR #23 review. No breaking changes to the 0.1.0 surface.

### Added

- `AccountInfo.participantId?: string` — optional field for multi-participant topologies. Wallets without multi-participant awareness remain conformant by omitting the field.

### Changed

- JSDoc on `SubmitOptions.commands`: empty arrays MUST throw `WalletError { code: 'INVALID_COMMAND' }`.
- JSDoc on `submitAndWaitForTransaction`: `opts.mode` is ignored; behavior is always `WAIT`. Implementations MUST NOT short-circuit. A future major may narrow the parameter type to exclude `mode`.
- JSDoc on `InitConfig.options`: added explicit warning that future versions may remove or restrict the field.
- JSDoc on `CantonWalletInfo.icon`: specified minimum resolution 96×96 (192×192 recommended for retina).
- README: added `Consumer notes` section documenting `exactOptionalPropertyTypes` behavior.

### Deferred (open issues, not in this release)

- `Contract.contractKey?` / `Contract.createdAt?` — gated on concrete consumer need (see [#4](https://github.com/flippzer/canton-wallet-provider-interface/issues/4)).
- `getTransactionStatus(submissionId)` method for orphaned-submission recovery — targeted for 0.2.0 (see [#8](https://github.com/flippzer/canton-wallet-provider-interface/issues/8)).

## 0.1.0 — 2026-04-19 — Initial draft

First publishable draft of the Canton wallet provider interface. Types-only package, zero runtime dependencies.

### Added

Core data types (`src/types.ts`):

- `Holding` — a fungible-instrument holding owned by the connected party.
- `DisclosedContract` — a disclosed contract supplied alongside a prepared or submitted command.
- `Command` — opaque ledger-API command, forwarded verbatim by the wallet.
- `PrepareTransferPayload` — input to `prepareTransfer`.
- `PreparedTransfer` — canonical output of `prepareTransfer`.
- `SubmitMode` — `'WAIT' | 'ASYNC'`.
- `SubmitOptions` — options for `submitTransaction` and `submitAndWaitForTransaction`.
- `SubmitResult` — result of a successful `submitAndWaitForTransaction`.
- `TransactionStatus` — `'PENDING' | 'COMMITTED' | 'FAILED'`.
- `TransactionUpdate` — asynchronous update emitted via `onTransactionUpdate`.
- `Contract` — an active contract returned by `getActiveContracts`.
- `AccountInfo` — basic account info for display and sanity checks. `network` is typed as `SupportedNetwork` (not loose `string`) so the canonical-shape rule holds end-to-end.
- `WalletErrorCode` — string-literal union of typed error codes.
- `WalletError` — canonical error contract.
- `SupportedNetwork` — `'mainnet' | 'devnet' | 'testnet'`. Lives in `types.ts` so both `InitConfig.network` and `AccountInfo.network` can reference the same literal union.

Provider interface (`src/provider.ts`):

- `InitConfig` — argument to `init`.
- `ConnectResult` — return value of `connect`.
- `CantonWalletProvider` — the main interface every wallet implements.

Discovery events (`src/discovery.ts`):

- `CantonWalletInfo` — wallet metadata surfaced in dApp UI.
- `CantonWalletAnnounceDetail` — payload of `canton:announceProvider`.
- `CantonWalletAnnounceEvent` — event type for `canton:announceProvider`.
- `CantonWalletRequestEvent` — event type for `canton:requestProvider`.

### Notes

- All field names are strict camelCase. No snake_case fallback and no multi-shape fallback is tolerated by the interface.
- `Command`, `SubmitResult.events`, `TransactionUpdate.updateData`, and `Contract.payload` are intentionally opaque (`Record<string, unknown>` or `unknown`). Pinning their shape in this package would couple every wallet implementation to a specific Canton ledger-API version.
- `prepareTransfer` is a top-level method of the interface, never nested under a sub-object.
- Implementations MUST NOT apply hidden client-side rate limiting. Rate-limit signals MUST be surfaced as `WalletError { code: 'RATE_LIMITED' }`.
