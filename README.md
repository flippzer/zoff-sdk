# @zoffwallet/sdk

Reference implementation of [`@zoffwallet/provider-interface`](https://github.com/flippzer/canton-wallet-provider-interface) for Canton Network — a browser SDK that any dApp can install from npm and target the canonical `CantonWalletProvider` contract end-to-end against the Zoff wallet.

## Status

Pre-release. v0.1.0-rc.1 publish target: 2026-05-05 EOD under npm `next` tag. v0.1.0 GA: 2026-05-08 under `latest`. See [`CHANGELOG.md`](./CHANGELOG.md).

## Install

```
npm install @zoffwallet/sdk @zoffwallet/provider-interface
```

`@zoffwallet/provider-interface` is a peer dependency: dApps install it directly so they can import the canonical types without coupling to a wallet implementation.

## Usage

```ts
import { ZoffProvider } from '@zoffwallet/sdk';

const zoff = new ZoffProvider();
await zoff.init({ appName: 'my-dapp', network: 'devnet' });

const { partyId, authToken } = await zoff.connect();

const prepared = await zoff.prepareTransfer({
  recipient: 'Recipient::1220...',
  amount: '1.0',
  instrument: { instrumentAdmin: 'DSO::1220...', instrumentId: 'Amulet' },
});

const result = await zoff.submitAndWaitForTransaction(prepared);
// result.updateId, result.completionOffset
```

## Discovery (EIP-6963 style)

The SDK dispatches `canton:announceProvider` on `window` as `init()` resolves. dApps that want multi-wallet support listen for it:

```ts
import type { CantonWalletAnnounceEvent } from '@zoffwallet/provider-interface';

const providers = new Map<string, { info: CantonWalletInfo; provider: CantonWalletProvider }>();

window.addEventListener('canton:announceProvider', (e) => {
  const { info, provider } = (e as CantonWalletAnnounceEvent).detail;
  providers.set(info.uuid, { info, provider });
});

window.dispatchEvent(new Event('canton:requestProvider'));
```

The SDK also listens for `canton:requestProvider` and re-announces, so late-registered listeners still receive the provider.

## Networks

| Network    | v0.1.x | Wallet origin                | Backend origin                    |
|------------|--------|------------------------------|-----------------------------------|
| `devnet`   | ✅     | `https://devnet.zoff.app`    | `https://api.devnet.zoff.app`     |
| `mainnet`  | —      | not supported                | not supported                     |
| `testnet`  | —      | not supported                | not supported                     |

`init({network: 'mainnet' | 'testnet'})` throws `WalletError { code: 'INVALID_COMMAND' }`. Mainnet support follows the FeaturedAppRight grant; tracked separately.

## Errors

Every error a `ZoffProvider` method throws is a `WalletError` from the canonical interface — discriminate on `error.code`, never on `error.message`. The seven canonical codes:

| Code               | Meaning                                                                         |
|--------------------|---------------------------------------------------------------------------------|
| `USER_REJECTED`    | User declined in the wallet UI.                                                 |
| `RATE_LIMITED`     | Backend rate-limited; check `details.retryAfterMs` when present.                |
| `NOT_CONNECTED`    | Method called before `connect()` or after `disconnect()`.                       |
| `TIMEOUT`          | Operation exceeded its window.                                                  |
| `VALIDATOR_ERROR`  | Backend or ledger-API failure.                                                  |
| `INVALID_COMMAND`  | Malformed payload — unknown network, missing required field, etc.               |
| `UNKNOWN`          | Unclassified failure.                                                           |

### Backend → canonical mapping

`@zoffwallet/sdk` calls the canton-wallet backend via HTTPS. The mapping from HTTP status to canonical `code` is, in order:

| HTTP status                                | `code`             |
|--------------------------------------------|--------------------|
| `401`                                      | `NOT_CONNECTED`    |
| `429`                                      | `RATE_LIMITED`     |
| `408`, `504`                               | `TIMEOUT`          |
| `400` (or backend `code: INVALID_ARGUMENT`)| `INVALID_COMMAND`  |
| `5xx`                                      | `VALIDATOR_ERROR`  |
| anything else                              | `UNKNOWN`          |

Network failures (fetch rejection) map to `VALIDATOR_ERROR` with `details.cause: 'fetch_failed'`. The original HTTP status and any backend code are preserved on `details.backendStatus` / `details.backendCode` for tooling — but per the canonical contract callers MUST discriminate on `code`.

## Example

See [`examples/devnet-end-to-end.ts`](./examples/devnet-end-to-end.ts) for a self-contained EIP-6963 discovery → init → connect → getHoldings → prepareTransfer → submitAndWaitForTransaction smoke against devnet.

## CI / headless testing

For CI smokes that exercise the SDK end-to-end without a real popup or a human, use `ZoffProvider.withTestingTransport`:

```ts
import { ZoffProvider } from '@zoffwallet/sdk';

const provider = ZoffProvider.withTestingTransport({
  autoApprove: true,
  // Optional — every fixture has a deterministic default
  party: { partyId: 'TestParty::1220...test', authToken: 'test-jwt' },
  submit: { transactionId: 'test-tx-id', completionOffset: 1 },
});

await provider.init({ appName: 'ci-smoke', network: 'devnet' });
await provider.connect();                                     // resolves instantly with the fixture party
const result = await provider.submitAndWaitForTransaction({   // resolves with fixture transactionId
  commands: [...],
  actAs: provider.partyId!,
});
```

The HTTPS-direct routes (`prepareTransfer`, `getHoldings`, `getActiveContracts`) are NOT mocked — they still hit `backendOrigin`. Mock those at the `fetch` level for full isolation, or point `backendOrigin` to a test backend.

Empty-`commands` validation still throws `INVALID_COMMAND` — canonical-contract guarantees are not bypassed by the testing transport. Only the popup approval is faked.

**Do not use in production code paths.** Any provider returned by `withTestingTransport` silently bypasses user consent. The name is deliberately easy to grep for in a publish checklist.

## License

MIT
