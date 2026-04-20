# @zoffwallet/provider-interface

The canonical TypeScript interface that any Canton Network wallet implements so any dApp can target a single contract instead of N wallet-specific SDKs.

Zero runtime dependencies. Types only.

## What

A single package that defines the `CantonWalletProvider` interface, the associated data types (`Holding`, `PreparedTransfer`, `SubmitOptions`, `WalletError`, …), and the event shapes for EIP-6963-style wallet discovery on Canton. Wallets implement the interface; dApps import the types and program against them.

This package is pure TypeScript. It contains no runtime logic — no classes, no default implementations, no helpers, no normalizers. Every exported symbol is a type or an interface. The compiled JavaScript artifacts are empty by design.

## Why

This package was born from the Zoff ↔ Helvetswap alignment work in April 2026. We audited the existing Loop SDK and found two recurring classes of pain:

1. **Multi-shape chaos.** Helvetswap's front-end carried extractors that probed four different field paths (`commands`, `payload.commands`, `commandPayload.commands`, `command_payload.commands`) because the Loop SDK's output shape drifted over time. Every dApp that integrated Loop was paying the same tax.
2. **Private-but-critical APIs.** The most important method for a DEX integration — `prepareTransfer` — was nested under `provider.connection.prepareTransfer`, undocumented, and subject to change across patch versions. Partners built on it anyway, because they had to.

Both problems are symptoms of the same underlying cause: there is no stable, wallet-neutral contract for Canton. Every wallet invents its own surface; every dApp couples to the one it integrated first.

`@zoffwallet/provider-interface` is that stable contract. It is intentionally minimal, intentionally strict (one canonical shape per input and output, camelCase only, typed error codes), and intentionally decoupled from any specific wallet's implementation details.

## Who implements it

- **Zoff** — in progress (`@zoff/sdk`, publishing alongside v0.1.0 of this interface).
- **Loop** — proposed. If Fivenorth chooses to implement, dApps can swap wallets without touching their integration code.
- **Future Canton wallets** — the interface is published under MIT and is explicitly designed for multi-vendor adoption.

Implementations are independently owned and independently licensed. This package's MIT license covers the interface types only.

## How a dApp uses it

### Discovery

Discover all installed Canton wallets via EIP-6963-style events:

```ts
import type {
  CantonWalletProvider,
  CantonWalletAnnounceEvent,
} from '@zoffwallet/provider-interface';

const providers = new Map<string, { info; provider: CantonWalletProvider }>();

window.addEventListener('canton:announceProvider', (event) => {
  const { info, provider } = (event as CantonWalletAnnounceEvent).detail;
  providers.set(info.uuid, { info, provider });
});

window.dispatchEvent(new Event('canton:requestProvider'));
```

### Prepare + submit a transfer

The canonical flow for any transfer-based interaction — plain sends, DEX swaps via `TransferInstructionV2` + backend consume, liquidity operations, etc. — is `prepareTransfer` followed by `submitAndWaitForTransaction`.

```ts
import type { CantonWalletProvider } from '@zoffwallet/provider-interface';

async function swap(provider: CantonWalletProvider) {
  await provider.init({ appName: 'Helvetswap', network: 'devnet' });
  const { partyId } = await provider.connect();

  const prepared = await provider.prepareTransfer({
    recipient: HELVETSWAP_OPERATOR_PARTY,
    amount: '100.0',
    instrument: {
      instrumentAdmin: AMULET_ADMIN,
      instrumentId: 'Amulet',
    },
    memo: JSON.stringify({
      v: 1,
      requestId: 'swap-...',
      poolCid: '...',
      direction: 'A2B',
      minOut: '99.5',
      receiverParty: partyId,
      deadline: '2026-04-19T12:00:00Z',
    }),
  });

  const result = await provider.submitAndWaitForTransaction({
    commands: prepared.commands,
    disclosedContracts: prepared.disclosedContracts,
    packageIdSelectionPreference: prepared.packageIdSelectionPreference,
    synchronizerId: prepared.synchronizerId,
    actAs: prepared.actAs,
    readAs: prepared.readAs,
  });

  console.log('submitted:', result.updateId);
}
```

Every error is a typed `WalletError { code, message, details? }` — `code` is a string-literal union, so `switch (err.code)` is exhaustive and string-matching on `message` is never needed.

## Consumer notes

### `exactOptionalPropertyTypes`

This package ships with `exactOptionalPropertyTypes` enabled. To omit an optional field, leave it out entirely — don't pass `undefined` explicitly. `{ memo: undefined }` is a type error; `{}` is not.

## Versioning policy

This package follows [semver](https://semver.org/):

- **Patch releases** fix documentation, tighten JSDoc, or correct typos. No type changes.
- **Minor releases** add optional fields, add optional methods, or add new types. Existing implementations continue to compile.
- **Major releases** introduce breaking changes — renamed fields, removed methods, stricter required fields.

Additions to the interface follow a lightweight RFC process: proposed changes are opened as GitHub issues with a rationale and, where applicable, a reference to the CIP, Splice release, or partner contract that motivates them. Consensus among known implementers (Zoff and any wallet that has published its own implementation) is required before a minor or major release.

No breaking change ships without at least one minor release of deprecation notice when feasible.

## Scope

**In scope:** transfer preparation and submission, holdings queries, active-contract queries, arbitrary message signing (optional), wallet discovery.

**Out of scope (for now):** direct ledger-API command construction by the dApp (the wallet is expected to produce the full `commands` array), multi-account selection within a single connection, cross-chain routing, fee estimation, attribution metadata. Some of these may land in future minor releases if they turn out to be universally needed.

## License

MIT. See [LICENSE](./LICENSE).

The MIT license covers this interface package only. Wallet implementations (e.g. `@zoff/sdk`) and dApp integrations are independently licensed by their respective authors.
