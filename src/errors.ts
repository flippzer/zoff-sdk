/**
 * Error helpers for `@zoffwallet/sdk`.
 *
 * Every error a `ZoffProvider` method throws is a {@link WalletError} per
 * the `@zoffwallet/provider-interface` contract. Callers discriminate on
 * `code`, never on `message`.
 */
import type { WalletError, WalletErrorCode } from '@zoffwallet/provider-interface';

export class ZoffWalletError extends Error implements WalletError {
  readonly code: WalletErrorCode;
  override readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WalletErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = 'ZoffWalletError';
    this.code = code;
    this.message = message;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function walletError(
  code: WalletErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>
): ZoffWalletError {
  return new ZoffWalletError(code, message, details);
}
