import type {
  AccountInfo,
  Contract,
  Holding,
  PreparedTransfer,
  PrepareTransferPayload,
  SubmitOptions,
  SubmitResult,
  SupportedNetwork,
  TransactionUpdate,
} from './types.js';

/**
 * Initialization config passed to {@link CantonWalletProvider.init}.
 *
 * `appName` is surfaced in the wallet UI only. It has no other semantic
 * meaning: wallets MUST NOT gate capabilities, fees, or permissions on
 * this value.
 */
export interface InitConfig {
  readonly appName: string;
  readonly network: SupportedNetwork;
  /**
   * Provider-specific escape hatch for non-standard configuration.
   *
   * **Warning:** future versions may remove or restrict this field. dApps
   * that rely on it are coupling themselves to a specific wallet
   * implementation and accept the associated breakage risk.
   */
  readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * Result of {@link CantonWalletProvider.connect}.
 *
 * `authToken` is an opaque session token bound to the dApp origin. Its
 * format is wallet-specific; dApps treat it as an opaque bearer value.
 */
export interface ConnectResult {
  readonly partyId: string;
  readonly authToken: string;
}

/**
 * The canonical contract every Canton Network wallet implements so that
 * any Canton dApp can target a single interface instead of N
 * wallet-specific SDKs.
 *
 * Philosophy:
 * - One canonical shape per input and output. No multi-shape fallbacks.
 * - All field names are camelCase. snake_case inputs are
 *   `INVALID_COMMAND` errors, not silent normalizations.
 * - All errors are typed {@link WalletError} with a string-literal
 *   `code`. Callers never discriminate on `message`.
 * - `prepareTransfer` is a top-level method, never nested under a
 *   sub-object.
 * - Implementations MUST NOT apply hidden client-side rate limiting.
 *   If a backend needs throttling, surface it as `RATE_LIMITED` with
 *   `details.retryAfterMs`.
 */
export interface CantonWalletProvider {
  // --- Identity -----------------------------------------------------------

  /** Human-readable wallet identifier, stable across versions of the same wallet. */
  readonly walletName: string;
  /** Wallet implementation version. SemVer recommended. */
  readonly walletVersion: string;
  /** Networks this provider can be initialized against. */
  readonly supportedNetworks: readonly SupportedNetwork[];

  // --- Connection --------------------------------------------------------

  /**
   * Initialize the provider for use with a specific dApp and network.
   *
   * MUST be called exactly once before any other method. Calling twice
   * is implementation-defined; implementations MAY throw `INVALID_COMMAND`.
   *
   * Throws `WalletError { code: 'INVALID_COMMAND' }` if `network` is not
   * in {@link CantonWalletProvider.supportedNetworks}.
   */
  init(config: InitConfig): Promise<void>;

  /**
   * Prompt the user to connect the wallet. Returns the connected party's
   * id and a session token bound to the dApp origin.
   *
   * Throws `USER_REJECTED` if the user declines, `TIMEOUT` if no
   * response within the wallet's configured window.
   */
  connect(): Promise<ConnectResult>;

  /**
   * End the current session and revoke the auth token. Idempotent: calling
   * `disconnect` when not connected MUST resolve without throwing.
   */
  disconnect(): Promise<void>;

  /** Synchronous read of local connection state. No network call. */
  isConnected(): boolean;

  /**
   * Id of the currently-connected party, or `null` if disconnected.
   * Synchronous accessor — no network call.
   */
  readonly partyId: string | null;

  // --- Queries -----------------------------------------------------------

  /**
   * All holdings owned by the connected party, in canonical camelCase.
   * No dApp-specific aliasing is applied.
   */
  getHoldings(): Promise<readonly Holding[]>;

  /**
   * Query active contracts by interface id or template id.
   *
   * At least one of `interfaceId` or `templateId` SHOULD be provided;
   * passing neither is implementation-defined.
   *
   * `interfaceId` follows `#<package-name>:<module>:<entity>`.
   * `templateId` follows `<packageId>:<module>:<entity>`.
   */
  getActiveContracts(filter: {
    readonly interfaceId?: string;
    readonly templateId?: string;
  }): Promise<readonly Contract[]>;

  // --- Transfer preparation (critical path) ------------------------------

  /**
   * Prepare a TransferInstructionV2 for the given payload. Returns the
   * canonical {@link PreparedTransfer} shape that can be passed directly
   * to `submitTransaction` or `submitAndWaitForTransaction`.
   *
   * Contract guarantees:
   * - No client-side rate limiting. Consecutive calls MUST be supported
   *   without artificial throttle.
   * - `memo` is forwarded byte-for-byte into the resulting command's
   *   `meta`. Structure is not validated.
   *
   * Throws `VALIDATOR_ERROR` if the backend is unreachable,
   * `INVALID_COMMAND` if the payload is malformed.
   */
  prepareTransfer(payload: PrepareTransferPayload): Promise<PreparedTransfer>;

  // --- Submission --------------------------------------------------------

  /**
   * Submit a set of commands and resolve only once the resulting transaction
   * has been sequenced and observed on the ledger. Prompts the user for
   * signature.
   *
   * Note: `opts.mode` is ignored on this method. Behavior is always
   * equivalent to `SubmitMode.WAIT` regardless of what the caller passes.
   * Implementations MUST NOT short-circuit to a submit-and-return semantic
   * here. Callers that want fire-and-forget semantics should use
   * {@link CantonWalletProvider.submitTransaction} instead.
   *
   * A future major may narrow the parameter type to exclude `mode`; until
   * then the field is accepted for shape-compatibility with `SubmitOptions`
   * and silently ignored.
   *
   * Throws `USER_REJECTED`, `RATE_LIMITED` (with `details.retryAfterMs`
   * when known), `TIMEOUT`, or `VALIDATOR_ERROR`.
   */
  submitAndWaitForTransaction(opts: SubmitOptions): Promise<SubmitResult>;

  /**
   * Submit a transaction and resolve as soon as the validator accepts
   * it. The final outcome arrives via {@link onTransactionUpdate}.
   */
  submitTransaction(
    opts: SubmitOptions
  ): Promise<{ readonly submissionId: string }>;

  // --- Listener ----------------------------------------------------------

  /**
   * Register a listener for asynchronous transaction updates. Returns
   * an unsubscribe function. Multiple listeners are supported; each
   * receives every update.
   */
  onTransactionUpdate(callback: (update: TransactionUpdate) => void): () => void;

  // --- Optional ----------------------------------------------------------

  /**
   * Sign an arbitrary message with the connected party's key. Optional:
   * wallets MAY omit if they do not support arbitrary message signing.
   */
  signMessage?(message: string): Promise<{ readonly signature: string }>;

  /** Basic account info. Optional. */
  getAccount?(): Promise<AccountInfo>;
}
