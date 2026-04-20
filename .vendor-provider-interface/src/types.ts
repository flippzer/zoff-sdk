/**
 * Canonical types for the Canton wallet provider contract.
 *
 * All field names are strict camelCase. There are no multi-shape fallbacks,
 * no snake_case aliases, and no optional escape hatches for fields that must
 * be present for an operation to succeed. The interface defines what is
 * correct; implementations enforce it.
 */

/**
 * A holding of a fungible instrument owned by the connected party.
 *
 * `amount` is a decimal string (not a number) to preserve precision across
 * the full range of instrument decimals. `decimals` expresses the
 * denomination: for an instrument with `decimals: 10`, an `amount` of
 * `"1.23"` has the same meaning as the ledger-integer `12300000000`.
 *
 * No aliasing is performed at the wallet layer — if the instrument is
 * Amulet, `instrumentId` is `Amulet`, not a dApp-specific display alias.
 */
export interface Holding {
  readonly contractId: string;
  readonly instrumentAdmin: string;
  readonly instrumentId: string;
  readonly amount: string;
  readonly decimals: number;
  readonly lockedAmount?: string;
  readonly owner: string;
  readonly observers?: readonly string[];
}

/**
 * A disclosed contract supplied alongside a prepared or submitted command.
 *
 * Used when a command depends on contracts the submitter is not a
 * stakeholder on — the typical case for Splice TransferInstructionV2
 * flows, which reference instrument-admin contracts owned by the token
 * issuer. `createdEventBlob` is the opaque ledger-API disclosure payload.
 */
export interface DisclosedContract {
  readonly contractId: string;
  readonly templateId: string;
  readonly createdEventBlob: string;
  readonly synchronizerId?: string;
}

/**
 * An opaque ledger-API command.
 *
 * The wallet does not inspect, parse, or rewrite command contents — it
 * forwards them verbatim to the validator. The concrete shape
 * (CreateCommand, ExerciseCommand, ExerciseByKeyCommand,
 * CreateAndExerciseCommand) is defined by the Canton ledger-API and
 * evolves across Canton versions. Pinning it in this interface would
 * couple every wallet implementation to a specific ledger-API version;
 * leaving it opaque decouples the interface from that churn.
 *
 * dApps that want typed commands should narrow at the call site using
 * types from their own Canton SDK.
 */
export type Command = Readonly<Record<string, unknown>>;

/**
 * Input payload for `prepareTransfer`.
 *
 * `memo` is passed byte-for-byte into the resulting TransferInstructionV2's
 * `meta` field. Its contents are not parsed, validated, or normalized by
 * the wallet — any structure is the dApp's responsibility.
 */
export interface PrepareTransferPayload {
  readonly recipient: string;
  readonly amount: string;
  readonly instrument: {
    readonly instrumentAdmin: string;
    readonly instrumentId: string;
  };
  readonly memo?: string;
  readonly requestedAt?: string;
  readonly executeBefore?: string;
}

/**
 * Canonical output of `prepareTransfer`.
 *
 * Every field is top-level. There is no `payload.commands`, no
 * `extra_args.disclosed_contracts`, no snake_case alias. Consumers can
 * pass this object's fields straight into `submitTransaction` or
 * `submitAndWaitForTransaction`.
 */
export interface PreparedTransfer {
  readonly commands: readonly Command[];
  readonly disclosedContracts: readonly DisclosedContract[];
  readonly packageIdSelectionPreference?: readonly string[];
  readonly synchronizerId: string;
  readonly actAs: string | readonly string[];
  readonly readAs?: string | readonly string[];
}

/**
 * Submission mode.
 *
 * - `WAIT` — resolve only after the transaction commits on the synchronizer.
 *   The default for `submitAndWaitForTransaction`.
 * - `ASYNC` — resolve as soon as the validator accepts the submission.
 *   The default for `submitTransaction`. Final outcome arrives via
 *   `onTransactionUpdate`.
 */
export type SubmitMode = 'WAIT' | 'ASYNC';

/**
 * Options for `submitTransaction` and `submitAndWaitForTransaction`.
 *
 * Fields mirror `PreparedTransfer` so that a `PreparedTransfer` can be
 * forwarded directly. `deduplicationKey` and `memo` are optional extras
 * that `prepareTransfer` does not produce.
 */
export interface SubmitOptions {
  /**
   * An empty commands array MUST cause the implementation to throw
   * `WalletError { code: 'INVALID_COMMAND' }`.
   */
  readonly commands: readonly Command[];
  readonly actAs: string | readonly string[];
  readonly readAs?: string | readonly string[];
  readonly deduplicationKey?: string;
  readonly memo?: string;
  readonly disclosedContracts?: readonly DisclosedContract[];
  readonly packageIdSelectionPreference?: readonly string[];
  readonly synchronizerId?: string;
  readonly mode?: SubmitMode;
}

/**
 * Result of a successful `submitAndWaitForTransaction` call.
 *
 * `events` is intentionally typed as `readonly unknown[]`: the ledger-API
 * event shape evolves across Canton versions, and the wallet forwards it
 * without interpretation. Same rationale as {@link Command}.
 */
export interface SubmitResult {
  readonly updateId: string;
  readonly completionOffset?: string;
  readonly events?: readonly unknown[];
}

/**
 * Status of an in-flight transaction observed via `onTransactionUpdate`.
 */
export type TransactionStatus = 'PENDING' | 'COMMITTED' | 'FAILED';

/**
 * Asynchronous update for a previously-submitted transaction.
 *
 * Emitted by the wallet whenever the status of a tracked submission
 * changes. `commandId` and `submissionId` correlate the update back to
 * the originating `submitTransaction` call. `updateData` is the raw
 * ledger-API update payload when available — same opacity rationale as
 * {@link Command} and {@link SubmitResult.events}.
 */
export interface TransactionUpdate {
  readonly commandId: string;
  readonly submissionId: string;
  readonly updateId?: string;
  readonly updateData?: unknown;
  readonly status?: TransactionStatus;
  readonly error?: WalletError;
}

/**
 * A single active contract returned by `getActiveContracts`.
 *
 * `payload` is the raw ledger-API contract arguments, typed as `unknown`
 * because shapes vary per template and are defined outside the wallet.
 */
export interface Contract {
  readonly contractId: string;
  readonly templateId: string;
  readonly payload: unknown;
  readonly signatories?: readonly string[];
  readonly observers?: readonly string[];
}

/**
 * Networks a Canton wallet may support. Shared between
 * {@link InitConfig.network}, `CantonWalletProvider.supportedNetworks`,
 * and {@link AccountInfo.network} so the canonical-shape rule holds
 * end-to-end.
 */
export type SupportedNetwork = 'mainnet' | 'devnet' | 'testnet';

/**
 * Basic account info, for sanity checks and display.
 *
 * `network` is the network the provider was initialized against;
 * `walletName` matches `CantonWalletProvider.walletName`.
 *
 * `participantId` is optional. A wallet that has no multi-participant
 * awareness (single-participant deployment, or simply no surfaced notion
 * of participantId) is conformant when omitting the field entirely. Per
 * this package's `exactOptionalPropertyTypes` setting, conformant omission
 * means leaving the key out — not passing `participantId: undefined`.
 */
export interface AccountInfo {
  readonly partyId: string;
  readonly network: SupportedNetwork;
  readonly walletName: string;
  readonly participantId?: string;
}

/**
 * Typed error code. Callers discriminate on `code`, never on `message`.
 *
 * - `USER_REJECTED` — user explicitly declined in the wallet UI.
 * - `RATE_LIMITED` — validator or backend applied a rate limit.
 *   Implementations SHOULD populate `details.retryAfterMs` when known.
 *   Implementations MUST NOT apply their own client-side rate limiting
 *   in place of surfacing this error.
 * - `NOT_CONNECTED` — method called before `connect()` or after
 *   `disconnect()`.
 * - `TIMEOUT` — operation exceeded its configured or default timeout.
 * - `VALIDATOR_ERROR` — backend or ledger-API returned a failure.
 * - `INVALID_COMMAND` — payload was malformed or violated the interface
 *   contract (e.g. snake_case input, unknown network, required field
 *   missing).
 * - `UNKNOWN` — reserved for genuinely unclassified failures. SHOULD
 *   be rare.
 */
export type WalletErrorCode =
  | 'USER_REJECTED'
  | 'RATE_LIMITED'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'VALIDATOR_ERROR'
  | 'INVALID_COMMAND'
  | 'UNKNOWN';

/**
 * Canonical error contract. Every error thrown by a
 * {@link CantonWalletProvider} method MUST be a `WalletError`.
 */
export interface WalletError {
  readonly code: WalletErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
