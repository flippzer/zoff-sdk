/**
 * Testing transport for `@zoffwallet/sdk`.
 *
 * Synthesises a fake `Window` impl that drives the popup-approval handshake
 * to a deterministic outcome without opening a real popup, prompting the
 * user, or unlocking a keystore. Used by {@link ZoffProvider.withTestingTransport}.
 *
 * Use this for CI smokes that exercise the SDK end-to-end (popup transport
 * + cross-origin handshake + listener registry + error-code surface) without
 * a human in the loop. The HTTPS routes (`/sdk/holdings`,
 * `/sdk/build-transfer-commands`, `/sdk/active-contracts`) are NOT mocked
 * by this transport — they still hit whatever `backendOrigin` is configured.
 * Mock those at the `fetch` level if you want full isolation.
 *
 * Hard rule: this module MUST NOT be imported on a production code path.
 * It produces always-approved responses; shipping it in front of a real
 * wallet would silently bypass user consent. The
 * {@link ZoffProvider.withTestingTransport} factory is the only intended
 * entry point — name-grep your bundle for that string before publishing if
 * you're paranoid.
 */
import type { SupportedNetwork } from '@zoffwallet/provider-interface';

/**
 * Configuration for {@link ZoffProvider.withTestingTransport}.
 *
 * Every fixture field is optional with a deterministic default; pass only
 * the ones your test needs to assert on. `autoApprove: true` is required
 * and is the only currently-supported mode (a future
 * `autoApprove: 'reject'` mode for negative-path tests is tracked for
 * v0.2.0).
 */
export interface TestingTransportConfig {
  readonly autoApprove: true;
  /** What the connect popup posts back. */
  readonly party?: {
    readonly partyId?: string;
    readonly publicKey?: string;
    readonly displayName?: string;
    readonly authToken?: string;
  };
  /** What the sign popup posts back from `submit*` flows. */
  readonly submit?: {
    readonly transactionId?: string;
    readonly completionOffset?: number;
  };
  /** What the sign-message popup posts back. */
  readonly sign?: {
    readonly signature?: string;
  };
}

/** Default fixtures used when {@link TestingTransportConfig} omits a field. */
const DEFAULT_PARTY = {
  partyId:
    'TestParty::1220000000000000000000000000000000000000000000000000000000000000test',
  publicKey: '00'.repeat(32),
  displayName: 'Test Party',
  authToken: 'test-auth-token',
} as const;

const DEFAULT_SUBMIT = {
  transactionId: 'test-transaction-id',
  completionOffset: 1,
} as const;

const DEFAULT_SIGN = {
  signature: '00'.repeat(64),
} as const;

interface FakePopup {
  closed: boolean;
  close: () => void;
  postMessage: (data: unknown, targetOrigin: string) => void;
}

/**
 * Build a fake `Window` impl that auto-resolves every Zoff SDK popup
 * approval to {@link TestingTransportConfig}'s configured outcome.
 *
 * The shape mirrors what the popup transport in `popup.ts` actually
 * touches on the `Window` it's handed:
 *   - `open(url, name, features)` returns a fake popup
 *   - `addEventListener('message', listener)` registers the SDK's response handler
 *   - `removeEventListener('message', listener)` unregisters
 *   - `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` for the
 *     popup-close-detection + approval-timeout machinery
 *   - `screenX`, `screenY`, `outerWidth`, `outerHeight` for popup positioning math
 *
 * The returned `Window` does NOT support arbitrary other APIs — only the
 * subset the SDK's popup helpers use.
 *
 * Approval-handshake choreography per popup type:
 *   - `/sdk/connect` → on `open()`, queue a microtask that dispatches a
 *     `zoff:sdk:connect:response` to the SDK's message listener. One-shot.
 *   - `/sdk/sign` → on `open()`, dispatch `zoff:sdk:sign:ready`. The SDK's
 *     handler responds via `popup.postMessage(...:request)`; the fake popup's
 *     `postMessage` then dispatches `zoff:sdk:sign:response`.
 *   - `/sdk/sign-message` → same bidirectional shape as `/sdk/sign`.
 *
 * `walletOrigin` is set on every dispatched event's `origin` so the SDK's
 * strict origin allowlist accepts them. Test code that relies on the
 * allowlist being enforced (e.g. `popup.origin.test.ts`) should NOT use
 * this transport.
 */
export function createAutoApproveWindow(
  config: TestingTransportConfig,
  walletOrigin: string,
  network: SupportedNetwork
): Window {
  const messageListeners: Array<(e: MessageEvent) => void> = [];

  const dispatch = (data: unknown): void => {
    const event = { origin: walletOrigin, data } as MessageEvent;
    for (const listener of [...messageListeners]) listener(event);
  };

  const partyFixture = { ...DEFAULT_PARTY, ...(config.party ?? {}) };
  const submitFixture = { ...DEFAULT_SUBMIT, ...(config.submit ?? {}) };
  const signFixture = { ...DEFAULT_SIGN, ...(config.sign ?? {}) };

  const buildFakePopup = (popupType: 'connect' | 'sign' | 'sign-message'): FakePopup => {
    const popup: FakePopup = {
      closed: false,
      close: (): void => {
        popup.closed = true;
      },
      postMessage: (data: unknown): void => {
        // Bidirectional handshake half: the SDK pushed a request, mint the response.
        if (typeof data !== 'object' || data === null) return;
        const type = (data as { type?: string }).type;
        if (popupType === 'sign' && type === 'zoff:sdk:sign:request') {
          queueMicrotask(() =>
            dispatch({
              type: 'zoff:sdk:sign:response',
              approved: true,
              transactionId: submitFixture.transactionId,
              completionOffset: submitFixture.completionOffset,
            })
          );
        } else if (
          popupType === 'sign-message' &&
          type === 'zoff:sdk:sign-message:request'
        ) {
          queueMicrotask(() =>
            dispatch({
              type: 'zoff:sdk:sign-message:response',
              approved: true,
              signature: signFixture.signature,
            })
          );
        }
      },
    };
    return popup;
  };

  const win = {
    screenX: 0,
    screenY: 0,
    outerWidth: 1024,
    outerHeight: 768,
    open: (url: string): FakePopup => {
      const popupType = parsePopupType(url);
      const popup = buildFakePopup(popupType);
      // Fire the initial event(s) once the SDK's listener is registered.
      // The SDK calls win.open() *before* attaching the listener, so we
      // queue a microtask which gives the SDK time to addEventListener.
      queueMicrotask(() => {
        if (popupType === 'connect') {
          dispatch({
            type: 'zoff:sdk:connect:response',
            approved: true,
            partyId: partyFixture.partyId,
            publicKey: partyFixture.publicKey,
            displayName: partyFixture.displayName,
            authToken: partyFixture.authToken,
            network,
          });
        } else if (popupType === 'sign') {
          dispatch({ type: 'zoff:sdk:sign:ready' });
        } else if (popupType === 'sign-message') {
          dispatch({ type: 'zoff:sdk:sign-message:ready' });
        }
      });
      return popup;
    },
    addEventListener: (type: string, listener: EventListener): void => {
      if (type === 'message') {
        messageListeners.push(listener as (e: MessageEvent) => void);
      }
    },
    removeEventListener: (type: string, listener: EventListener): void => {
      if (type === 'message') {
        const i = messageListeners.indexOf(listener as (e: MessageEvent) => void);
        if (i !== -1) messageListeners.splice(i, 1);
      }
    },
    // Real-platform timers — happy-dom + Node both expose setTimeout etc.
    // on globalThis. We just forward. The cast-via-unknown is a Node vs
    // DOM Timer-handle type difference; the runtime call is identical.
    setTimeout: setTimeout as unknown as Window['setTimeout'],
    clearTimeout: clearTimeout as unknown as Window['clearTimeout'],
    setInterval: setInterval as unknown as Window['setInterval'],
    clearInterval: clearInterval as unknown as Window['clearInterval'],
  };

  return win as unknown as Window;
}

function parsePopupType(url: string): 'connect' | 'sign' | 'sign-message' {
  if (url.includes('/sdk/sign-message')) return 'sign-message';
  if (url.includes('/sdk/sign')) return 'sign';
  return 'connect';
}
