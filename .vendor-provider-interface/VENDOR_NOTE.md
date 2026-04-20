# Vendored — temporary

This folder is a **vendored copy** of `@zoffwallet/provider-interface@0.1.2`, built from [flippzer/canton-wallet-provider-interface@v0.1.2](https://github.com/flippzer/canton-wallet-provider-interface/releases/tag/v0.1.2). It exists so `@zoffwallet/sdk` can consume the interface via a `file:` dep while the interface is not yet on npm.

## Why vendored instead of `github:...#v0.1.2`?

Installing from a git URL fetches the source tree but has no way to compile it: v0.1.2 has no `prepare` script. `node_modules/@zoffwallet/provider-interface/dist/` would be missing, and the consumer would fail to resolve the package.

Modifying the frozen v0.1.2 tag to add a `prepare` script is out of scope — the interface is intentionally frozen. A future `0.1.3` or the npm publish will unblock the clean dep.

## Removal

Delete this folder and change the parent `package.json`:

```diff
- "@zoffwallet/provider-interface": "file:./.vendor-provider-interface"
+ "@zoffwallet/provider-interface": "^0.1.2"
```

…the moment the interface is published to npm.
