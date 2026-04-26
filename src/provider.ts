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
 *      └──▶ popup ─────▶ devnet.zoff.app/sdk/{connect,sign}
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
 * | `connect`                       | shipped — cross-origin popup at `/sdk/connect`, requires the wallet-side page (pending in canton-wallet) |
 * | `getActiveContracts`            | shipped — HTTPS to `POST /sdk/active-contracts` |
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
import {
  openConnectPopup,
  openSignMessagePopup,
  openSignPopup,
} from './transport/popup.js';
import {
  createAutoApproveWindow,
  type TestingTransportConfig,
} from './transport/testing.js';

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
  private readonly transactionListeners = new Set<
    (update: TransactionUpdate) => void
  >();
  private testingTransport: TestingTransportConfig | null = null;
  private testWindow: Window | null = null;

  constructor(private readonly options: ZoffProviderOptions = {}) {}

  /**
   * Construct a `ZoffProvider` whose popup-approval transport is
   * stubbed by an in-memory auto-approve fake. Every `connect()`,
   * `submitTransaction()`, `submitAndWaitForTransaction()`, and
   * `signMessage()` call resolves deterministically without opening a
   * real popup or prompting the user.
   *
   * Intended for CI smoke tests that exercise the SDK end-to-end —
   * popup transport, cross-origin handshake, listener registry, error
   * surface — without a human in the loop. Pairs with a fixture
   * `CantonWalletProvider` impl on the dApp side: the fixture-provider
   * smoke validates wiring shape, this validates wallet transport.
   *
   * The HTTPS routes (`/sdk/holdings`, `/sdk/build-transfer-commands`,
   * `/sdk/active-contracts`) are NOT mocked — they still hit whatever
   * `backendOrigin` resolves to. Mock those at the `fetch` level if you
   * want full isolation.
   *
   * SAFETY: any `ZoffProvider` returned by this method silently bypasses
   * user consent. Do NOT use in production code paths. The factory
   * deliberately has a name that's easy to grep for in a publish
   * checklist.
   */
  static withTestingTransport(
    config: TestingTransportConfig,
    options?: ZoffProviderOptions
  ): ZoffProvider {
    const provider = new ZoffProvider(options);
    provider.testingTransport = config;
    return provider;
  }

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

    if (this.testingTransport !== null) {
      this.testWindow = createAutoApproveWindow(
        this.testingTransport,
        walletOrigin,
        config.network
      );
    }

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
      ...(this.testWindow !== null ? { windowImpl: this.testWindow } : {}),
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

  /**
   * Query the connected party's active contracts, filtered by interface
   * id or template id. At least one filter MUST be provided — the
   * canonical contract says "implementation-defined" when neither is
   * passed; we choose `INVALID_COMMAND` to avoid full-ACS dumps.
   *
   * `interfaceId` takes precedence over `templateId` when both are
   * provided — interface filters are semantically the more specific
   * choice (a template-id query against an Interface implementer would
   * miss alternative implementations of the same interface).
   */
  async getActiveContracts(filter: {
    readonly interfaceId?: string;
    readonly templateId?: string;
  }): Promise<readonly Contract[]> {
    this.assertConnected();
    if (this.httpClient === null || this._partyId === null) {
      throw walletError(
        'NOT_CONNECTED',
        'HTTP client or partyId not initialized'
      );
    }
    if (
      (filter.interfaceId === undefined || filter.interfaceId === '') &&
      (filter.templateId === undefined || filter.templateId === '')
    ) {
      throw walletError(
        'INVALID_COMMAND',
        'getActiveContracts requires either interfaceId or templateId'
      );
    }

    return this.httpClient.post<readonly Contract[]>('/sdk/active-contracts', {
      partyId: this._partyId,
      ...(filter.interfaceId !== undefined && filter.interfaceId !== ''
        ? { interfaceId: filter.interfaceId }
        : {}),
      ...(filter.templateId !== undefined && filter.templateId !== ''
        ? { templateId: filter.templateId }
        : {}),
    });
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

  /**
   * Submit a set of commands and resolve only after the resulting
   * transaction has been observed on the ledger. Opens the wallet's
   * `/sdk/sign` approval popup; the popup runs the auth handshake,
   * calls `/tx/prepare` + `/tx/execute`, signs locally, and posts back
   * `{transactionId, completionOffset}`.
   *
   * v0.1.0 semantics: in our backend `/tx/execute` only returns once the
   * participant has prepared + executed the transaction, which is
   * effectively committed-on-synchronizer for our purposes. A future
   * version may swap this for an explicit submit-and-wait endpoint that
   * polls `/v2/updates/flats` for the completion offset before
   * resolving.
   *
   * `opts.mode` is ignored per the canonical contract — this method
   * always behaves as `WAIT`. Callers wanting fire-and-forget should
   * use {@link submitTransaction}.
   */
  async submitAndWaitForTransaction(opts: SubmitOptions): Promise<SubmitResult> {
    this.assertConnected();
    if (opts.commands.length === 0) {
      throw walletError(
        'INVALID_COMMAND',
        'SubmitOptions.commands must be non-empty'
      );
    }

    const popupResult = await this.runSubmitPopup(opts);

    const result: SubmitResult =
      popupResult.completionOffset !== undefined
        ? {
            updateId: popupResult.transactionId,
            completionOffset: String(popupResult.completionOffset),
          }
        : { updateId: popupResult.transactionId };

    return result;
  }

  /**
   * Submit a transaction and resolve as soon as the validator accepts
   * it; the eventual outcome is delivered to listeners registered via
   * {@link onTransactionUpdate}. v0.1.0 fires a synthetic `COMMITTED`
   * event immediately after the submit popup resolves, since our
   * backend's `/tx/execute` semantics are effectively committed-by-
   * the-time-it-returns. v0.2.0 will distinguish the two phases via a
   * capability-token-aware async update channel.
   */
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

    const popupResult = await this.runSubmitPopup(opts);
    const submissionId = popupResult.transactionId;

    // Synthetic COMMITTED notification — see method docstring.
    queueMicrotask(() => {
      const update: TransactionUpdate = {
        commandId: submissionId,
        submissionId,
        updateId: popupResult.transactionId,
        status: 'COMMITTED',
      };
      this.emitTransactionUpdate(update);
    });

    return { submissionId };
  }

  /**
   * Register a listener for asynchronous transaction updates. v0.1.0
   * only emits `COMMITTED` from {@link submitTransaction} synchronously
   * after `/tx/execute` resolves; future versions will deliver
   * `PENDING` and `FAILED` events as well. Returns an unsubscribe
   * function. Multiple listeners are supported; each receives every
   * update.
   */
  onTransactionUpdate(
    callback: (update: TransactionUpdate) => void
  ): () => void {
    this.transactionListeners.add(callback);
    return () => {
      this.transactionListeners.delete(callback);
    };
  }

  private emitTransactionUpdate(update: TransactionUpdate): void {
    for (const listener of this.transactionListeners) {
      try {
        listener(update);
      } catch {
        // Listener errors are isolated — never let a buggy listener
        // crash the SDK or other listeners.
      }
    }
  }

  /**
   * Shared driver for the `/sdk/sign` popup approval. Used by both
   * submit methods. Maps the canonical `SubmitOptions` to the
   * sub-shape `/tx/prepare` accepts (drops `deduplicationKey`, `memo`,
   * `packageIdSelectionPreference`, `synchronizerId`, `mode` — all
   * unsupported by the v0.1.0 backend transport; tracked for v0.2.0).
   */
  private async runSubmitPopup(
    opts: SubmitOptions
  ): Promise<{ transactionId: string; completionOffset?: number }> {
    if (
      this._walletOrigin === null ||
      this._appName === null ||
      this._partyId === null
    ) {
      throw walletError(
        'NOT_CONNECTED',
        'Provider state inconsistent — call connect() first.'
      );
    }

    const dappOrigin =
      typeof window !== 'undefined' ? window.location.origin : '';
    if (dappOrigin === '') {
      throw walletError(
        'INVALID_COMMAND',
        'Submit requires a browser environment with window.location.origin'
      );
    }

    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return openSignPopup({
      walletOrigin: this._walletOrigin,
      dappOrigin,
      dappName: this._appName,
      requestId,
      ...(this.testWindow !== null ? { windowImpl: this.testWindow } : {}),
      payload: {
        commands: opts.commands,
        actAs: opts.actAs,
        ...(opts.readAs !== undefined ? { readAs: opts.readAs } : {}),
        // DisclosedContract is structured-typed in the canonical interface;
        // the popup payload accepts the looser open-record shape so it can
        // forward arbitrary backend-shaped contracts. The runtime data is
        // identical — we just need to satisfy exactOptionalPropertyTypes.
        ...(opts.disclosedContracts !== undefined
          ? {
              disclosedContracts: opts.disclosedContracts as unknown as ReadonlyArray<
                Record<string, unknown>
              >,
            }
          : {}),
      },
    });
  }

  // --- Optional methods (shipped per Toiki 2026-04-27 commitment) ------

  /**
   * Sign an arbitrary UTF-8 message with the connected party's Ed25519
   * key, returning the hex-encoded signature. Opens the wallet's
   * `/sdk/sign-message` approval popup; the popup unlocks the keystore
   * locally with the user's password and signs in-page — no Canton
   * round-trip.
   *
   * dApps verify the returned signature against the `publicKey`
   * delivered by `connect()` (or queried via `getAccount()`).
   */
  async signMessage(
    message: string
  ): Promise<{ readonly signature: string }> {
    this.assertConnected();
    if (
      this._walletOrigin === null ||
      this._appName === null ||
      this._partyId === null
    ) {
      throw walletError(
        'NOT_CONNECTED',
        'Provider state inconsistent — call connect() first.'
      );
    }

    const dappOrigin =
      typeof window !== 'undefined' ? window.location.origin : '';
    if (dappOrigin === '') {
      throw walletError(
        'INVALID_COMMAND',
        'signMessage requires a browser environment with window.location.origin'
      );
    }

    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return openSignMessagePopup({
      walletOrigin: this._walletOrigin,
      dappOrigin,
      dappName: this._appName,
      requestId,
      message,
      ...(this.testWindow !== null ? { windowImpl: this.testWindow } : {}),
    });
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
