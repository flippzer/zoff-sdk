# @zoffwallet/sdk

Reference implementation of [`@zoffwallet/provider-interface`](https://github.com/flippzer/canton-wallet-provider-interface) for Canton Network.

A `ZoffProvider` that speaks the canonical `CantonWalletProvider` contract end-to-end — intended to prove the interface is implementable in practice, and to be the first published consumer against `@zoffwallet/provider-interface`.

## Status

Phase 2 / in bring-up. Target: pass Helvetswap's DevNet end-to-end smoke test (`scripts/smoke-test.ts`).

## Install

```
npm install @zoffwallet/sdk
```

The interface package `@zoffwallet/provider-interface` is a dependency. It is not yet on npm — see [interface repo issue tracker](https://github.com/flippzer/canton-wallet-provider-interface/issues) for publish timing. Until then this package vendors the built `v0.1.2` under `.vendor-provider-interface/` and consumes it via a `file:` dep. That folder disappears the moment the interface lands on npm, at which point the dep becomes a plain `^0.1.2`.

## Usage

```ts
import { ZoffProvider } from '@zoffwallet/sdk';

const zoff = new ZoffProvider({
  ledgerApi: { host: 'localhost', port: 5001, tls: false },
  auth: {
    tokenUrl: 'http://localhost:8082/realms/AppProvider/protocol/openid-connect/token',
    clientId: 'app-provider-unsafe',
    username: 'alice',
    password: '<from-signal>',
  },
  partyId: 'Alice-…::1220…',
});

await zoff.init({ appName: 'my-dapp', network: 'devnet' });
await zoff.connect();

const holdings = await zoff.getHoldings();

const prepared = await zoff.prepareTransfer({
  recipient: 'ClearportX-DEX-1::1220…',
  amount: '1.0',
  instrument: { instrumentAdmin: 'DSO::1220…', instrumentId: 'Amulet' },
  memo: JSON.stringify({ v: 1, requestId: crypto.randomUUID(), /* … */ }),
});

const result = await zoff.submitAndWaitForTransaction(prepared);
```

## DevNet smoke test

`scripts/smoke-test.ts` runs handover §4 end-to-end. Prerequisites:

1. SSH tunnel open:
   ```
   ssh -N -T -i ~/.ssh/zoff_devnet_helvetswap \
     -L 5001:localhost:5001 \
     -L 8082:localhost:8082 \
     root@5.9.70.48
   ```
2. `.env.local` populated from the Signal drop (password, synchronizer id).

Then:

```
npm install
npm run smoke
```

## License

MIT
