import { describe, expect, it } from 'vitest';
import { ZoffProvider } from '../provider.js';
import type { TransactionUpdate } from '@zoffwallet/provider-interface';

/**
 * `onTransactionUpdate` is emitted internally by `submitTransaction`. The
 * registry itself is the unit under test here — we exercise it directly via
 * a private-cast `emitTransactionUpdate` call so we can verify multi-listener
 * dispatch, unsubscribe, and isolated error handling without standing up
 * the full popup transport.
 */
type ProviderInternals = {
  emitTransactionUpdate: (u: TransactionUpdate) => void;
};

const sampleUpdate: TransactionUpdate = {
  commandId: 'c1',
  submissionId: 's1',
  updateId: 'u1',
  status: 'COMMITTED',
};

describe('ZoffProvider.onTransactionUpdate — listener registry', () => {
  it('dispatches each emitted update to every registered listener', () => {
    const provider = new ZoffProvider();
    const a: TransactionUpdate[] = [];
    const b: TransactionUpdate[] = [];
    provider.onTransactionUpdate((u) => a.push(u));
    provider.onTransactionUpdate((u) => b.push(u));

    (provider as unknown as ProviderInternals).emitTransactionUpdate(sampleUpdate);

    expect(a).toEqual([sampleUpdate]);
    expect(b).toEqual([sampleUpdate]);
  });

  it('the returned unsubscribe function removes only that listener', () => {
    const provider = new ZoffProvider();
    const a: TransactionUpdate[] = [];
    const b: TransactionUpdate[] = [];
    const unsubA = provider.onTransactionUpdate((u) => a.push(u));
    provider.onTransactionUpdate((u) => b.push(u));
    unsubA();

    (provider as unknown as ProviderInternals).emitTransactionUpdate(sampleUpdate);

    expect(a).toEqual([]);
    expect(b).toEqual([sampleUpdate]);
  });

  it('isolates listener errors — a throw in one listener does not block others', () => {
    const provider = new ZoffProvider();
    const survived: TransactionUpdate[] = [];

    provider.onTransactionUpdate(() => {
      throw new Error('boom');
    });
    provider.onTransactionUpdate((u) => survived.push(u));

    expect(() =>
      (provider as unknown as ProviderInternals).emitTransactionUpdate(sampleUpdate)
    ).not.toThrow();
    expect(survived).toEqual([sampleUpdate]);
  });

  it('unsubscribe is idempotent', () => {
    const provider = new ZoffProvider();
    const seen: TransactionUpdate[] = [];
    const unsub = provider.onTransactionUpdate((u) => seen.push(u));
    unsub();
    expect(() => unsub()).not.toThrow();

    (provider as unknown as ProviderInternals).emitTransactionUpdate(sampleUpdate);
    expect(seen).toEqual([]);
  });
});
