/**
 * Construction-time + network-derived config for {@link ZoffProvider}.
 *
 * `ZoffProviderOptions` is the dApp-side construction surface. All fields
 * are optional: a no-arg construction picks defaults derived from
 * `init({network})` at init time. The only reason to pass options is for
 * local development (override the wallet origin to point at a dev wallet
 * server) or for tests (point both origins at a fixture server).
 *
 * Production dApps SHOULD NOT pass these. Setting either bypasses the
 * canonical network-to-origin map.
 */
import type { SupportedNetwork } from '@zoffwallet/provider-interface';

/** Networks `@zoffwallet/sdk` v0.1.x can be initialized against. */
export const SUPPORTED_NETWORKS: readonly SupportedNetwork[] = ['devnet', 'mainnet'];

/**
 * Wallet origin per network — the cross-origin target for approval
 * popups (`/sdk/connect`, `/sdk/sign`).
 *
 * `undefined` means "not supported in this build". `init({network: ...})`
 * with such a network throws `WalletError { code: 'INVALID_COMMAND' }`.
 */
export const NETWORK_TO_WALLET_ORIGIN: Readonly<
  Record<SupportedNetwork, string | undefined>
> = {
  devnet: 'https://devnet.zoff.app',
  mainnet: 'https://zoff.app',
  testnet: undefined,
};

/**
 * Backend origin per network — the REST target for the canon-conformant
 * `/sdk/*` routes (`build-transfer-commands`, `holdings/:partyId`,
 * `active-contracts`) plus the existing `/auth/*` and `/tx/*` endpoints.
 *
 * Same `undefined` semantics as {@link NETWORK_TO_WALLET_ORIGIN}.
 */
export const NETWORK_TO_BACKEND_ORIGIN: Readonly<
  Record<SupportedNetwork, string | undefined>
> = {
  devnet: 'https://api.devnet.zoff.app',
  mainnet: 'https://api.zoff.app',
  testnet: undefined,
};

export interface ZoffProviderOptions {
  /**
   * Override the wallet origin used for popup approval. Defaults to
   * {@link NETWORK_TO_WALLET_ORIGIN}`[network]` resolved at init time.
   */
  readonly walletOrigin?: string;

  /**
   * Override the backend origin used for REST. Defaults to
   * {@link NETWORK_TO_BACKEND_ORIGIN}`[network]` resolved at init time.
   */
  readonly backendOrigin?: string;
}
