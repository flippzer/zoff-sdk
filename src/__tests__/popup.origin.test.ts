import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openConnectPopup,
  openSignMessagePopup,
  type OpenConnectPopupParams,
  type OpenSignMessagePopupParams,
} from '../transport/popup.js';

/**
 * happy-dom provides a real `window`, but `window.open` returns null without
 * a user gesture. We pass `windowImpl` as a thin shim that exposes the bits
 * the popup transport actually uses, plus a controllable `open` and an
 * event-emitting `dispatch`.
 */
function makeFakeWindow(opts: { popupClosed?: boolean } = {}): {
  win: Window;
  popup: { closed: boolean; close: () => void; postMessage: ReturnType<typeof vi.fn> };
  dispatch(origin: string, data: unknown): void;
  installedListeners: Array<(e: MessageEvent) => void>;
} {
  const installedListeners: Array<(e: MessageEvent) => void> = [];
  const popup = {
    closed: opts.popupClosed ?? false,
    close: vi.fn(() => {
      popup.closed = true;
    }),
    postMessage: vi.fn(),
  };
  const win = {
    screenX: 0,
    screenY: 0,
    outerWidth: 1024,
    outerHeight: 768,
    open: vi.fn(() => popup as unknown as Window),
    addEventListener: (type: string, listener: EventListener): void => {
      if (type === 'message') {
        installedListeners.push(listener as (e: MessageEvent) => void);
      }
    },
    removeEventListener: (type: string, listener: EventListener): void => {
      if (type === 'message') {
        const i = installedListeners.indexOf(
          listener as (e: MessageEvent) => void
        );
        if (i !== -1) installedListeners.splice(i, 1);
      }
    },
    setTimeout: ((cb: () => void, _ms: number) => setTimeout(cb, 999_999)) as Window['setTimeout'],
    clearTimeout: ((h: ReturnType<typeof setTimeout>) => clearTimeout(h)) as Window['clearTimeout'],
    setInterval: ((cb: () => void, _ms: number) => setInterval(cb, 999_999)) as Window['setInterval'],
    clearInterval: ((h: ReturnType<typeof setInterval>) => clearInterval(h)) as Window['clearInterval'],
  } as unknown as Window;

  const dispatch = (origin: string, data: unknown): void => {
    const event = { origin, data } as MessageEvent;
    for (const listener of [...installedListeners]) listener(event);
  };

  return { win, popup, dispatch, installedListeners };
}

const baseConnectParams = (
  walletOrigin: string
): OpenConnectPopupParams => ({
  walletOrigin,
  dappOrigin: 'https://dapp.test',
  dappName: 'test-dapp',
  requestedNetwork: 'devnet',
  requestId: 'req-1',
  timeoutMs: 60_000,
});

const baseSignMessageParams = (
  walletOrigin: string
): OpenSignMessagePopupParams => ({
  walletOrigin,
  dappOrigin: 'https://dapp.test',
  dappName: 'test-dapp',
  requestId: 'req-1',
  message: 'hello',
  timeoutMs: 60_000,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openConnectPopup — strict origin allowlist', () => {
  it('throws USER_REJECTED when window.open returns null (popup blocked)', async () => {
    const { win, popup } = makeFakeWindow();
    (win.open as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    await expect(
      openConnectPopup({ ...baseConnectParams('https://wallet.test'), windowImpl: win })
    ).rejects.toMatchObject({ code: 'USER_REJECTED' });
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it('ignores postMessage events from origins other than walletOrigin', async () => {
    const { win, dispatch, installedListeners } = makeFakeWindow();
    const params = { ...baseConnectParams('https://wallet.test'), windowImpl: win };

    const promise = openConnectPopup(params);

    expect(installedListeners.length).toBe(1);

    dispatch('https://evil.test', {
      type: 'zoff:sdk:connect:response',
      approved: true,
      partyId: 'p',
      publicKey: 'k',
      displayName: 'd',
      authToken: 't',
      network: 'devnet',
    });

    expect(installedListeners.length).toBe(1);

    dispatch('https://wallet.test', {
      type: 'zoff:sdk:connect:response',
      approved: true,
      partyId: 'p',
      publicKey: 'k',
      displayName: 'd',
      authToken: 't',
      network: 'devnet',
    });

    await expect(promise).resolves.toMatchObject({
      partyId: 'p',
      authToken: 't',
      network: 'devnet',
    });
  });

  it('rejects malformed responses from walletOrigin with VALIDATOR_ERROR', async () => {
    const { win, dispatch } = makeFakeWindow();
    const params = { ...baseConnectParams('https://wallet.test'), windowImpl: win };
    const promise = openConnectPopup(params);
    dispatch('https://wallet.test', {
      type: 'zoff:sdk:connect:response',
      approved: true,
      partyId: 'p',
    });
    await expect(promise).rejects.toMatchObject({ code: 'VALIDATOR_ERROR' });
  });

  it('translates approved=false to USER_REJECTED', async () => {
    const { win, dispatch } = makeFakeWindow();
    const params = { ...baseConnectParams('https://wallet.test'), windowImpl: win };
    const promise = openConnectPopup(params);
    dispatch('https://wallet.test', {
      type: 'zoff:sdk:connect:response',
      approved: false,
      error: 'user said no',
    });
    await expect(promise).rejects.toMatchObject({
      code: 'USER_REJECTED',
      message: 'user said no',
    });
  });
});

describe('openSignMessagePopup — strict origin allowlist + handshake', () => {
  it('only posts the request payload after a ready event from walletOrigin', async () => {
    const { win, popup, dispatch } = makeFakeWindow();
    const params = { ...baseSignMessageParams('https://wallet.test'), windowImpl: win };
    const promise = openSignMessagePopup(params);

    dispatch('https://evil.test', { type: 'zoff:sdk:sign-message:ready' });
    expect(popup.postMessage).not.toHaveBeenCalled();

    dispatch('https://wallet.test', { type: 'zoff:sdk:sign-message:ready' });
    expect(popup.postMessage).toHaveBeenCalledTimes(1);
    expect(popup.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'zoff:sdk:sign-message:request',
        payload: { message: 'hello' },
      }),
      'https://wallet.test'
    );

    dispatch('https://wallet.test', { type: 'zoff:sdk:sign-message:ready' });
    expect(popup.postMessage).toHaveBeenCalledTimes(1);

    dispatch('https://wallet.test', {
      type: 'zoff:sdk:sign-message:response',
      approved: true,
      signature: 'deadbeef',
    });
    await expect(promise).resolves.toEqual({ signature: 'deadbeef' });
  });
});
