/**
 * `ZoffProvider` — Zoff's reference implementation of the canonical
 * {@link CantonWalletProvider} from `@zoffwallet/provider-interface`.
 *
 * ## Architecture (v0.1.0)
 *
 *   dApp page (e.g. helvetswap.app)
 *      │
 *      │  npm install @zoffwallet/sdk
 *      ▼
 *   new ZoffProvider() ── init() ──▶ dispatches `canton:announceProvider`
 *      │
 *      ├──▶ HTTPS  ────▶ api.devnet.zoff.app
 *      │       /sdk/build-transfer-commands · /sdk/holdings/:partyId
 *      │       /sdk/active-contracts        · /tx/{prepare,execute}
 *      │       /auth/{challenge,verify}
 *      │
 *      └──▶ popup ─────▶ devnet.zoff.app/wallet/sdk/{connect,sign}
 *              auth handshake · prepared-tx approval · signature
 *
 * The provider is browser-only. Cross-origin postMessage is locked to
 * the resolved wallet origin and asserted on every inbound message.
 *
 * ## v0.1.0-rc.1 status (2026-04-27 — Day 1 of plan
 * `twinkly-imagining-pnueli`):
 *
 * | Method                          | Status |
 * |---------------------------------|--------|
 * | `init`                          | shipped — network bind + EIP-6963 announce |
 * | `disconnect` `isConnected` `partyId` `getAccount` | shipped |
 * | `prepareTransfer`               | shipped — HTTPS to `POST /sdk/build-transfer-commands` |
 * | `getHoldings`                   | shipped — HTTPS to `GET /sdk/holdings/:partyId` |
 * | `connect`                       | shipped — cross-origin popup at `/wallet/sdk/connect`, requires the wallet-side page (pending in canton-wallet) |
 * | `getActiveContracts`            | stub — `/sdk/active-contracts` pending (Day 2 follow-up) |
 * | `submitTransaction`             | stub — popup + `/tx/*` pending (Day 3-4) |
 * | `submitAndWaitForTransaction`   | stub — popup + `/tx/*` pending (Day 3-4) |
 * | `onTransactionUpdate`           | stub — listener registry pending (Day 4) |
 * | `signMessage`                   | stub — popup pending (Day 4) |
 *
 * Stubbed methods throw `WalletError { code: 'UNKNOWN', details: { method } }`.
 * Empty-`commands` calls to either submit method throw `INVALID_COMMAND`
 * before reaching the stub — the canonical contract requires that.
 */
import type {
  AccountInfo,
  CantonWalletAnnounceDetail,
  CantonWalletInfo,
  CantonWalletProvider,
  Contract,
  ConnectResult,
  Holding,
  InitConfig,
  PreparedTransfer,
  PrepareTransferPayload,
  SubmitOptions,
  SubmitResult,
  SupportedNetwork,
  TransactionUpdate,
} from '@zoffwallet/provider-interface';

import {
  NETWORK_TO_BACKEND_ORIGIN,
  NETWORK_TO_WALLET_ORIGIN,
  SUPPORTED_NETWORKS,
} from './config.js';
import type { ZoffProviderOptions } from './config.js';
import { walletError } from './errors.js';
import { HttpClient } from './transport/http.js';
import { openConnectPopup } from './transport/popup.js';

const WALLET_NAME = 'Zoff';
const WALLET_VERSION = '0.1.0';
const WALLET_RDNS = 'app.zoff';

// 1×1 orange square placeholder. Replaced with the real wallet icon
// before rc.1 publish (next session). Keeps the announce event shape
// well-formed in the meantime.
const WALLET_ICON_PLACEHOLDER =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PHJlY3Qgd2lkdGg9Ijk2IiBoZWlnaHQ9Ijk2IiBmaWxsPSIjRkZBNTAwIi8+PC9zdmc+';

const STUB_MESSAGE =
  'Method not yet implemented in this build of @zoffwallet/sdk — see plan twinkly-imagining-pnueli (v0.1.0-rc.1 target 2026-05-05).';

export class ZoffProvider implements CantonWalletProvider {
  readonly walletName = WALLET_NAME;
  readonly walletVersion = WALLET_VERSION;
  readonly supportedNetworks: readonly SupportedNetwork[] = SUPPORTED_NETWORKS;

  private initialized = false;
  private connected = false;
  private _network: SupportedNetwork | null = null;
  private _appName: string | null = null;
  private _partyId: string | null = null;
  private _authToken: string | null = null;
  private _walletOrigin: string | null = null;
  private _backendOrigin: string | null = null;
  private _requestProviderListener: (() => void) | null = null;
  private httpClient: HttpClient | null = null;

  constructor(private readonly options: ZoffProviderOptions = {}) {}

  // --- Identity --------------------------------------------------------

  get partyId(): string | null {
    return this._partyId;
  }

  // --- Lifecycle -------------------------------------------------------

  async init(config: InitConfig): Promise<void> {
    if (!SUPPORTED_NETWORKS.includes(config.network)) {
      throw walletError(
        'INVALID_COMMAND',
        `Unsupported network '${config.network}'. @zoffwallet/sdk v${WALLET_VERSION} supports: ${SUPPORTED_NETWORKS.join(', ')}.`,
        {
          requestedNetwork: config.network,
          supportedNetworks: SUPPORTED_NETWORKS,
        }
      );
    }

    const walletOrigin =
      this.options.walletOrigin ?? NETWORK_TO_WALLET_ORIGIN[config.network];
    const backendOrigin =
      this.options.backendOrigin ?? NETWORK_TO_BACKEND_ORIGIN[config.network];

    if (walletOrigin === undefined || backendOrigin === undefined) {
      // Belt-and-braces. The SUPPORTED_NETWORKS gate above should make
      // this unreachable — kept so future edits to the maps fail loudly
      // here instead of silently leaving the class with null origins.
      throw walletError(
        'INVALID_COMMAND',
        `No wallet/backend origin configured for network '${config.network}'`,
        { network: config.network }
      );
    }

    this._network = config.network;
    this._appName = config.appName;
    this._walletOrigin = walletOrigin;
    this._backendOrigin = backendOrigin;

    this.httpClient = new HttpClient({
      backendOrigin,
      authToken: () => this._authToken,
    });

    this.initialized = true;

    this.installAnnounceProvider();
  }

  async connect(): Promise<ConnectResult> {
    this.assertInitialized();

    // assertInitialized guarantees these are non-null, but TypeScript can't
    // narrow class-field types across a method call. Belt-and-braces.
    if (
      this._walletOrigin === null ||
      this._network === null ||
      this._appName === null
    ) {
      throw walletError(
        'INVALID_COMMAND',
        'Provider state inconsistent — call init() first.'
      );
    }

    const dappOrigin =
      typeof window !== 'undefined' ? window.location.origin : '';
    if (dappOrigin === '') {
      throw walletError(
        'INVALID_COMMAND',
        'connect() requires a browser environment with window.location.origin'
      );
    }

    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const response = await openConnectPopup({
      walletOrigin: this._walletOrigin,
      dappOrigin,
      dappName: this._appName,
      requestedNetwork: this._network,
      requestId,
    });

    // Network bind: the wallet MUST echo the network the SDK was
    // initialized with. Any mismatch is `INVALID_COMMAND` per the
    // canonical contract — the SDK and wallet are out of sync and we
    // refuse to mint a session against the wrong chain.
    if (response.network !== this._network) {
      throw walletError(
        'INVALID_COMMAND',
        `Wallet returned network '${response.network}' but provider was initialized with '${this._network}'.`,
        {
          requestedNetwork: this._network,
          walletNetwork: response.network,
        }
      );
    }

    this._partyId = response.partyId;
    this._authToken = response.authToken;
    this.connected = true;

    return {
      partyId: response.partyId,
      authToken: response.authToken,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this._partyId = null;
    this._authToken = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Queries ---------------------------------------------------------

  /**
   * Fetch the connected party's holdings from `GET /sdk/holdings/:partyId`.
   * The backend combines CC (decay-adjusted Amulet via UpdateStreamService)
   * and CIP-56 token (HoldingV1 via TokenStandardService) sources into the
   * canonical {@link Holding} shape.
   */
  async getHoldings(): Promise<readonly Holding[]> {
    this.assertConnected();
    if (this.httpClient === null || this._partyId === null) {
      throw walletError(
        'NOT_CONNECTED',
        'HTTP client or partyId not initialized'
      );
    }
    return this.httpClient.get<readonly Holding[]>(
      `/sdk/holdings/${encodeURIComponent(this._partyId)}`
    );
  }

  async getActiveContracts(_filter: {
    readonly interfaceId?: string;
    readonly templateId?: string;
  }): Promise<readonly Contract[]> {
    this.assertConnected();
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'getActiveContracts' });
  }

  // --- Transfer preparation -------------------------------------------

  /**
   * Build a `TransferInstructionV2` for the given payload by calling
   * `POST /sdk/build-transfer-commands` on the canton-wallet backend.
   * No popup is opened — the dApp inspects the resulting command set
   * and decides whether to forward to `submitAndWaitForTransaction` or
   * `submitTransaction` (where the popup approval happens).
   *
   * Mapping rules from canonical {@link PrepareTransferPayload} to the
   * backend body:
   *
   *   - `recipient` → `receiverPartyId`
   *   - `amount`    → `amount`
   *   - `memo`      → `memo` (omitted when undefined)
   *   - `instrument.instrumentId === 'Amulet'` →
   *      `symbol: 'CC'` (the backend's CC route reads `instrumentAdmin`
   *      from `CANTON_DSO_PARTY` env, so we don't forward it)
   *   - any other instrument →
   *      `symbol: instrument.instrumentId`,
   *      `instrumentAdmin: instrument.instrumentAdmin`
   *
   * `senderPartyId` is taken from `this._partyId` (set by `connect()`).
   */
  async prepareTransfer(
    payload: PrepareTransferPayload
  ): Promise<PreparedTransfer> {
    this.assertConnected();
    if (this.httpClient === null || this._partyId === null) {
      // Defensive: assertConnected requires both. Should be unreachable.
      throw walletError(
        'NOT_CONNECTED',
        'HTTP client or partyId not initialized'
      );
    }

    const isAmulet = payload.instrument.instrumentId === 'Amulet';
    const body: Record<string, string> = {
      senderPartyId: this._partyId,
      receiverPartyId: payload.recipient,
      amount: payload.amount,
    };
    if (payload.memo !== undefined) body['memo'] = payload.memo;
    if (isAmulet) {
      body['symbol'] = 'CC';
    } else {
      body['symbol'] = payload.instrument.instrumentId;
      body['instrumentAdmin'] = payload.instrument.instrumentAdmin;
    }

    return this.httpClient.post<PreparedTransfer>(
      '/sdk/build-transfer-commands',
      body
    );
  }

  // --- Submission ------------------------------------------------------

  async submitAndWaitForTransaction(opts: SubmitOptions): Promise<SubmitResult> {
    this.assertConnected();
    if (opts.commands.length === 0) {
      throw walletError(
        'INVALID_COMMAND',
        'SubmitOptions.commands must be non-empty'
      );
    }
    throw walletError('UNKNOWN', STUB_MESSAGE, {
      method: 'submitAndWaitForTransaction',
    });
  }

  async submitTransaction(
    opts: SubmitOptions
  ): Promise<{ readonly submissionId: string }> {
    this.assertConnected();
    if (opts.commands.length === 0) {
      throw walletError(
        'INVALID_COMMAND',
        'SubmitOptions.commands must be non-empty'
      );
    }
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'submitTransaction' });
  }

  onTransactionUpdate(_callback: (update: TransactionUpdate) => void): () => void {
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'onTransactionUpdate' });
  }

  // --- Optional methods (shipped per Toiki 2026-04-27 commitment) ------

  async signMessage(_message: string): Promise<{ readonly signature: string }> {
    this.assertConnected();
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'signMessage' });
  }

  async getAccount(): Promise<AccountInfo> {
    this.assertConnected();
    if (this._partyId === null || this._network === null) {
      throw walletError('NOT_CONNECTED', 'Provider is not connected');
    }
    return {
      partyId: this._partyId,
      network: this._network,
      walletName: WALLET_NAME,
    };
  }

  // --- EIP-6963 discovery ---------------------------------------------

  private installAnnounceProvider(): void {
    if (typeof window === 'undefined') return;

    const detail: CantonWalletAnnounceDetail = {
      info: this.walletInfo(),
      provider: this,
    };

    // Announce now, in case the dApp's listener registered before init
    // resolved.
    window.dispatchEvent(
      new CustomEvent('canton:announceProvider', { detail })
    );

    // Re-announce on demand. Idempotent across init() calls — listener
    // is installed exactly once per provider instance.
    if (this._requestProviderListener === null) {
      this._requestProviderListener = (): void => {
        window.dispatchEvent(
          new CustomEvent('canton:announceProvider', { detail })
        );
      };
      window.addEventListener(
        'canton:requestProvider',
        this._requestProviderListener
      );
    }
  }

  private walletInfo(): CantonWalletInfo {
    return {
      name: WALLET_NAME,
      icon: WALLET_ICON_PLACEHOLDER,
      uuid:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      rdns: WALLET_RDNS,
    };
  }

  // --- Guards ----------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) {
      throw walletError(
        'INVALID_COMMAND',
        'Provider must be initialized before use — call init() first.'
      );
    }
  }

  private assertConnected(): void {
    this.assertInitialized();
    if (!this.connected) {
      throw walletError('NOT_CONNECTED', 'Provider is not connected');
    }
  }
}
