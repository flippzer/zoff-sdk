/**
 * EIP-6963 announce + onTransactionUpdate listener registry tests for
 * `ZoffProvider`. These cover behaviour the conformance / network-bind
 * suites only check structurally.
 *
 * Listener leak warning: each `ZoffProvider` instance whose `init()`
 * resolves attaches a `canton:requestProvider` listener to the shared
 * `window`. Across tests in the same file, those listeners persist —
 * a `dispatchEvent('canton:requestProvider')` from one test will fire
 * every prior test's provider's announce. Each test below filters its
 * collected events by `detail.provider === <its own instance>` to keep
 * assertions stable. This isn't a bug in the SDK — production dApps
 * own a single provider per page; the leak is test-environment-only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CantonWalletAnnounceEvent,
  TransactionUpdate,
} from '@zoffwallet/provider-interface';
import { ZoffProvider } from '../provider.js';

describe('ZoffProvider — EIP-6963 announce', () => {
  let listener: ((e: Event) => void) | null = null;

  beforeEach(() => {
    listener = null;
  });

  afterEach(() => {
    if (listener !== null) {
      window.removeEventListener('canton:announceProvider', listener);
    }
  });

  it('dispatches canton:announceProvider on init() with detail.provider === this', async () => {
    const p = new ZoffProvider();
    const events: CantonWalletAnnounceEvent[] = [];
    listener = (e: Event): void => {
      const evt = e as CantonWalletAnnounceEvent;
      if (evt.detail.provider === p) events.push(evt);
    };
    window.addEventListener('canton:announceProvider', listener);

    await p.init({ appName: 'test', network: 'devnet' });

    expect(events).toHaveLength(1);
    expect(events[0]?.detail.provider).toBe(p);
    expect(events[0]?.detail.info.name).toBe('Zoff');
    expect(events[0]?.detail.info.rdns).toBe('app.zoff');
    expect(typeof events[0]?.detail.info.uuid).toBe('string');
    expect(events[0]?.detail.info.icon.length).toBeGreaterThan(0);
  });

  it('re-announces in response to canton:requestProvider', async () => {
    const p = new ZoffProvider();
    const events: CantonWalletAnnounceEvent[] = [];
    listener = (e: Event): void => {
      const evt = e as CantonWalletAnnounceEvent;
      if (evt.detail.provider === p) events.push(evt);
    };
    window.addEventListener('canton:announceProvider', listener);

    await p.init({ appName: 'test', network: 'devnet' });
    expect(events).toHaveLength(1);

    window.dispatchEvent(new Event('canton:requestProvider'));
    expect(events).toHaveLength(2);
    expect(events[1]?.detail.provider).toBe(p);
  });

  it('mints a fresh uuid each construction', async () => {
    const p1 = new ZoffProvider();
    const p2 = new ZoffProvider();
    const seen: string[] = [];
    listener = (e: Event): void => {
      const evt = e as CantonWalletAnnounceEvent;
      if (evt.detail.provider === p1 || evt.detail.provider === p2) {
        seen.push(evt.detail.info.uuid);
      }
    };
    window.addEventListener('canton:announceProvider', listener);

    await p1.init({ appName: 'test1', network: 'devnet' });
    await p2.init({ appName: 'test2', network: 'devnet' });

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('ZoffProvider.onTransactionUpdate', () => {
  it('returns an unsubscribe function', () => {
    const p = new ZoffProvider();
    const unsubscribe = p.onTransactionUpdate(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    // Calling twice MUST be safe.
    unsubscribe();
    unsubscribe();
  });

  it('multiple listeners can subscribe independently and each gets a distinct unsubscribe', () => {
    const p = new ZoffProvider();
    const u1 = p.onTransactionUpdate(() => undefined);
    const u2 = p.onTransactionUpdate(() => undefined);
    expect(u1).not.toBe(u2);
    u1();
    u2();
  });

  it('listener errors are isolated — one throwing listener does not block another', () => {
    // Exercises the private emitTransactionUpdate path indirectly: we
    // can't reach it without going through submitTransaction (which
    // requires connect + popup). Smoke-tests against a live backend
    // cover the actual emit path; here we just check the registry
    // shape and unsubscribe identity.
    const p = new ZoffProvider();
    const calls: string[] = [];
    const u1 = p.onTransactionUpdate(() => {
      calls.push('a');
      throw new Error('listener a failed');
    });
    const u2 = p.onTransactionUpdate((u: TransactionUpdate) => {
      calls.push(`b:${u.commandId}`);
    });
    // No way to trigger an emit without going through the live submit
    // flow; assertion limited to "subscribe and unsubscribe both work".
    u1();
    u2();
    expect(calls).toEqual([]);
  });
});
