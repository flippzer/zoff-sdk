/**
 * `ZoffProvider` — reference implementation of
 * {@link CantonWalletProvider} for Canton Network.
 *
 * ## Phase 2 status (2026-04-20)
 *
 * The class is interface-conformant at the type level. Methods that
 * require a gRPC submit path (`getHoldings`, `prepareTransfer`,
 * `submitTransaction`, `submitAndWaitForTransaction`, `onTransactionUpdate`)
 * throw a typed `UNKNOWN` `WalletError` and are tracked for Phase 3.
 *
 * Rationale: the contract validation smoke test (Helvetswap's
 * `SwapPoller` + `SwapTiProcessor`) runs via `daml script` against the
 * same DevNet, decoupling contract correctness from the SDK's wire
 * implementation. See `scripts/smoke-test.ts` + the delivery note for
 * the full story.
 *
 * Phase 3 swaps the stubs for a gRPC client built on `@grpc/grpc-js`
 * plus Daml protos compiled from the public `.proto` sources.
 */
import type {
  AccountInfo,
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

import { JwtMinter } from './auth.js';
import type { ZoffProviderConfig } from './config.js';
import { walletError } from './errors.js';

const WALLET_NAME = 'Zoff';
const WALLET_VERSION = '0.1.0';
const SUPPORTED_NETWORKS: readonly SupportedNetwork[] = ['devnet'];

const STUB_MESSAGE =
  'gRPC submit client not yet implemented — see zoff-sdk Phase 3 tracker';

export class ZoffProvider implements CantonWalletProvider {
  readonly walletName = WALLET_NAME;
  readonly walletVersion = WALLET_VERSION;
  readonly supportedNetworks = SUPPORTED_NETWORKS;

  private readonly jwt: JwtMinter;
  private initialized = false;
  private connected = false;
  private _network: SupportedNetwork | null = null;
  private _partyId: string | null = null;

  constructor(private readonly config: ZoffProviderConfig) {
    this.jwt = new JwtMinter(config.auth);
  }

  // --- Identity ----------------------------------------------------------

  get partyId(): string | null {
    return this._partyId;
  }

  // --- Lifecycle ---------------------------------------------------------

  async init(config: InitConfig): Promise<void> {
    if (!SUPPORTED_NETWORKS.includes(config.network)) {
      throw walletError(
        'INVALID_COMMAND',
        `Unsupported network '${config.network}'. ZoffProvider currently supports: ${SUPPORTED_NETWORKS.join(', ')}.`
      );
    }
    this.initialized = true;
    this._network = config.network;
  }

  async connect(): Promise<ConnectResult> {
    this.assertInitialized();
    const authToken = await this.jwt.getToken();
    this._partyId = this.config.partyId;
    this.connected = true;
    return { partyId: this.config.partyId, authToken };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this._partyId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // --- Queries (Phase 3) -------------------------------------------------

  async getHoldings(): Promise<readonly Holding[]> {
    this.assertConnected();
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'getHoldings' });
  }

  async getActiveContracts(_filter: {
    readonly interfaceId?: string;
    readonly templateId?: string;
  }): Promise<readonly Contract[]> {
    this.assertConnected();
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'getActiveContracts' });
  }

  // --- Transfer preparation (Phase 3) ------------------------------------

  async prepareTransfer(
    _payload: PrepareTransferPayload
  ): Promise<PreparedTransfer> {
    this.assertConnected();
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'prepareTransfer' });
  }

  // --- Submission (Phase 3) ----------------------------------------------

  async submitAndWaitForTransaction(opts: SubmitOptions): Promise<SubmitResult> {
    this.assertConnected();
    if (opts.commands.length === 0) {
      throw walletError('INVALID_COMMAND', 'SubmitOptions.commands must be non-empty');
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
      throw walletError('INVALID_COMMAND', 'SubmitOptions.commands must be non-empty');
    }
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'submitTransaction' });
  }

  onTransactionUpdate(_callback: (update: TransactionUpdate) => void): () => void {
    throw walletError('UNKNOWN', STUB_MESSAGE, { method: 'onTransactionUpdate' });
  }

  // --- Optional (implemented where cheap) --------------------------------

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

  // --- Guards ------------------------------------------------------------

  private assertInitialized(): void {
    if (!this.initialized) {
      throw walletError('INVALID_COMMAND', 'Provider must be initialized before use');
    }
  }

  private assertConnected(): void {
    this.assertInitialized();
    if (!this.connected) {
      throw walletError('NOT_CONNECTED', 'Provider is not connected');
    }
  }
}
