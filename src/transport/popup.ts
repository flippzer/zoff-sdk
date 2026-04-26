/**
 * Cross-origin popup transport for `@zoffwallet/sdk`.
 *
 * The dApp lives at e.g. `https://helvetswap.app`. The Zoff wallet's
 * approval pages live at `https://devnet.zoff.app/sdk/{connect,sign}`.
 * Cross-origin postMessage is the only safe channel between them.
 *
 * Hard rules enforced by every helper here:
 *
 *   1. The popup URL is built from `walletOrigin` resolved at provider
 *      init — never from the dApp's `window.location.origin`.
 *   2. Inbound `postMessage` events are rejected unless `event.origin`
 *      strictly equals `walletOrigin`. No wildcards, no startsWith
 *      checks.
 *   3. The outbound `targetOrigin` for any reply is locked to
 *      `walletOrigin`. We never post with `'*'`.
 *   4. Popup close before response → `WalletError { code: 'USER_REJECTED' }`.
 *      Browser blocked popup → same. Timeout → `TIMEOUT`. Malformed
 *      response → `VALIDATOR_ERROR`.
 *   5. Listeners + intervals + timers are cleaned up on every exit path
 *      to avoid leaking handlers across multiple connect() attempts.
 */
import type { SupportedNetwork } from '@zoffwallet/provider-interface';
import { walletError } from '../errors.js';

/** Default popup window dimensions. */
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 580;

/** Default approval timeout — 5 minutes mirrors the wallet's session lock. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Polling interval for popup-close detection. */
const CLOSE_POLL_MS = 500;

/** Canonical message types for the SDK ↔ wallet handshake. */
const CONNECT_RESPONSE_TYPE = 'zoff:sdk:connect:response' as const;

export interface OpenConnectPopupParams {
  /**
   * Wallet origin (no trailing slash). E.g. `https://devnet.zoff.app`.
   * Locked at SDK init from `NETWORK_TO_WALLET_ORIGIN[network]` or the
   * `ZoffProviderOptions.walletOrigin` override.
   */
  readonly walletOrigin: string;
  /**
   * The dApp's `window.location.origin` at the time of `connect()`.
   * Forwarded to the wallet so the approval page can render the
   * requesting origin in the UI and bind the resulting auth token.
   */
  readonly dappOrigin: string;
  /** dApp display name shown in the approval UI. From `init({appName})`. */
  readonly dappName: string;
  /** Optional dApp icon (data URI or HTTPS URL). */
  readonly dappIcon?: string;
  /** Network the dApp initialized against. Echoed back for sanity check. */
  readonly requestedNetwork: SupportedNetwork;
  /** Per-request id; round-trips through the wallet for log correlation. */
  readonly requestId: string;
  /** Override popup dimensions (rarely useful). */
  readonly width?: number;
  readonly height?: number;
  /** Override approval timeout. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Test override for `window` (jsdom in unit tests). */
  readonly windowImpl?: Window;
}

export interface PopupConnectResponse {
  readonly partyId: string;
  readonly publicKey: string;
  readonly displayName: string;
  readonly authToken: string;
  readonly network: SupportedNetwork;
}

/**
 * Open the wallet's `/sdk/connect` approval popup, await a
 * `zoff:sdk:connect:response` postMessage from `walletOrigin`, and
 * resolve with the connection result. See module docstring for the
 * cross-origin handling rules.
 */
export async function openConnectPopup(
  params: OpenConnectPopupParams
): Promise<PopupConnectResponse> {
  const win = params.windowImpl ?? window;

  const url = buildConnectUrl(params);
  const popup = openCenteredPopup(
    win,
    url,
    'zoff-sdk-connect',
    params.width ?? DEFAULT_WIDTH,
    params.height ?? DEFAULT_HEIGHT
  );
  if (popup === null) {
    throw walletError(
      'USER_REJECTED',
      'Popup was blocked by the browser. Allow popups for this site and try again.',
      { walletOrigin: params.walletOrigin }
    );
  }

  return await waitForConnectResponse(win, popup, params);
}

function buildConnectUrl(params: OpenConnectPopupParams): string {
  const search = new URLSearchParams({
    dappOrigin: params.dappOrigin,
    dappName: params.dappName,
    requestedNetwork: params.requestedNetwork,
    requestId: params.requestId,
  });
  if (params.dappIcon !== undefined) {
    search.set('dappIcon', params.dappIcon);
  }
  return `${params.walletOrigin}/sdk/connect?${search.toString()}`;
}

function openCenteredPopup(
  win: Window,
  url: string,
  name: string,
  width: number,
  height: number
): Window | null {
  const left = Math.round(win.screenX + (win.outerWidth - width) / 2);
  const top = Math.round(win.screenY + (win.outerHeight - height) / 2);
  const features = [
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
    'popup=true',
  ].join(',');
  return win.open(url, name, features);
}

interface RawConnectResponse {
  readonly type?: string;
  readonly approved?: boolean;
  readonly partyId?: string;
  readonly publicKey?: string;
  readonly displayName?: string;
  readonly authToken?: string;
  readonly network?: string;
  readonly error?: string;
}

function waitForConnectResponse(
  win: Window,
  popup: Window,
  params: OpenConnectPopupParams
): Promise<PopupConnectResponse> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<PopupConnectResponse>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      win.removeEventListener('message', onMessage);
      win.clearTimeout(timeoutHandle);
      win.clearInterval(closedPollHandle);
    };

    const settle = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      cb();
    };

    const onMessage = (event: MessageEvent): void => {
      // Strict origin check. Cross-origin postMessage may arrive from
      // anywhere — anything that isn't from the wallet origin we
      // resolved at init time is silently ignored.
      if (event.origin !== params.walletOrigin) return;

      const data = event.data as RawConnectResponse;
      if (typeof data !== 'object' || data === null) return;
      if (data.type !== CONNECT_RESPONSE_TYPE) return;

      if (data.approved !== true) {
        const reason = data.error ?? 'User rejected the connection';
        settle(() => reject(walletError('USER_REJECTED', reason)));
        return;
      }

      if (
        typeof data.partyId !== 'string' ||
        typeof data.publicKey !== 'string' ||
        typeof data.displayName !== 'string' ||
        typeof data.authToken !== 'string' ||
        typeof data.network !== 'string'
      ) {
        settle(() =>
          reject(
            walletError(
              'VALIDATOR_ERROR',
              'Wallet returned a malformed connect response',
              { received: data }
            )
          )
        );
        return;
      }

      settle(() =>
        resolve({
          partyId: data.partyId as string,
          publicKey: data.publicKey as string,
          displayName: data.displayName as string,
          authToken: data.authToken as string,
          network: data.network as SupportedNetwork,
        })
      );
    };

    const timeoutHandle = win.setTimeout(() => {
      settle(() => {
        try {
          popup.close();
        } catch {
          // Best-effort.
        }
        reject(
          walletError(
            'TIMEOUT',
            `Wallet connect approval timed out after ${timeoutMs}ms`,
            { timeoutMs }
          )
        );
      });
    }, timeoutMs);

    const closedPollHandle = win.setInterval(() => {
      if (popup.closed) {
        settle(() =>
          reject(
            walletError(
              'USER_REJECTED',
              'Popup was closed before approval'
            )
          )
        );
      }
    }, CLOSE_POLL_MS);

    win.addEventListener('message', onMessage);
  });
}
